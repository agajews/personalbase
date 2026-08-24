# Design: A Personal Database-Oriented Operating System

*Status: draft for discussion. Nothing here is built yet; this document is the artifact to iterate on before any code exists.*

## 0. The core idea in one paragraph

One Neon Postgres database holds an append-only **event log** that is the sole source of truth. The kernel of the system is deliberately tiny: **the log, plus one process abstraction in two purity classes** — pure **folds** that derive queryable state from events, and effectful **reactors** that emit new events. Everything in the vision — arXiv/email/calendar/iMessage ingestion, background research agents, the daily curriculum scheduler, chat-driven intents, the cross-domain entity graph — is *userland*: a fold or a reactor registered on the kernel, never new core machinery. The Electron frontend reads what folds produce and triggers reactors; it holds no state of its own.

Stack decisions already made: **TypeScript full-stack**, **Neon (serverless Postgres)** as the single database, **Electron** desktop frontend, **Claude API / Agent SDK** inside LLM reactors.

## 1. The kernel

### 1.1 Shape

```
                 ┌───────────────────────────────┐
   world ───────►│ reactors (effectful)          │
   clock ───────►│  run at most once per trigger │──── append ────┐
   user ────────►│  output: events only          │                ▼
                 └───────────────▲───────────────┘         ┌────────────┐
                                 │ event triggers          │ event log  │
                                 └─────────────────────────│ (append-   │
                 ┌───────────────────────────────┐         │  only)     │
   queries ◄─────│ folds (pure)                  │◄─ read ─┤            │
                 │  replayable at will           │         └────────────┘
                 │  output: owned tables only    │
                 └───────────────────────────────┘
```

Two dual invariants, enforced by the runtime, make the whole system reasoned-about-able forever:

1. **Reactors write only to the log** (via the single append path). They never touch tables.
2. **Folds write only to their owned tables.** They never append events.

The log is therefore the *only* channel between processes. There is no other bus — no IPC, no queues-as-API, no shared mutable state.

### 1.2 Why the kernel can't be smaller

- The log alone can't answer queries → folds are necessary.
- Folds alone can't touch the world, the clock, or an LLM — effects break replay → reactors are necessary.
- The purity bit is irreducible: replay is the system's foundational guarantee, and effects must not re-run under replay (rebuilding a table must never spend money, re-send a request, or mint new facts). Conversely, modeling folds as reactors that "emit derived-state events" would pollute the fact log with disposable data. One process kind with a purity flag is the floor.
- Everything else in earlier drafts reduces: a *connector* is a cron-triggered reactor whose effect is reading an external source; an *agent* is an event- or manually-triggered reactor whose effect is calling Claude; the *scheduler* is a cron-triggered reactor whose effect is reading the clock; the *entity graph* is one fold plus naming conventions; *renderers* are a frontend concern, not database core. Even the *UI* fits the algebra: a fold-reader plus a human-triggered reactor.

### 1.3 The three planes

| Plane | Contents | Durability contract | Written by |
|---|---|---|---|
| **Fact** | `events` table only | Append-only, sacred, replayable forever | Reactors only |
| **Derived** | Fold-owned tables (`papers`, `entities`, `schedule_blocks`, …) | Truncate-and-replay at any time | Folds only |
| **Operational** | `checkpoints`, `jobs`, `process_state`, `runs`, `cost_ledger` | Disposable; losing it costs re-work, never facts | Kernel runtime |

Litmus test for "is X an event?": **would I want this fact when replaying in five years?** "User marked H-Net want-to-read" — yes. "The Gmail reactor's sync cursor is `historyId=88123`" — no; operational, and re-derivable anyway because each ingested event carries its source position in its idempotency key.

## 2. The log

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
  source          text not null,          -- 'reactor:arxiv' | 'reactor:related-papers' | 'ui:desktop'
  source_run_id   uuid,                   -- runs row when applicable
  -- Time
  occurred_at     timestamptz not null,   -- when the fact happened in the world
  recorded_at     timestamptz not null default now(),  -- when we learned of it
  -- Content
  payload         jsonb not null,
  -- Idempotency for re-runnable reactors
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

**Ordering: bigint identity, not ULIDs.** ULIDs solve distributed ID generation, which we don't have — Postgres is the single serialization point. A monotone `seq` gives every process a trivially correct cursor (`where seq > $last order by seq`). `event_uid` exists so external references never depend on `seq`, keeping log migration possible later.

**The one subtlety: commit-visibility gaps.** With concurrent writers, the row with seq 101 can become visible before seq 100 commits, and a cursor already past 100 skips it forever. The boring fix at personal scale: serialize all appends through one SQL function:

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

Every writer MUST append through this function via the kernel client. Contention is irrelevant at this scale; the cursor invariant is permanent. `on conflict do nothing` on the idempotency key makes every reactor re-runnable for free.

### 2.2 Event type naming

`<domain>.<noun>.<verb-past-tense>`:

