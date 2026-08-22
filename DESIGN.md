# Design: A Personal Database-Oriented Operating System

*Status: draft for discussion. Nothing here is built yet; this document is the artifact to iterate on before any code exists.*

## 0. The core idea in one paragraph

One Neon Postgres database holds an append-only **event log** that is the sole source of truth. Everything else — current-state tables, the entity graph, schedules, search indexes — is a **projection**, rebuildable by replay. Around the log sit four kinds of programs that never talk to each other directly, only through the database: **connectors** (world → events), **agents** (events → LLM work → events), the **scheduler** (events → schedule-proposal events), and the **Electron app** (events → pixels; user actions → events). The whole system rests on five orthogonal abstractions: *events, projections, entities+links, event-driven workers (connectors and agents), and renderers*. Every feature in the vision — the daily curriculum, related-paper surfacing, topic memos, amorphous intent tracking — is expressed as new event types, projections, and workers, never as new core machinery.

Stack decisions already made: **TypeScript full-stack**, **Neon (serverless Postgres)** as the single database, **Electron** desktop frontend, **Claude API / Agent SDK** for background agents.

## 1. The three planes

A recurring failure mode of event-sourced systems is stuffing operational bookkeeping into the log until replay becomes meaningless. This design splits the database into three explicit planes:

| Plane | Contents | Durability contract |
|---|---|---|
| **Fact plane** | `events` table only | Append-only, sacred, replayable forever |
| **Derived plane** | Projection tables (`papers`, `people`, `schedule_blocks`, `embeddings`, …) | Truncate-and-replay at any time; written only by projection runners |
| **Operational plane** | `jobs`, `connector_state`, `projection_checkpoints`, `agent_runs`, `cost_ledger` | Disposable coordination state; losing it costs re-work, never facts |

Rule of thumb for "is X an event?": **would I want this fact when replaying in five years?** "User marked H-Net want-to-read" — yes. "The Gmail connector's sync cursor is now `historyId=88123`" — no; that's operational, and it's re-derivable anyway because each ingested email event carries its source position.

## 2. Event log

### 2.1 Schema

```sql
create table events (
  -- Ordering & identity
  seq             bigint generated always as identity primary key,
  event_uid       uuid not null default gen_random_uuid(),   -- stable external reference
  -- Classification
  type            text not null,          -- e.g. 'arxiv.paper.ingested'
  schema_version  smallint not null default 1,
  -- Provenance
  source          text not null,          -- 'connector:arxiv' | 'agent:related-papers'
                                          -- | 'ui:desktop' | 'scheduler' | 'system'
  source_run_id   uuid,                   -- agent_run / job id when applicable
  -- Time
  occurred_at     timestamptz not null,   -- when the fact happened in the world
  recorded_at     timestamptz not null default now(),  -- when we learned of it
  -- Content
  payload         jsonb not null,
  -- Idempotency for re-runnable connectors/agents
  idempotency_key text,
  -- Causality / corrections
  caused_by_uid   uuid,                   -- event that triggered this one
  corrects_uid    uuid,                   -- set on correction/retraction events

  constraint events_uid_unique  unique (event_uid),
  constraint events_idem_unique unique (idempotency_key)
);
create index events_type_seq    on events (type, seq);
create index events_occurred    on events (occurred_at);
create index events_payload_gin on events using gin (payload jsonb_path_ops);
```

**Ordering: bigint identity, not ULIDs.** ULIDs solve distributed ID generation, which we don't have — Postgres is the single serialization point. A monotone `seq` gives projections a trivially correct cursor (`where seq > $last order by seq`). ULIDs sort by wall clock and can interleave across writers; a bigint minted by the database cannot. `event_uid` exists so external references (agent citations, UI links, `corrects_uid`) never depend on `seq`, keeping the door open to log migration later.

**The one subtlety: commit-visibility gaps.** With concurrent writers, the row with seq 101 can become visible before seq 100 commits, and a cursor that already read past 100 skips it forever. At personal-system write rates the boring fix is to serialize all appends through a single SQL function:

```sql
create function append_events(batch jsonb) returns bigint as $$
begin
  perform pg_advisory_xact_lock(42);   -- single append gate; released at commit
  insert into events (type, schema_version, source, source_run_id, occurred_at,
                      payload, idempotency_key, caused_by_uid, corrects_uid)
  select ... from jsonb_array_elements(batch)
  on conflict (idempotency_key) do nothing;
  perform pg_notify('events', currval(pg_get_serial_sequence('events','seq'))::text);
  return currval(pg_get_serial_sequence('events','seq'));
end $$ language plpgsql;
```

