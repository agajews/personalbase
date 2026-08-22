# newcomputer

A personal database-oriented operating system. One Postgres database holds an
append-only event log as the sole source of truth; pure **folds** derive all
queryable state (rebuildable by replay at any time) and effectful **reactors**
emit new events (at most once per trigger, idempotent). See [DESIGN.md](DESIGN.md).

## Layout

- `kernel/` — the log (`events` + `append_events()`), the zod schema registry
  with upcasters, and the fold/reactor runtime. Small enough to read in one
  sitting; all growth happens in userland.
- `userland/` — folds (`papers`, `filters`, `filter_results`) and reactors
  (`arxiv` ingestion, `paper-filter` LLM judging).
- `apps/worker` — the explicit process registry and the CLI.

## Setup

```sh
pnpm install
cp .env.example .env   # set DATABASE_URL (and ANTHROPIC_API_KEY for filtering)
pnpm nc migrate
```

`DATABASE_URL` can point at the local dev container (`docker compose up -d`,
db `personalbase`) or a Neon database.
Tests need `TEST_ADMIN_DATABASE_URL` (they create and drop scratch databases):
`pnpm test`.

## The first application: prompt-filtered arXiv ingestion

```sh
# Ingest recent papers (idempotent; overlapping windows are free).
# Note: arXiv's API indexes submissions with a lag of roughly 1–2 days,
# so a trailing multi-day window is the right daily pattern.
pnpm nc ingest-arxiv --days 3 --category cs.LG --category cs.CL

# Define (or edit) a filter — this appends a user.filter.defined event.
pnpm nc set-filter ssm --prompt "Papers about state space models ..."

# Judge ingested papers against the filter over a date range.
pnpm nc run-filter ssm --days 3

# Inspect.
pnpm nc results ssm            # matches under the current prompt
pnpm nc results ssm --rejects
pnpm nc tail --limit 50        # raw event log
```

Rerun semantics: verdicts are keyed by `(filter, prompt_hash, paper)`, where
`prompt_hash` covers the prompt and model. Rerunning with an unchanged prompt
judges nothing (no LLM spend). Editing the prompt gives a new hash, so
`run-filter --days N` re-judges that range under the new prompt while old
verdicts stay attributed to the prompt version that produced them — all of it
just events in the log.

## UI

```sh
pnpm ui   # builds and serves http://127.0.0.1:4680
```

A local web console for the filter desk: edit prompts (with a live preview of
the hash the edit will mint), trigger ingests and judging runs, and read
verdicts. The UI appends events and enqueues jobs; the worker daemon picks
jobs up through the database — there is no direct connection between them.
The UI also catches up folds itself, which is safe alongside the daemon
because the fold runner takes a per-fold advisory lock.

## Worker on Fly

The worker daemon runs as the Fly app `personalbase-worker` (one always-on
`shared-cpu-1x` machine in `sjc`, no public ports; `Dockerfile` + `fly.toml`).
Secrets: `DATABASE_URL`, `ANTHROPIC_API_KEY`.

```sh
fly deploy --app personalbase-worker --ha=false   # redeploy after changes
fly logs --app personalbase-worker                # watch it work
```

A locally-run daemon (`pnpm nc daemon`) is safe to run alongside it: the job
queue claims with SKIP LOCKED and fold-running is advisory-locked.