- **Ingestion**: `arxiv.paper.ingested`, `gmail.message.ingested`, `gcal.event.ingested`, `imessage.message.ingested`, `twitter.tweet.ingested`
- **User actions**: `user.intent.created | completed | abandoned | snoozed`, `user.interest.declared`, `user.annotation.added`, `user.session.started | ended`, `user.schedule.block_completed | block_dismissed | block_moved`, `user.entity.merged | split`
- **LLM reactors**: `agent.link.asserted`, `agent.memo.created`, `agent.resource.surfaced`, `agent.question.generated`, `agent.intent.completion_detected`
- **Embedder**: `embedding.vector.computed`
- **Scheduler reactor**: `schedule.day.proposed`, `scheduler.config.updated`
- **System**: `system.event.retracted`, `system.event.redacted`

### 2.3 Payload schemas and evolution

Payload shapes are **zod schemas in the kernel's schema registry**, keyed by `(type, schema_version)`. The registry is code, not database — payloads are validated at append time and parse time, and every package imports payload types from this one place.

**Evolution rule: never rewrite the log.** When a shape changes, bump `schema_version`, register the new schema, and write a pure **upcaster** `(vN payload) → (vN+1 payload)` in the same module. The runtime upcasts every event to the latest version before any fold or reactor sees it. Upcasters are unit-tested pure functions — the mechanism that lets event schemas evolve for years with zero fact-plane migrations.

### 2.4 Corrections, retractions, redaction

- **Retraction**: append `system.event.retracted` with `corrects_uid`. The runtime lints "this fold consumes type X but not its retraction."
- **Correction**: append a new event of the same type with `corrects_uid`; folds treat it as replace-by-uid.
- **Redaction** — the *only* permitted mutation of the fact plane, reserved for accidentally-ingested secrets/PII: an admin function nulls `payload` on the target row (keeping row, `seq`, `type`) and appends `system.event.redacted`. Folds must tolerate null payloads. Rare, logged, deliberate.

## 3. Processes

One registry, one runtime, two kinds — a discriminated union:

```ts
type Process = Fold | Reactor;
```

### 3.1 Folds (pure)

```ts
interface Fold {
  kind: 'fold';
  name: string;                 // 'papers'
  version: number;              // bump ⇒ automatic truncate + replay from seq 0
  consumes: EventTypePattern[]; // ['arxiv.paper.*', 'user.annotation.added', ...]
  tables: string[];             // tables this fold exclusively owns
  init(tx: Sql): Promise<void>;                          // (re)create owned tables
  apply(tx: Sql, event: UpcastedEvent): Promise<void>;   // MUST be deterministic
}
```

Folds are **TypeScript reducers writing ordinary tables**, not SQL materialized views: the logic is folds-with-branching (identity merges, replace-by-correction, spaced-repetition state) that is trivial in TS and painful in SQL; zod payload types flow straight in; and the outputs are boring, indexable, FTS-able, pgvector-able plain tables. Read-only SQL *views* on top for convenience are fine — they add no state.

**Runner loop** (in the worker): per fold, in one transaction — fetch `events where seq > $last_seq` matching `consumes`, apply each, advance the checkpoint, commit. Apply + checkpoint in the same transaction = exactly-once effect on tables.

**Rebuild is the normal path, not a special script.** If `version` in code ≠ the checkpoint's version, the runtime truncates the owned tables, resets the cursor to 0, and replays. Any reducer change bumps the version, so the replay invariant is exercised constantly instead of rotting.

**Wakeups: cursor polling is truth, NOTIFY is a hint.** `append_events` fires `pg_notify`; listeners treat a notification purely as "poll now," with a 2-second poll fallback — Neon's scale-to-zero kills idle connections, so the design assumes LISTEN connections die silently. Nothing is missed because the cursor, not the notification, decides consumption.

### 3.2 Reactors (effectful)

```ts
interface Reactor {
  kind: 'reactor';
  name: string;                          // 'arxiv' | 'related-papers' | 'daily-scheduler' | ...
  trigger:
    | { kind: 'event'; consumes: EventTypePattern[] }  // cursor over the log, same machinery as folds
    | { kind: 'cron'; schedule: string }               // clock-driven (ingestion pollers, scheduler)
    | { kind: 'manual' };                              // UI/CLI enqueues a job
  limits?: { maxUsdPerDay?: number; maxRunsPerHour?: number };
  run(ctx: ReactorCtx, input: TriggerInput): Promise<NewEvent[]>;
}
```