All writers — Electron main, worker, everything — MUST append through this function via `@core/events`. Contention is irrelevant at this scale; correctness of the cursor invariant is permanent. `on conflict do nothing` on the idempotency key makes every connector and agent re-runnable for free.

### 2.2 Event type naming

`<domain>.<noun>.<verb-past-tense>`, domains namespaced by origin kind:

- **Connectors**: `arxiv.paper.ingested`, `gmail.message.ingested`, `gcal.event.ingested`, `imessage.message.ingested`, `twitter.tweet.ingested`
- **User actions**: `user.intent.created`, `user.intent.completed`, `user.interest.declared`, `user.annotation.added`, `user.session.started`, `user.session.ended`, `user.schedule.block_completed`, `user.schedule.block_dismissed`, `user.entity.merged`, `user.entity.split`
- **Agents**: `agent.link.asserted`, `agent.memo.created`, `agent.resource.surfaced`, `agent.question.generated`, `agent.intent.completion_detected`
- **Scheduler**: `schedule.day.proposed`, `scheduler.config.updated`
- **System**: `system.event.retracted`, `system.event.redacted`

### 2.3 Payload schemas and evolution

Payload shapes are **zod schemas in `@core/schema`**, keyed by `(type, schema_version)`. The registry is code, not database — payloads are validated at append time and parse time, and every package imports its payload types from this one place.

**Evolution rule: never rewrite the log.** When a payload shape changes, bump `schema_version`, register the new zod schema, and write an **upcaster** `(vN payload) → (vN+1 payload)` in the same module. The projection runtime upcasts every event to the latest version before it reaches a reducer, so reducers only ever see current shapes. Upcasters are pure, unit-tested functions — this is the mechanism that lets event schemas evolve over years with no migrations of the fact plane.

### 2.4 Corrections, retractions, redaction

- **Retraction**: append `system.event.retracted` with `corrects_uid`. The projection runner lints "you consume type X but not its retraction."
- **Correction**: append a new event of the same type with `corrects_uid` set; reducers treat it as replace-by-uid.
- **Redaction** — the *only* permitted mutation of the fact plane, reserved for accidentally-ingested secrets/PII: an admin function nulls `payload` on the target row (keeping the row, `seq`, and `type`) and appends `system.event.redacted`. Reducers must tolerate null payloads. Rare, logged, deliberate.

## 3. Projections

### 3.1 TypeScript reducers writing ordinary tables

Not SQL materialized views, not incremental-view-maintenance extensions:

1. **The logic is not relational.** Identity resolution, upcasting, spaced-repetition folds, replace-by-correction — these are folds with branching, trivial in TS and painful in SQL.
2. **One schema language.** Zod payload types flow straight into reducers; SQL projections would need a parallel type world.
3. **Replayability is a runtime feature.** A generic TS runner gives rebuild, checkpointing, upcasting, and lints once, for every projection.
4. **Boring targets.** The output is plain tables — indexable, FTS-able, pgvector-able, joinable by anything. Plain SQL *views* on top of projection tables for read convenience are fine and encouraged (they add no state).

### 3.2 The projection contract

```ts
interface Projection {
  name: string;                 // 'papers'
  version: number;              // bump ⇒ automatic rebuild from seq 0
  consumes: EventTypePattern[]; // ['arxiv.paper.*', 'user.annotation.added', ...]
  tables: string[];             // tables this projection exclusively owns
  init(tx: Sql): Promise<void>; // (re)create owned tables
  apply(tx: Sql, event: UpcastedEvent): Promise<void>;  // MUST be deterministic
}
```

```sql
create table projection_checkpoints (
  projection  text primary key,
  version     int not null,
  last_seq    bigint not null default 0,
  updated_at  timestamptz not null default now()
);
```

**Runner loop** (in the worker): for each projection, in one transaction — `select * from events where seq > $last_seq and type matches $patterns order by seq limit 500`, apply each, advance the checkpoint, commit. Applying events and advancing the checkpoint in the same transaction gives exactly-once effect on projection tables.

**Rebuild is the normal path, not a special script.** If `version` in code ≠ version in the checkpoint row, the runner truncates the owned tables, resets `last_seq` to 0, and replays. Because any reducer change bumps the version, the replay invariant is exercised constantly instead of rotting.

**Wakeups: cursor polling is truth, NOTIFY is a hint.** `append_events` does `pg_notify('events', seq)`; the runner (and the Electron app) LISTEN on a dedicated connection and treat a notification purely as "poll now." A 2-second poll fallback covers dropped connections — Neon's scale-to-zero kills idle connections, so the design assumes LISTEN connections die silently and reconnect. Nothing is ever missed because the cursor, not the notification, decides what is consumed.

