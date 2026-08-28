# Design TODO

Standing design debts and agreed follow-ups. Each entry says why it matters
and what the fix looks like, so any session (human or agent) can pick one up
cold. Remove entries when they ship; add context, not just titles.

## User-event idempotency keys

Reactor-emitted events all carry idempotency keys, but user events
(`user.devtask.created`, `user.devmessage.sent`, `user.paper.marked`, …) rely
on the UI being polite — a double ⌘⏎ created twin dev tasks (2026-08-24)
before the composers were debounced. The log already dedups on
`idempotency_key`, so the fix is client-minted request ids: the UI generates a
uuid per logical action, sends it with the POST, and the server uses it as the
event's idempotency key. Duplicates then become impossible at the log layer
instead of the button layer, retries become safe everywhere (flaky mobile
connections included), and the pattern should be the default for every future
user-action endpoint.

## Reclaim jobs orphaned by worker restarts

A claimed job stays `running` forever if the worker dies mid-run — there is
no lease or stale-claim sweep in `kernel/process/src/jobs.ts`. Every worker
deploy is such a death: the 2026-08-27 deploy orphaned an in-flight
paper-filter judging job (reset to pending by hand). Fix shape: claims carry
a heartbeat (`claimed_at` refreshed periodically, or a `lease_until`), and
the pump requeues jobs whose lease expired — attempts already count, so a
poison job still dies at maxAttempts. Runs stuck `running` from the same
deaths should be closed too (the 2026-08-24 starvation-era rows still show
`running`).

## Library items whose arXiv-ness is only in their URL

`libraryItemEntity` promotes an item to the `arxiv:<id>` paper entity when
Paperpile recorded an `arxivId`, but not when the only evidence is the URL —
so `url:https://arxiv.org/html/2405.13698v2` and friends sit in `entities` as
resources beside the papers they are (2 of 111 resources today). A link pasted
into the rail resolves arXiv URLs properly (`arxivIdFromUrl`), so pasting one
of those papers now mints the *paper* entity next to the library's resource
one: one work, two rows, both "saved". The fix is to run `arxivIdFromUrl` over
`item.url` inside `libraryItemEntity` — but re-keying those items moves their
marks, and any explicit `user.paper.marked` still naming the old `url:` ref
becomes an orphan mark with no entity, which is the failure this ingestion
path was built to stop. So: do it with a correction pass over those marks,
not as a bare precedence change.

## Warm golden-checkpoint sandboxes

Cold dev-agent launch spends ~2–4 minutes on npm (pnpm bootstrap, dependency
install, claude-code install) before turn 1. Sprites support checkpoints:
maintain a golden checkpoint with repo + node_modules + claude-code (+ a
headless browser, see below) preinstalled, refreshed periodically (e.g. by a
cron reactor after trunk moves); new tasks restore from it in seconds. Also
covers the "warm merge sandbox" idea — merge runs would start from the same
image. Coordinate between sessions before taking this one.

## Headless browser in the sandbox image

Agents doing UI work can't see their work: `nc-preview` serves a link for the
human, but visual self-verification required one agent to install
Playwright + Chromium by hand (which caught a real contrast bug). Bake it into
the golden checkpoint so screenshot-based verification is the default. House
rules already mention the manual install as a stopgap.

## GitHub App instead of the fine-grained PAT

The worker's `GITHUB_TOKEN` is a long-lived fine-grained PAT (contents + PRs
on this repo). A GitHub App (one-time browser creation, installed on this repo
only) lets the worker mint 1-hour installation tokens per run: per-repo scope,
auto-expiring credentials in sandboxes, central revocation. Wire as
`GH_APP_ID`/`GH_APP_PRIVATE_KEY` in devConfig with token minting at launch.

## Preview auth: proxy instead of (or alongside) sprite SSO

Previews are private today via sprite-auth URLs (fly.io SSO, org-only). Two
rough edges: the SSO hop is clunky on mobile, and HMR-over-the-sprite-proxy is
still unverified in a browser. Alternative: reverse-proxy previews through the
already-authenticated UI server (`/preview/<taskUid>/*` → sprite URL with the
sprite token attached server-side) — one cookie session covers everything.
Needs websocket proxying for vite HMR. A Neon branch per preview (instead of
the shared read-only role) is the matching data-layer upgrade: writable
previews against copy-on-write production data.

## Merge agent could refresh the sprite-hosted main UI (optional)

The main UI runs as an SSO-proxied service in the dedicated `nc-main-ui`
sprite and now tracks trunk on a 15-minute sha-gated cron (e88325a), so the
worst-case staleness after a merge is ~15 minutes with no coupling. Folding a
resync trigger into the merge agent's deploy step would tighten merges to ~0
staleness — nice-to-have, no longer required. Note the deliberate
trust-boundary exception recorded here: the
`nc-main-ui` sprite receives the full DATABASE_URL (it *is* the app) behind
fly.io SSO with `NC_TRUSTED_TRANSPORT=1`; dev-agent sandboxes must never get
either — don't cargo-cult that env into `nc-dev-*` launches. `nc-main-ui`
also sits outside the `nc-dev-*` namespace on purpose, so no dev cleanup path
may ever destroy it.

## Task status: `iterating`

A live session with no commits leaves the task chip on `working` between
turns, which reads as "busy" even when the agent is waiting on the user. A
distinct status (fold-derived: session alive + last run summary pending) would
make "waiting for you" legible at a glance.

## Retire `worktree-claude`

`main` is canonical; the two branches are mirrored by hand during the
transition (every session pushes both). Once the dev-merge pipeline is the
only path to trunk, drop the mirror convention and the branch.

## Upstream: sprite checkpoint metadata bug

`sprite checkpoint create` attaches the comment/id to one record and the
creation timestamp to another (reproduced in-sandbox 2026-08-24, including a
built-in reminder hook nagging about checkpoints that already exist). Report
to Fly with the repro from the dark-mode task's transcript.