`ReactorCtx` provides: read-only SQL over fold tables, private state (a jsonb slot in `process_state` — sync cursors like Gmail's `historyId` live here, in the operational plane, *not* in the log), blob access, an optional Claude Agent SDK session (with web search/fetch tools), and `emit()` — which stamps every produced event with `source`, `source_run_id`, `caused_by_uid` (the triggering event), and an idempotency key derived from `(reactor, trigger, output identity)`, so a retried run cannot double-post.

**Execution semantics**: at most once per trigger, never on replay. Retries are safe because emission is idempotent. Event-triggered reactors use the same checkpoint machinery as folds — but their checkpoints only ever move forward; there is no "version bump ⇒ re-run" for reactors, by construction.

**Every reactor in the system, one table:**

| Reactor | Trigger | Effect | Emits |
|---|---|---|---|
| `arxiv` | cron / manual | arXiv API + PDF → blob store | `arxiv.paper.ingested` |
| `gmail`, `gcal` | cron | Google APIs (OAuth in OS keychain; `historyId`/`syncToken` in private state) | `gmail.message.ingested`, `gcal.event.ingested` |
| `imessage` | cron | read-only queries on local `~/Library/Messages/chat.db` (ROWID cursor; needs Full Disk Access) | `imessage.message.ingested` |
| `twitter` | manual | export-file ingestion (API unreliable) | `twitter.tweet.ingested` |
| `embedder` | event: content-bearing ingestion patterns | embeddings API call | `embedding.vector.computed {entity_id, model, vector}` |
| `related-papers` | event: `user.intent.created` (read_paper), + weekly cron | pgvector + web search via Claude | `agent.resource.surfaced`, `agent.link.asserted` |
| `topic-lineage` | event: `user.intent.created` (learn_topic) | multi-turn Claude research session | `arxiv.paper.ingested` (same shape ingestion emits — deliberately), `agent.memo.created`, `agent.link.asserted` |
| `intent-monitor` | event: `*.message.ingested`, `gcal.event.ingested` | SQL pre-filter vs open intents, then a small Claude call | `agent.intent.completion_detected` |
| `chat-extractor` | manual (chat pane) | Claude turns free text into a structured event proposal; user confirms | `user.intent.created`, etc. (source `ui:desktop`, on confirm) |
| `identity-resolver` | event: ingestion patterns | proposes cross-identifier merges with evidence | `agent.link.asserted {same_as}` |
| `daily-scheduler` | cron ~4am, + manual replan | reads fold tables + clock, greedy scoring | `schedule.day.proposed` |
| `question-writer` (later) | event: `user.intent.completed` | Claude writes review questions | `agent.question.generated` |

Backfills (historical Gmail, old arXiv reading lists) are the same reactors driven over historical windows via `jobs` rows, chunked and resumable; idempotency keys make overlap harmless.

### 3.3 Operational substrate

The kernel runtime owns five small tables — all disposable:

```sql
create table checkpoints (          -- shared by folds and event-triggered reactors
  process    text primary key,
  version    int not null,          -- meaningful for folds only
  last_seq   bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table jobs (                 -- all triggering flows through here
  job_id     uuid primary key default gen_random_uuid(),
  process    text not null,         -- 'reactor:gmail' | 'reactor:daily-scheduler' | ...
  payload    jsonb not null default '{}',
  run_after  timestamptz not null default now(),
  status     text not null default 'pending',   -- pending|running|done|failed|dead
  attempts   int not null default 0,
  last_error text
);
-- dispatcher: select ... where status='pending' and run_after <= now()
--             order by run_after for update skip locked limit 1;

create table process_state (        -- reactor-private state (world cursors, oauth metadata)
  process text primary key, state jsonb, updated_at timestamptz
);

create table runs (                 -- one row per reactor execution
  run_id uuid primary key, process text, job_id uuid, started_at timestamptz,
  finished_at timestamptz, status text, input_summary jsonb,
  emitted_uids uuid[], usd_cost numeric, tokens_in bigint, tokens_out bigint
);

create table cost_ledger (
  id bigint generated always as identity primary key,
  run_id uuid, process text, model text, usd numeric, at timestamptz default now()
);
```

Cron triggers enqueue `jobs` rows; event triggers do too (the dispatcher watches checkpoints). Budget enforcement: before dispatch, sum `cost_ledger` against the reactor's `limits`; over-budget jobs get `run_after = tomorrow`. That's the entire cost-control story, inspectable with one SQL query.

## 4. Userland

Everything below is folds, reactors, and conventions — no new kernel machinery.

### 4.1 The graph fold

The cross-domain graph (people ↔ emails ↔ meetings ↔ orgs ↔ papers ↔ topics) is **one fold** owning three tables, plus a helper library for ID conventions:

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
  asserted_by text not null,
  confidence  real not null default 1.0,
  primary key (scheme, value)
);