**Where projections run**: all in the worker daemon, single-threaded per projection. The Electron app never runs reducers; it reads projection tables and appends events. One writer per derived table — no coordination problems, ever.

## 4. Entities & links: the cross-domain graph

### 4.1 Hybrid model

Pure node/edge is unqueryable and untyped; pure typed tables make cross-domain traversal miserable. Hybrid — and note all three of these are themselves *projections* (derived plane), rebuilt from events:

```sql
create table entities (
  entity_id     uuid primary key,        -- minted deterministically (below)
  kind          text not null,           -- 'person'|'org'|'paper'|'topic'|'email'|'calendar_event'
                                         -- |'tweet'|'message'|'memo'|'intent'|'resource'
  canonical_id  uuid not null,           -- self, unless merged into another entity
  display_name  text,
  created_seq   bigint not null
);
create index entities_kind      on entities (kind);
create index entities_canonical on entities (canonical_id);

create table identifiers (                -- the identity-resolution substrate
  scheme      text not null,             -- 'email'|'twitter'|'arxiv_author'|'phone'|'arxiv_id'|'doi'|'url'
  value       text not null,
  entity_id   uuid not null references entities,
  asserted_by text not null,             -- provenance of the identification
  confidence  real not null default 1.0,
  primary key (scheme, value)
);

create table links (
  link_id     uuid primary key,
  from_id     uuid not null,
  to_id       uuid not null,
  link_type   text not null,             -- 'authored'|'attended'|'works_at'|'about_topic'
                                         -- |'related_to'|'cites'|'mentions'|'fulfills_intent'|'same_as'
  asserted_by text not null,             -- 'connector:gmail' | 'agent:related-papers' | 'user'
  confidence  real not null default 1.0,
  evidence    jsonb,                     -- e.g. {event_uid, quote, score}
  created_seq bigint not null,
  unique (from_id, to_id, link_type, asserted_by)
);
create index links_from on links (from_id, link_type);
create index links_to   on links (to_id, link_type);
```

Plus one **typed table per major kind**, sharing `entity_id`: `papers(entity_id, arxiv_id, title, abstract, authors_raw, pdf_blob_ref, …)`, `people`, `emails`, `calendar_events`, `topics`, `memos`, `intents`, `sessions`. Typed tables carry the queryable columns; `entities` carries graph identity; `links` carries the edges. The cross-domain query in the vision — emails ↔ calendar events ↔ people ↔ orgs ↔ papers — is ordinary SQL joins through `links` and `identifiers`.

**Deterministic entity IDs.** `entity_id = uuidv5(namespace, kind + primary-external-identifier)`, computed in reducers — so replaying always mints the same IDs, and two independent writers seeing `arxiv:2401.xxxxx` converge on one entity with no coordination.

### 4.2 Identity resolution

The same person appears as `panda@example.com`, `@panda_ml`, and an arXiv author string:

1. Connectors emit ingestion events containing raw identifiers; reducers auto-create thin `person` entities per unseen identifier (low confidence, `asserted_by='connector:*'`).
2. An **identity-resolver agent** (and the user, via UI) asserts merges by appending `user.entity.merged` / `agent.link.asserted {link_type:'same_as'}` events, with evidence.
3. The entity projection folds merges into `canonical_id` (union-find in the reducer). **All queries join through `canonical_id`.** Nothing is destroyed, so an erroneous merge is undone by appending `user.entity.split`; replay heals everything.

Agent-asserted links always carry `asserted_by`, `confidence`, `evidence` — the UI renders "the related-papers agent says (0.82) these are related, because…" and the user can confirm (a `user` link at confidence 1.0) or reject (a retraction).

**Anti-concept check**: topics, intents, memos, and questions are *entities*, not new abstractions. Annotations are events rendered in place, not a new store.

### 4.3 Blobs

PDFs and attachments don't go in `events.payload`. A content-addressed **blob store** (`~/Library/Application Support/newcomputer/blobs/<sha256>`, optional object-storage mirror later); events store `{blob: {sha256, bytes, mime}}`. Blobs are immutable, so the replay invariant holds.

## 5. Connectors

### 5.1 Contract

```ts
interface Connector {
  name: string;                       // 'arxiv' | 'gmail' | 'imessage' ...
  schedule: string;                   // cron expression, or 'manual'
  // Pull changes since cursor; return events + next cursor. MUST be idempotent:
  // every event carries idempotency_key = `${name}:${externalId}:${contentHash?}`.
  sync(ctx: ConnectorCtx, cursor: JsonValue | null):
    Promise<{ events: NewEvent[]; nextCursor: JsonValue; more: boolean }>;
  backfill?(ctx: ConnectorCtx, window: Range): /* same shape, over historical ranges */;
}
```

