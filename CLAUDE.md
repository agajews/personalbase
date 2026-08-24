# personalbase — rules for agents

## Never open any port publicly

No service in this system may listen on a publicly reachable address or port.
That means: no public Fly apps, no unauthenticated webhooks, no tunnels, no
`0.0.0.0` binds — with exactly one exception: a server may bind non-loopback
**behind the Fly-sprite SSO proxy** (`NC_TRUSTED_TRANSPORT=1` /
`NC_PREVIEW=1`), where the sprites.app URL enforces org sign-in before any
request reaches the process. `apps/ui/src/server.ts` enforces this: it
refuses to bind non-loopback without one of those flags. Do not add a
password gate, an auth middleware, or any other scheme to justify a public
bind — remote access rides Fly org SSO, full stop.

Corollaries:
- Local dev servers bind `127.0.0.1` only.
- Anything that must receive calls from the outside world (webhooks, callbacks)
  is replaced by polling from the worker daemon instead.
- The main UI lives on the `nc-main-ui` sprite (deployed by the `main-ui`
  reactor; the daemon polls trunk every ~10s and redeploys on change). It is
  the only sprite that may hold the full `DATABASE_URL`; dev sandboxes get the
  read-only preview role at most.