create table links (
  link_id     uuid primary key,
  from_id     uuid not null,
  to_id       uuid not null,
  link_type   text not null,             -- 'authored'|'attended'|'works_at'|'about_topic'
                                         -- |'related_to'|'cites'|'mentions'|'fulfills_intent'|'same_as'
  asserted_by text not null,             -- 'reactor:gmail' | 'reactor:related-papers' | 'user'
  confidence  real not null default 1.0,
  evidence    jsonb,                     -- e.g. {event_uid, quote, score}
  created_seq bigint not null,
  unique (from_id, to_id, link_type, asserted_by)
);
create index links_from on links (from_id, link_type);
create index links_to   on links (to_id, link_type);
```

**Deterministic entity IDs** — a convention, not machinery: `entity_id = uuidv5(namespace, kind + primary-external-identifier)`, computed inside folds, so replay always mints the same IDs and independent event producers converge on one entity with no coordination.

**Identity resolution**: ingestion events carry raw identifiers; the graph fold auto-creates thin `person` entities per unseen identifier. Merges are *events* (`user.entity.merged`, `agent.link.asserted {same_as}`) folded into `canonical_id` (union-find in the reducer). All queries join through `canonical_id`; a wrong merge is undone by appending `user.entity.split`, and replay heals everything. Agent-asserted links always carry `asserted_by`/`confidence`/`evidence`, so the UI can show "related-papers says (0.82), because…" with confirm (a `user` link at 1.0) or reject (a retraction).

### 4.2 Domain folds

One typed table per major kind, sharing `entity_id` with the graph: `papers`, `people`, `emails`, `calendar_events`, `topics`, `memos`, `intents`, `sessions`, `schedule_blocks`, `review_state`, `interests`, `embeddings` (pgvector), `search` (FTS). Typed tables carry queryable columns; the graph fold carries identity and edges; cross-domain queries are ordinary SQL joins. Topics, intents, memos, and questions are *entities*, not new concepts; annotations are events rendered in place, not a new store.

### 4.3 The curriculum, expressed in kernel terms

- **Interests**: `user.interest.declared {topic_id, weight}` → `interests` fold.
- **Intents**: `user.intent.created {intent_kind: 'read_paper'|'learn_topic'|'amorphous_todo', subject_entity_id?, text, priority, depth: 'skim'|'deep', due_by?}` + lifecycle events → `intents` fold.
- **Sessions** (consumption telemetry, gathered invisibly by the frontend): `user.session.started/ended {seconds_active, progress}` → `sessions` fold — the training data for time estimates.
- **Spaced repetition**: a `review_state` fold computing SM-2-style `(ease, interval_days, due_date)` per intent/topic. Implicit first (a due-date term in the score, so the next H-Net-related touch happens before the interval grows too long); explicit AI-written questions later, via the `question-writer` reactor.
- **The `daily-scheduler` reactor**, ~4am + manual replans — deliberately a greedy scoring pass, not an ILP:
  1. Candidates = open intents + due reviews.
  2. Time estimate per candidate from `sessions` (personal minutes/page rates by kind, shrunk toward priors while data is thin; running estimates for partially-consumed items).
  3. `score = w_p·priority + w_u·urgency(due_by) + w_r·rep_due + w_s·staleness − w_d·diversity_penalty(same-topic minutes already picked today)`; greedy pick into the day's minutes.
  4. Emit one `schedule.day.proposed {date, blocks:[{block_id, intent_id, entity_id, planned_minutes, order, rationale}]}` (idempotency key `schedule:{date}:{plan_n}`); replans carry `corrects_uid`.
  5. **Rescheduling is nothing special**: an unfinished block is simply a still-open intent; tomorrow's run picks it up with a staleness boost.
  6. User edits to the schedule are events (`user.schedule.block_moved` etc.), so the `schedule_blocks` fold reflects the edited plan, and edit patterns later become scoring features. Weights live in `scheduler.config.updated` events — tuning history itself replays.

### 4.4 Search — FTS and vectors as folds

Because folds emit plain Postgres tables, search is ordinary SQL, added without new machinery:

- **Full-text, in-place**: a fold declares a generated `tsvector` column + GIN index in its own `init()` — e.g. `papers.tsv generated always as (to_tsvector('english', title || ' ' || abstract)) stored`. `init()` runs on every rebuild, so the index survives replay by construction.
- **Full-text, cross-domain**: a dedicated `search` fold consuming many event types into one `search_index(entity_id, kind, text, tsv)` table — "search everything" is one query.
- **Vectors**: computing an embedding is an *effect* (an API call), so it cannot live inside a pure fold — a rebuild must never re-spend money or depend on a remote service. Instead: the `embedder` reactor (event-triggered on content-bearing events) calls the embeddings API and emits `embedding.vector.computed {entity_id, model, vector}` — the vector becomes a fact, exactly as an agent memo is an LLM effect stored as an event. A trivial `embeddings` fold materializes those events into a pgvector table with an HNSW index; replay re-folds stored vectors with zero API calls. Model upgrades are explicit: re-run the embedder with a new model tag → new events → the fold keeps the generation(s) it wants.
- **Hybrid search** is then a join: FTS rank and vector distance combined in one SQL query over two fold tables, since both are just tables.

(Extracting text from PDFs for indexing follows the same reactor pattern — a `text-extractor` reactor emitting extracted text referencing a blob — since heavyweight extraction is better treated as an effect than re-done on every replay.)

### 4.5 Blobs

PDFs and attachments don't go in `events.payload`. A content-addressed **blob store** (`~/Library/Application Support/newcomputer/blobs/<sha256>`; optional object-storage mirror later); events store `{blob: {sha256, bytes, mime}}`. Blobs are immutable, so the replay invariant holds.

## 5. Frontend (Electron)

In kernel terms the UI is a *fold-reader plus a human-triggered reactor*: every screen is a query over fold tables, and every user action is an appended event.

### 5.1 Process split and database access

- **Main process** owns: the pg pool to Neon (pooled endpoint for queries; one direct-endpoint connection for LISTEN, with reconnect + poll fallback), the append client, blob access, window management.
- **Renderer**: React with `contextIsolation` on, talking to main over a typed IPC bridge (zod-defined procedures): named query procedures over fold tables, `append(event)`, `subscribe(patterns) → stream`. The renderer never holds credentials or raw SQL.
- **Real-time**: NOTIFY → `{seq, type}` hints → React Query invalidation. Plus **optimistic local echo**: a UI append applies its expected effect immediately and reconciles on refetch, hiding Neon round-trip latency (~20–80ms).
- **Offline stance for v1**: no local replica; caching + optimistic writes. Because everything is rebuildable, a local PGlite/SQLite mirror of hot fold tables can be added later as just another fold target — an escape hatch (M8), not a pre-commitment.

### 5.2 Renderer registry — the encapsulation abstraction (frontend-only)

```ts
interface EntityRenderer {
  match: (e: {kind: string; subkind?: string; mime?: string}) => number; // specificity
  Component: React.FC<{entityId: string}>;
  supports?: { annotations?: boolean; sessions?: boolean };
}
```

Registered: pdf-paper (pdf.js, page-position session events), email (sanitized HTML), tweet, memo (markdown), calendar-event, question, fallback-JSON. Every content view is `<EntityView entityId>` resolving through the registry — nothing links out to Preview or a browser. Because rendering is internal, the shell composes universally around any content: an **annotation margin** (user + agent notes anchored to the entity), a **related rail** (links grouped by `asserted_by` — where agent-surfaced papers appear next to H-Net, one click to "want to read"), and **session instrumentation** (open/close/scroll → session events, feeding time estimates invisibly).

### 5.3 Chat window

A persistent pane backed by the `chat-extractor` reactor: "make sure I get coffee with Panda in the next few days" → structured proposal `user.intent.created {intent_kind:'amorphous_todo', participants:[panda→identifier lookup], due_by:+4d}` → confirm card → appended on confirm. The chat is a thin event-authoring surface, not a separate system; ambiguous references trigger an identifier search.

### 5.4 Screens

**Today** (schedule blocks → renderer full-screen), **Library** (FTS + vector search), **People/Topics** (entity pages: typed columns + link-derived sections), **Inbox** (reactor surfacings awaiting triage), **Chat**, and an **Event Inspector** (raw log tail + checkpoint status + runs/cost). Build the Event Inspector *first* — it makes the whole system debuggable forever.

## 6. Process topology

**Two OS processes, one bus (the database):**

```
┌────────────────────────── Mac ──────────────────────────┐        ┌── Neon ──┐
│  Electron app (user-launched)                           │        │          │
│    main:  pg pool, LISTEN, append, blobs, IPC bridge    │◄──────►│ events   │
│    renderer: React, renderer registry, chat             │        │ folds    │
│                                                         │        │ ops      │
│  Worker daemon (launchd LaunchAgent, always on)         │◄──────►│          │
│    kernel runtime: fold runner + job dispatcher         │        └──────────┘
│    all registered folds and reactors                    │
│    (incl. imessage — needs local chat.db + FDA)         │
└─────────────────────────────────────────────────────────┘
```

- **Not everything-in-Electron**: the curriculum must be ready at dawn, intents monitored with the app closed, and a crashed reactor must not take the UI down. The worker is a `launchd` LaunchAgent on the same Mac, so it hosts the iMessage reactor too.
- **Not a third cloud process**: iMessage and blob locality pin the worker to the Mac anyway.
- **Coordination is exclusively through the database**: UI → worker via `jobs` rows ("run related-papers now"); worker → UI via events + NOTIFY. No IPC between the two, so either can be restarted, rewritten, or moved (reactors → a cloud VM later, minus iMessage; a second device pointed at the same Neon URL) with zero protocol work.
- The app installs/updates the launchd plist and shows a worker heartbeat (operational row) in settings.

## 7. Monorepo layout

pnpm workspaces; plain TypeScript; Node everywhere by default.

```
newcomputer/
├── kernel/
│   ├── log/           # events DDL + append_events client, NOTIFY listen, NewEvent type
│   ├── schema/        # ★ zod registry per (event type, version) + upcasters; everything
│   │                  #   imports payload types from here
│   ├── process/       # Fold & Reactor interfaces, runner, checkpoints, jobs dispatcher,
│   │                  #   process_state, runs/cost ledger, rebuild-on-version-bump
│   └── blobs/         # content-addressed blob store
├── userland/
│   ├── graph/         # the graph fold (entities/identifiers/links) + uuidv5/canonical helpers
│   ├── folds/         # papers, emails, calendar, messages, intents, sessions, schedule,
│   │                  #   review-state, interests, embeddings, search
│   ├── reactors/      # arxiv, gmail, gcal, imessage, twitter, related-papers, topic-lineage,
│   │                  #   intent-monitor, chat-extractor, identity-resolver, daily-scheduler,
│   │                  #   question-writer
│   └── scoring/       # the scheduler's scoring lib + time-estimate model (pure, unit-tested)
├── apps/
│   ├── desktop/       # Electron: main/, renderer/ (screens, renderer registry, ipc client)
│   ├── desktop-api/   # typed IPC procedure definitions shared by main & renderer
│   └── worker/        # daemon entrypoint + registry.ts explicitly listing every fold and
│                      #   reactor — greppable, no magic discovery; launchd plist
└── tools/             # event-inspector CLI (tail/replay/redact), seed scripts
```

The kernel directory should stay small enough to read in one sitting; all growth happens in `userland/`.

## 8. Data-flow walkthroughs

### 8.1 H-Net paper flow

1. User pastes the arXiv URL. A `reactor:arxiv` job fetches metadata + PDF → blob store; appends `arxiv.paper.ingested` (idempotency key `arxiv:2401.xxxxx:v1`).
2. Folds fold: a `papers` row; the graph fold mints `uuidv5('paper:arxiv:2401.xxxxx')`, thin author `person` entities, `authored` links. The `embedder` reactor embeds the abstract and emits `embedding.vector.computed`; the `embeddings` fold materializes it into the pgvector table.
3. User clicks "want to read in depth" → `user.intent.created {read_paper, depth:'deep'}` → `intents` fold.
4. That event triggers `related-papers`: vector + web search; emits `agent.resource.surfaced` ×5 and `agent.link.asserted {related_to, confidence, evidence}`, each `caused_by_uid` = the intent event. They appear in the paper's related rail and Inbox; one click on a candidate creates another read intent. The loop closes.
5. 4am: `daily-scheduler` scores candidates; no session history yet → prior estimate (deep read, 28 pages → 90 min); emits `schedule.day.proposed` with a "Read H-Net in depth" block.
6. Morning: Today shows the block; tap → pdf.js full-screen. `user.session.started` on open; `user.session.ended {seconds_active: 2400, progress:{pages: 11/28}}` on close. Unfinished — the user does nothing special.
7. Next 4am: the intent is still open; staleness rises; the estimate is now personal (11 pages / 40 min → ≈62 min remaining); rescheduled. On finishing: `user.schedule.block_completed` + `user.intent.completed`; `review_state` starts the spaced-repetition clock, and the rep-due term resurfaces an H-Net review block (later: generated questions) before the interval grows too long.

### 8.2 "Drifting models" topic flow

1. Chat: "I want to learn about drifting models" → `chat-extractor` proposal → confirm → `user.intent.created {learn_topic}`; the graph fold mints a `topic` entity.
2. Triggers `topic-lineage`: a Claude session with web tools traces the literature; emits `arxiv.paper.ingested` per lineage paper (identical shape to ingestion — idempotency dedups any already known), `about_topic` links, and one `agent.memo.created {markdown, citations}`. `runs`/`cost_ledger` record the spend.
3. The topic page shows memo + papers, each expandable in-app, each with its own "want to read."
4. The open `learn_topic` intent is a scheduling candidate: one day Today shows "Understand drifting models — 45 min," opening the memo with the paper list in the related rail. Sessions on memo/papers accrue to the topic via links; the intent completes when the user says so (or the reactor proposes completion once linked papers are consumed).

### 8.3 Coffee-with-Panda intent flow

1. Chat → confirm card → `user.intent.created {amorphous_todo, participant_ids:[panda], due_by:+4d}` ("Panda" resolved via `identifiers`; if ambiguous, the chat asks).
2. If the due date nears with no progress, the scheduler surfaces a nudge block ("text Panda about coffee — 5 min").
3. Meanwhile `imessage.message.ingested` events flow continuously. `intent-monitor` pre-filters in SQL (sender ↔ open intents' participants), then asks Claude: outgoing "coffee thursday 10am?" + Panda's "yes!" → `agent.intent.completion_detected {stage:'arranged', confidence: 0.9, evidence:{event_uids}}`.
4. Two days later `gcal.event.ingested {"Coffee w/ Panda"}` — the attendee resolves to the same canonical person → completion at 0.97 → Inbox card "Looks handled — mark done?" → `user.intent.completed`. If nothing ever matches, the intent escalates in score until done or abandoned. Every hop is inspectable via the `caused_by_uid`/evidence chain.

## 9. The decisions with the most long-term consequence

1. **The fold/reactor purity split is the kernel.** One process abstraction, one bit of difference — but that bit is the line between "may re-run freely" (folds, hence rebuildable state) and "must never re-run" (reactors, hence trustworthy facts and bounded spend). Erasing it in either direction breaks the system: effectful folds make replay dangerous; fold-as-reactor pollutes the log with derived data. Everything else in the design is userland precisely because this split carries all the semantics.
2. **Bigint sequence + single serialized append path** (vs ULIDs / free-form inserts). Every fold, reactor trigger, and future replica hangs off "consume events where `seq > cursor`, in order, missing none." ULIDs or unserialized writes break that invariant subtly (wall-clock interleave; commit-visibility gaps), surfacing years later as silently-wrong tables. One advisory-locked function costs microseconds at personal scale; `event_uid` preserves ID portability.
3. **TypeScript folds over SQL projections.** The fold layer is where all evolution pressure lands — upcasting, identity merges, retraction handling, spaced-repetition state. In TS these share zod types with producers and are unit-testable; in SQL they'd be triggers/matviews in a parallel untyped world. Replay cost is small (millions of events → minutes), and rebuild-on-version-bump keeps the path continuously exercised.
4. **The graph is a fold, with `canonical_id` merge semantics.** Registry + typed tables + links makes new kinds cheap (a table + reducer clauses), cross-domain queries plain joins, and identity resolution non-destructive — merges are events, reversible by replay. Critical because identity resolution *will* make mistakes and must never lose data.
5. **Operational state is not events.** Cursors, jobs, and runs in the log would bury facts under noise, make replay ambiguous (should it re-run jobs?), and couple the fact plane to infrastructure churn. Disposable operational tables preserve "replay = fold pure facts" forever; safe because every ingested event carries its source position in its idempotency key.
6. **Two OS processes coordinating only through Postgres.** The launchd worker defines what "background" means (curricula at dawn, monitoring with the app closed) and homes OS-bound reactors (iMessage). The database as the only bus keeps the process boundary soft — reactors to a cloud VM, or a second device, by pointing at the same Neon URL, with zero protocol work.

## 10. Dev agents — the system that modifies itself

From the UI: type a request, fire it off, keep working. Two task shapes come out of that box, and only one of them is new machinery:

- **Data/research tasks** ("ingest the best NeurIPS papers") are ordinary reactors with web tools that emit ordinary events. Nothing below applies; that's just more userland.
- **Code tasks** ("add a papers-by-org view") need a place to run Claude Code, a PR pipeline, and a merge/deploy lane. That's this section.

### 10.1 The shape: detached sandbox + poll chain

The worker's job dispatcher is deliberately serial, so a 30-minute agent session must not be one job. Instead the long-lived thing is a **detached process inside a cloud sandbox** (Fly Sprite), and the reactor is a **chain of quick jobs** that watch it:

1. `user.devtask.created {title, spec}` (appended by the UI) triggers the `dev-agent` reactor. Its launch step creates a sprite, writes a run script (clone repo, branch off trunk, install, run `claude -p` headless with the spec, push, open a PR via `gh`, write `result.json`), starts it detached (`nohup … > run.log`), and returns `dev.run.started` plus a **follow-up job**: "poll this run in 10s".
2. Each poll job reads the log tail from the sandbox, emits `dev.transcript.appended` chunks (idempotency key `dev:<run>:chunk:<n>`), and re-enqueues itself with the advanced cursor in the job payload — no state table, and each poll is a sub-second reactor run, so the serial dispatcher stays live for everything else.
3. When the script exits, the final poll reads `result.json`, emits `dev.pr.opened` + `dev.run.finished`, and deletes the sprite (kept on failure, for inspection).

Two small kernel extensions carry this: reactors may return `{ events, followUps }` (jobs enqueued only after the events append — the launch/poll chain), and `jobs` gains `run_after` exposure plus a nullable unique `dedupe_key` so a retried run can't fork the poll chain.

**Transcripts are events.** A dev agent's transcript is the provenance of a code change to this very system — it passes the five-year litmus test the way an `agent.memo.created` does. Chunked `dev.transcript.appended` events (≤256KB per poll) keep the log append-only and the UI a plain fold-reader; if volume ever grates, the escape hatch is the blob store (§4.5) with pointer events, not a parallel side channel.

### 10.2 The merge lane

`user.devmerge.requested` (the UI's approve button — the same confirm-card stance as everything else) triggers the `dev-merge` reactor: same sandbox/poll harness, different script — checkout the PR, rebase onto trunk, typecheck, squash-merge, then `fly deploy` both apps from the merged trunk. It emits `dev.pr.merged` and `dev.run.finished`.

Notes that matter:
- **Serialized by construction**: merge runs go through the same serial dispatcher, so two approvals can't race a deploy.
- **Self-update is safe**: the merge deploy restarts the very worker that babysits the merge run. The sandbox keeps running detached; the restarted daemon requeues `running` jobs and the poll chain resumes — all state lives in the database, none in the process.
- **Human gate first**: nothing merges without a `user.devmerge.requested` event. Auto-merge later is one reactor-trigger change, not a redesign.
- Trunk is configurable (`DEV_TRUNK`); the canonical trunk is `main` — agent PRs target it and the merge agent deploys from it.

### 10.2b Interactive tasks and live previews

There is deliberately **one agent concept**: a task is a conversation, and what
kind of task it is falls out of what you ask for. A task runs as **one live
Claude Code session** (`--input-format stream-json` over a named pipe in the
sandbox): follow-up messages stream straight into the session's stdin in a
couple of seconds, a turn-end hook inside the sandbox pushes commits and keeps
the PR current after every completed turn, and the task page renders the whole
thing as one continuous conversation. Interrupt kills the session process
mid-turn (state persists up to the kill) and the message resumes the session in
a fresh run; a session idle for 30 minutes is closed gracefully and any later
message reopens it the same way. So "build X and PR it" and "start a dev server
and iterate with me until I say ship it" are the same machinery with different
instructions.

For UI work the agent runs `nc-preview` in its sandbox: the app's dev server
(vite + API) against a **read-only** database role, reached through the
sandbox's own HTTPS URL. That URL stays in sprite-auth mode — browsers get an
SSO login via fly.io, so previews are private to the org with zero custom auth
and nothing public. The poller notices the preview marker and surfaces the URL
on the task page as a fact (`dev.preview.started`); vite hot-reloads the
agent's edits, so the iterate loop is: message the agent → watch the preview
change. Suspended sandboxes wake on incoming HTTP, so the link keeps working
between turns for free; the merge lane's cleanup kills the preview with the
sandbox.

### 10.3 Trust boundaries

- Feature sandboxes get `GITHUB_TOKEN` (push + PR) and `ANTHROPIC_API_KEY`. Only the merge lane's sandbox gets Fly deploy tokens.
- Sandboxes never get `DATABASE_URL`. Everything they produce enters the system through the reactor that polls them — the log's single append path, stamped with `source`/`sourceRunId`/`causedByUid` like any other reactor output.
- Known v1 gap: the GitHub token is a broad personal token; a fine-grained per-repo PAT and branch protection on trunk are the follow-up.

### 10.4 Events, fold, screens

Events: `user.devtask.created`, `dev.run.started`, `dev.transcript.appended`, `dev.pr.opened`, `user.devmerge.requested`, `dev.pr.merged`, `dev.run.finished`. One `dev` fold owns `dev_tasks`, `dev_runs`, `dev_transcript_chunks`. UI: an **Agents** screen (task list + new-task form) and a **Task** screen (status, PR link, merge button, live transcript rendered from the stream-json lines) — both plain fold-readers polling like every other view.

## 11. Phased roadmap

Each milestone is a vertical slice shipping a usable loop; the M0 kernel carries the invariants, so nothing later gets rewritten.

- **M0 — The kernel.** Monorepo; `events` + `append_events`; schema registry with ~5 event types; fold runner + checkpoints + rebuild-on-version-bump; jobs dispatcher + reactor harness; worker daemon (launchd); Electron shell whose only screen is the **Event Inspector**. *Exit test: bump a fold version and watch it rebuild.*
- **M1 — Paper curriculum, naive.** `arxiv` reactor + blob store; `papers` + graph folds; Library; pdf.js renderer with session events; want-to-read button; `daily-scheduler` v1 (priority + staleness, fixed estimates); Today screen. *The H-Net loop works end-to-end, minus LLM reactors.*
- **M2 — First LLM reactor + embeddings.** Claude harness in the reactor runtime, `runs`/`cost_ledger`; `embedder` reactor + `embeddings` fold (pgvector); `related-papers`; related rail + Inbox.
- **M3 — Email, calendar, identity.** `gmail`/`gcal` reactors (OAuth in keychain); `emails`/`calendar_events` folds; identifiers + canonical-merge + `identity-resolver` + merge/split UI; People pages with cross-domain joins. *Where "one database" starts visibly paying off.*
- **M4 — Chat, amorphous intents, iMessage.** Chat pane + `chat-extractor` (confirm-card pattern); `imessage` reactor (Full Disk Access flow); `intent-monitor`; the coffee-with-Panda flow works.
- **M5 — Topic learning.** `learn_topic` intents; `topic-lineage`; memo entity + markdown renderer; Topic pages; "understand X" blocks.
- **M6 — Scheduler v2.** Personalized time estimates from `sessions`; diversity penalty; `review_state` + implicit spaced repetition; scheduler-config events; explicit questions (`question-writer` + question renderer) as stretch.
- **M7 — Breadth & search.** `twitter` ingestion; FTS fold; global search (FTS + vector); tweet/email renderers polished; cross-domain query surfaces ("papers by people I've emailed").
- **M8 — Comfort, as needed.** Local read cache (PGlite/SQLite mirror as an additional fold target) if Neon latency grates; log compaction tooling; second-device story.