- **Idempotency**: the unique constraint on `idempotency_key` makes duplicate delivery a no-op, so connectors can be re-run, crashed, or overlapped safely. An updated upstream item (edited calendar event) gets a new key via content hash → new event → the reducer replaces by external id.
- **Cursor state** lives in the operational table `connector_state(connector text pk, cursor jsonb, last_run_at, status, error)` — explicitly *not* in the event log (§10, decision 4). Losing it means re-syncing, which idempotency makes harmless.
- **Backfill vs live**: same code path, different cursor ranges; one `jobs` row per backfill window so large backfills chunk and resume.

### 5.2 Launch connectors

- **arXiv**: API metadata + PDF fetch into the blob store.
- **Gmail / Google Calendar**: OAuth tokens in the OS keychain (accessed by the worker); `historyId` / `syncToken` cursors.
- **iMessage**: read-only SQLite queries against `~/Library/Messages/chat.db`, `ROWID` cursor; requires Full Disk Access; runs in the worker, which lives on the same Mac.
- **Twitter**: export-file ingestion first (API access is unreliable); the design depends only on the `sync` contract.
- **Web-research "connectors" are actually agents** — they need judgment, so they reuse agent infrastructure and emit `agent.resource.surfaced` events. Not a sixth abstraction.

## 6. Agents

### 6.1 Agents are event consumers + event producers

An agent is a *reactor*: the same cursor machinery as a projection, but effectful (calls Claude) and its only output is appended events.

```ts
interface Agent {
  name: string;                          // 'related-papers'
  trigger:
    | { kind: 'event'; consumes: EventTypePattern[] }   // reuses checkpoint cursors
    | { kind: 'cron'; schedule: string }
    | { kind: 'manual' };                                // UI enqueues a job
  budget: { maxUsdPerDay: number; maxRunsPerHour: number };
  run(ctx: AgentCtx, input: TriggerInput): Promise<NewEvent[]>;
}
```

`AgentCtx` provides: read-only SQL over projections, pgvector search, blob access, a Claude Agent SDK session (with web search/fetch tools for research agents), and `emit()`, which stamps every produced event with `source='agent:<name>'`, `source_run_id`, `caused_by_uid` (the triggering event), and an idempotency key derived from `(agent, trigger event, output identity)` — so a retried run cannot double-post.

### 6.2 Execution & bookkeeping (operational plane)

All executions — agents, connectors, the scheduler — go through one plain Postgres job queue:

```sql
create table jobs (
  job_id      uuid primary key default gen_random_uuid(),
  kind        text not null,             -- 'agent:related-papers' | 'connector:gmail' | 'scheduler:daily'
  payload     jsonb not null default '{}',
  run_after   timestamptz not null default now(),
  status      text not null default 'pending',  -- pending|running|done|failed|dead
  attempts    int not null default 0,
  last_error  text
);
-- dispatcher: select ... where status='pending' and run_after <= now()
--             order by run_after for update skip locked limit 1;

create table agent_runs (
  run_id uuid primary key, agent text, job_id uuid, started_at timestamptz,
  finished_at timestamptz, status text, input_summary jsonb,
  emitted_uids uuid[], usd_cost numeric, tokens_in bigint, tokens_out bigint
);

create table cost_ledger (
  id bigint generated always as identity primary key,
  run_id uuid, agent text, model text, usd numeric, at timestamptz default now()
);
```

Budget enforcement: before dispatch, the worker checks `cost_ledger` sums against the agent's budget; over-budget jobs get `run_after = tomorrow`. That is the entire cost-control story, inspectable with one SQL query.

### 6.3 The launch agents

- **related-papers** — trigger: `user.intent.created` where intent kind is `read_paper` (plus a weekly cron refresh). Embeds the paper (pgvector over an `embeddings(entity_id, kind, vec)` projection), searches arXiv + web, emits `agent.resource.surfaced` and `agent.link.asserted {related_to, confidence, evidence}` per candidate.
- **topic-lineage** — trigger: `user.intent.created` kind `learn_topic`. Multi-turn Agent SDK session with web tools tracing the literature; emits `arxiv.paper.ingested` for lineage papers (the same events a connector would emit — deliberately, so dedup and downstream projections are identical), one `agent.memo.created` (a markdown memo entity with citations), and `about_topic` links.
- **intent-completion monitor** — trigger: `gmail.message.ingested | imessage.message.ingested | gcal.event.ingested`, cheaply pre-filtered in SQL against open amorphous intents' linked people/keywords, then a small Claude call for plausible matches; emits `agent.intent.completion_detected {confidence, evidence}`. The UI confirms → `user.intent.completed`.
- **chat-extractor** — powers the chat window (§8.3): free text → structured event proposal → user confirmation → append.
- **identity-resolver** — proposes `same_as` merges across identifiers with evidence (§4.2).
- **question-writer** (later) — generates explicit spaced-repetition questions from consumed content.

