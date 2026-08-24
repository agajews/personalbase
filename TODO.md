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