## 7. Scheduler / curriculum engine

The scheduler adds **zero new core concepts** — only event types and projection tables.

### 7.1 Data model

- **Interests**: `topic` entities + `user.interest.declared {topic_id, weight}` → an `interests` projection.
- **Intents**: `intent` entities. `user.intent.created {intent_kind: 'read_paper'|'learn_topic'|'amorphous_todo', subject_entity_id?, text, priority, depth: 'skim'|'deep', due_by?}`; lifecycle events `user.intent.completed | abandoned | snoozed`.
- **Sessions** (consumption telemetry): `user.session.started {block_id, entity_id}` / `user.session.ended {seconds_active, progress: {pages_read?, fraction}}` → a `sessions` projection. This is the training data for time estimates, gathered invisibly by the frontend.
- **Schedule**: `schedule.day.proposed {date, blocks: [{block_id, intent_id, entity_id, kind, planned_minutes, order, rationale}]}` from the scheduler; `user.schedule.block_completed | dismissed | moved | added` from the UI → a `schedule_blocks` projection.
- **Spaced repetition**: a `review_state` projection folding sessions per intent/topic into an SM-2-style `(ease, interval_days, due_date)`. Start with the *implicit* form — a due-date term in the score, ensuring the next H-Net-related touch happens before the interval grows too long — and add explicit AI-written questions later (`agent.question.generated`; a question is a `resource` entity rendered by the question renderer). Both forms read and write the same events.

### 7.2 The daily procedure

A cron job (`scheduler:daily`, ~4am, plus on-demand replans), deliberately a scoring pass rather than an ILP:

1. **Candidates** = open intents + due reviews.
2. **Time estimate per candidate**: personal rates from `sessions` (e.g. deep-read minutes/page by resource kind), shrunk toward priors while data is thin; running estimates for partially-consumed items.
3. **Score** = `w_p·priority + w_u·urgency(due_by) + w_r·rep_due(review_state) + w_s·staleness(last touch) − w_d·diversity_penalty(same-topic minutes already picked today)` — greedy pick into the day's available minutes, diversity penalty recomputed after each pick.
4. Emit one `schedule.day.proposed` (idempotency key `schedule:{date}:{plan_n}`); a replan emits a new proposal with `corrects_uid` on the old one.
5. **Rescheduling is nothing special**: incomplete blocks are simply still-open intents; tomorrow's run picks them up with a staleness boost.
6. **Feedback**: user edits are events, so the projection reflects the edited plan and, later, edit patterns become features (constant demotion of a topic → learned weight decay). Weights live in `scheduler.config.updated` events, so tuning history itself replays.

## 8. Frontend (Electron)

### 8.1 Process split and database access

- **Main process** owns: the pg pool to Neon (pooled endpoint for queries; one direct-endpoint connection dedicated to LISTEN, with reconnect + poll fallback), the append client (`@core/events`), blob-store access, window management.
- **Renderer** is a normal React app with `contextIsolation` on, talking to main over a **typed IPC bridge** (procedures defined once in `apps/desktop-api` with zod): named query procedures against projection tables, `append(event)`, `subscribe(patterns) → stream`. The renderer never holds DB credentials and never constructs raw SQL.
- **Real-time**: main receives NOTIFY → pushes `{seq, type}` hints to subscribed renderers → affected React Query caches invalidate and refetch. Plus **optimistic local echo**: when the UI appends an event it applies the expected effect immediately and reconciles on refetch, hiding Neon round-trip latency (~20–80ms) in the common case.
- **Offline stance for v1**: reads are cloud round-trips softened by caching and optimistic writes; explicitly *no* local replica yet. Because everything is rebuildable by replay, a local PGlite/SQLite mirror of hot projections can be added later as just another projection target — the architecture doesn't pre-commit (escape hatch, milestone M8).

### 8.2 Renderer registry — the encapsulation abstraction

```ts
interface EntityRenderer {
  match: (e: {kind: string; subkind?: string; mime?: string}) => number; // specificity
  Component: React.FC<{entityId: string}>;
  supports?: { annotations?: boolean; sessions?: boolean };
}
```

Registered renderers: pdf-paper (pdf.js, in-app, page-position session events), email (sanitized HTML), tweet, memo (markdown), calendar-event, question, fallback-JSON. Every content view in the app is `<EntityView entityId>` resolving through the registry — nothing links out to Preview or a browser.

Because rendering is internal, the shell composes universally around *any* content:

- **Annotation margin**: renders `user.annotation.added` events and agent notes anchored to the entity.
- **Related rail**: renders `links` where `to_id = this`, grouped by `asserted_by` — this is where agent-surfaced papers appear next to H-Net, each with one-click "want to read."
- **Session instrumentation**: open/close/scroll → session events, feeding time estimates invisibly.

### 8.3 Chat window

A persistent chat pane backed by the chat-extractor agent, whose job is *event extraction with confirmation*: "make sure I get coffee with Panda in the next few days" → structured proposal `user.intent.created {intent_kind:'amorphous_todo', text, participants:[panda→identifier lookup], due_by:+4d}` → rendered as a confirm card → appended on confirm. The chat is a thin event-authoring surface, not a separate system; ambiguous references trigger an identifier search over `identifiers`/`entities`.

### 8.4 Screens

**Today** (schedule blocks → tap to open the renderer full-screen), **Library** (papers/resources; FTS + vector search), **People/Topics** (entity pages = typed columns + link-derived sections), **Inbox** (agent surfacings awaiting triage), **Chat**, and an **Event Inspector** (raw log tail + projection checkpoint status). Build the Event Inspector *first* — it makes the whole system debuggable forever.

## 9. Process topology

**Two processes, one bus (the database):**

```
┌────────────────────────── Mac ──────────────────────────┐        ┌── Neon ──┐
│  Electron app (user-launched)                           │        │          │
│    main:  pg pool, LISTEN, append, blobs, IPC bridge    │◄──────►│ events   │
│    renderer: React, renderer registry, chat             │        │ projs    │
│                                                         │        │ ops      │
│  Worker daemon (launchd LaunchAgent, always on)         │◄──────►│          │
│    projection runner (all reducers)                     │        └──────────┘
│    job dispatcher → connectors / agents / scheduler     │
│    iMessage reader (needs local chat.db + FDA)          │
└─────────────────────────────────────────────────────────┘
```

Why this shape:

- **Not everything-in-Electron**: the curriculum must be ready when the user wakes up, the intent monitor must watch messages continuously, and a crashed agent must not take the UI down. The worker is a `launchd` LaunchAgent; because it runs on the same Mac it can host the iMessage connector, so *no* connectors live inside Electron.
- **Not a third cloud process**: iMessage and blob locality pin the worker to the Mac anyway; one machine, two processes is the simplest thing that satisfies "runs while the app is closed."
- **Coordination is exclusively through the database**: UI → worker via `jobs` rows (e.g. "run related-papers now"); worker → UI via events + NOTIFY. No IPC between the two processes, so either can be restarted, rewritten, or moved (worker → cloud VM later, minus iMessage; a second device later, pointed at the same Neon URL) with zero protocol work.
- The Electron app installs/updates the launchd plist and shows worker heartbeat (a `worker_heartbeat` operational row) in settings.

## 10. Monorepo layout

pnpm workspaces; plain TypeScript; Node everywhere by default (Bun for the worker is an option if launchd startup time matters).

```
newcomputer/
├── packages/
│   ├── core-db/            # pg client wrappers, migration runner (operational+derived DDL only)
│   ├── core-events/        # append_events client, NewEvent type, idempotency helpers, NOTIFY listen
│   ├── core-schema/        # ★ source of truth: zod schema per (event type, version), upcasters,
│   │                       #   emitted TS types; EVERYTHING imports payload types from here
│   ├── core-projections/   # Projection interface, runner, checkpoints, rebuild-on-version-bump
│   ├── core-entities/      # deterministic uuidv5 minting, canonical-id resolution, link helpers
│   ├── core-jobs/          # jobs table client (enqueue, SKIP LOCKED claim, retry/backoff)
│   ├── core-agents/        # Agent interface, AgentCtx, Claude SDK harness, budget/cost ledger
│   └── core-blobs/         # content-addressed blob store
├── projections/            # one package per projection: papers, people-and-identity, emails,
│                           #   calendar, messages, intents, sessions, schedule, review-state,
│                           #   embeddings, links, search(FTS)
├── connectors/             # arxiv, gmail, gcal, imessage, twitter   (implement Connector)
├── agents/                 # related-papers, topic-lineage, intent-monitor, chat-extractor,
│                           #   identity-resolver, question-writer    (implement Agent)
├── scheduler/              # curriculum engine (a job handler + its scoring lib, unit-tested)
├── apps/
│   ├── desktop/            # Electron: main/, renderer/ (screens, renderer registry, ipc client)
│   ├── desktop-api/        # typed IPC procedure definitions shared by main & renderer
│   └── worker/             # daemon entrypoint + registry.ts explicitly wiring every projection,
│                           #   connector, and agent — greppable, no magic discovery; launchd plist
└── tools/                  # event-inspector CLI (tail/replay/redact), seed scripts
```

## 11. Data-flow walkthroughs

### 11.1 H-Net paper flow

1. User pastes the arXiv URL (or finds it in Library). A `connector:arxiv` job fetches metadata + PDF → blob store; appends `arxiv.paper.ingested {arxiv_id, title, abstract, authors_raw, blob}` (idempotency key `arxiv:2401.xxxxx:v1`).
2. Projections fold: a `papers` row; `entities` mints the paper entity `uuidv5('paper:arxiv:2401.xxxxx')`; thin `person` entities per author identifier; `authored` links; the `embeddings` projection enqueues an embedding of the abstract.
3. User clicks "want to read in depth" → UI appends `user.intent.created {intent_kind:'read_paper', subject: paperEntity, depth:'deep'}` → `intents` projection.
4. That event triggers **related-papers**: vector + web search; appends `agent.resource.surfaced` ×5 and `agent.link.asserted {related_to, confidence, evidence}`, each with `caused_by_uid` = the intent event. They appear in the paper's related rail and in Inbox; the user clicks "want to read" on one → another `user.intent.created`. The loop closes.
5. 4am: the scheduler scores candidates. No session history yet → prior estimate (deep read, 28 pages → 90 min). Emits `schedule.day.proposed` with a "Read H-Net in depth" block.
6. Morning: Today shows the block; tap → pdf.js renderer full-screen. `user.session.started` on open; `user.session.ended {seconds_active: 2400, progress: {pages: 11/28}}` on close. Not finished — the user does nothing special.
7. Next 4am: the intent is still open, staleness rises, the estimate is now personalized (11 pages / 40 min → remaining ≈ 62 min); rescheduled. On finishing, the UI appends `user.schedule.block_completed` + `user.intent.completed`; `review_state` starts the spaced-repetition clock, and the rep-due score term resurfaces an H-Net review block (or, later, agent-generated questions) before the interval grows too long.

### 11.2 "Drifting models" topic flow

1. In chat: "I want to learn about drifting models." Chat-extractor proposes → user confirms → `user.intent.created {intent_kind:'learn_topic', text:'drifting models'}`; the reducer mints a `topic` entity.
2. Triggers **topic-lineage**: an Agent SDK session with web tools traces the literature; emits `arxiv.paper.ingested` per lineage paper (identical shape to connector output — idempotency keys dedup any that already exist), `agent.link.asserted {about_topic}` per paper, and one `agent.memo.created {markdown, citations: [entity_ids]}`. `agent_runs` and `cost_ledger` record the spend.
3. The topic page now shows the memo + paper list, each expandable in-app, each with its own "want to read."
4. The scheduler treats the open `learn_topic` intent as a candidate: one day Today shows "Understand drifting models — 45 min," whose block opens the memo (markdown renderer) with the paper list in the related rail. Reading sessions on the memo/papers accrue to the topic via links; the intent completes when the user says so (or the agent proposes completion once the linked papers are consumed).

### 11.3 Coffee-with-Panda intent flow

1. Chat: "make sure to find time to get coffee with Panda in the next few days" → confirm card → `user.intent.created {intent_kind:'amorphous_todo', text, participant_ids: [panda], due_by: +4d}`. ("Panda" is resolved via `identifiers`; if ambiguous, the chat asks.)
2. The scheduler surfaces a small block ("text Panda about coffee — 5 min") if the due date nears with no progress.
3. Meanwhile connectors keep flowing: `imessage.message.ingested` events arrive continuously from the worker's chat.db poll. **intent-monitor** pre-filters in SQL (message sender ↔ open intents' participants via `identifiers`), then asks Claude: the user's outgoing "coffee thursday 10am?" plus Panda's "yes!" → emits `agent.intent.completion_detected {intent_id, stage:'arranged', confidence: 0.9, evidence: {event_uids}}`.
4. Two days later `gcal.event.ingested {"Coffee w/ Panda", attendees}` — the attendee email resolves to the same canonical person → the monitor emits completion at 0.97 → Inbox card "Looks handled — mark done?" → `user.intent.completed {caused_by: detection}`. If nothing ever matches, the intent escalates in schedule score until done or `user.intent.abandoned`. Every hop is inspectable: the completion event's `caused_by_uid`/evidence chain points at the exact texts and calendar event.

## 12. The five decisions with the most long-term consequence

1. **Bigint sequence + single serialized append path** (vs ULIDs / free-form inserts). Every projection, agent trigger, and future replica hangs off "consume events where `seq > cursor`, in order, missing none." ULIDs or unserialized writes each break that invariant subtly (wall-clock interleave; commit-visibility gaps), and such bugs surface as silently-wrong projections years later. One advisory-locked function costs microseconds at personal scale and buys a permanently trustworthy cursor; `event_uid` preserves ID portability.
2. **TypeScript reducers over SQL projections.** The projection layer is where all evolution pressure lands — upcasting old payloads, identity merges, retraction handling, spaced-repetition folds. In TS these share zod types with producers and are unit-testable folds; in SQL they'd be triggers/matviews with a parallel, untyped schema world. The cost (a runner process, replay time) is small: replaying a few million events through indexed reducers is minutes, and rebuild-on-version-bump keeps that path continuously exercised rather than rotting.
3. **Hybrid entity model with `canonical_id` merge semantics.** Pure typed tables would make every new cross-domain feature a schema project; pure node/edge would make every read a self-join swamp. Registry + typed tables + links means new kinds are cheap (a table + a reducer), cross-domain queries are plain joins, and identity resolution is non-destructive — merges are events folded into `canonical_id`, reversible by replay. Critical because identity resolution *will* make mistakes and must never lose data.
4. **Three-plane separation: cursors, jobs, and agent runs are NOT events.** The tempting purist move — connector cursors and job state in the log — would bury the facts under operational noise (a polling connector would dominate the log), make replay ambiguous (should replay re-run jobs?), and couple the sacred plane to infrastructure churn. Keeping the operational plane in disposable tables preserves "replay = fold pure facts" forever. The invariant that makes this safe: every ingested event carries enough source position (its idempotency key) that operational state is always re-derivable or harmlessly re-earned.
5. **Two local processes coordinating only through Postgres.** The worker-as-launchd-daemon decision defines what "background" means for the whole system — curricula ready at dawn, intents monitored with the app closed — and gives connectors with OS access (iMessage) a home. Making the database the only bus keeps the process boundary soft: agents could move to a cloud VM, or a second device could join, by pointing at the same Neon URL, with zero protocol work. Direct IPC between app and worker would create a second, worse bus that every future feature would have to consider.

## 13. Phased roadmap

Each milestone is a coherent vertical slice that ships a usable loop; the M0 spine carries the invariants, so nothing in M1–M4 gets rewritten later.

- **M0 — The spine.** Monorepo; `events` table + `append_events`; `@core/schema` with ~5 event types; projection runner + checkpoints + rebuild-on-version-bump; worker daemon skeleton (jobs table, dispatcher, launchd); Electron shell whose only screen is the **Event Inspector**. *Exit test: bump a projection version and watch it rebuild.*
- **M1 — Paper curriculum, naive.** arXiv connector + blob store; `papers`/`entities`/`links` projections; Library; pdf.js renderer with session events; want-to-read button; scheduler v1 (priority + staleness only, fixed estimates); Today screen with complete/dismiss. *The H-Net loop works end-to-end, minus agents.*
- **M2 — First agent + embeddings.** `@core/agents` harness, `agent_runs`/`cost_ledger`; `embeddings` projection (pgvector); **related-papers**; related rail + Inbox triage.
- **M3 — Email, calendar, identity.** Gmail + GCal connectors (OAuth in keychain); `emails`/`calendar_events` projections; `identifiers` + canonical-merge machinery + identity-resolver agent + merge/split UI; People pages showing cross-domain joins. *Where "one database" starts visibly paying off.*
- **M4 — Chat, amorphous intents, iMessage.** Chat window + chat-extractor (confirm-card pattern); iMessage connector (Full Disk Access flow); **intent-monitor**; the coffee-with-Panda flow works.
- **M5 — Topic learning.** `learn_topic` intents; **topic-lineage**; memo entity + markdown renderer; Topic pages; "understand X" schedule blocks.
- **M6 — Scheduler v2.** Personalized time estimates from `sessions`; diversity penalty; `review_state` + implicit spaced repetition; scheduler-config events; explicit questions (**question-writer** + question renderer) as the stretch goal.
- **M7 — Breadth & search.** Twitter ingestion; FTS projection; global search (FTS + vector); tweet/email renderers polished; cross-domain query surfaces ("papers by people I've emailed").
- **M8 — Comfort, as needed (not speculative).** Local read cache (PGlite/SQLite mirror as an additional projection target) if Neon latency grates; log compaction tooling; second-device story.
