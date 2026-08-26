# personalbase capture

A one-click Chrome extension: press the toolbar button to save the current
page into personalbase.

- **arXiv pages** (`/abs/`, `/pdf/`, `/html/`) become papers: the server
  enqueues the arxiv reactor with the paper's id, so it gets the same
  canonical metadata (title, abstract, authors, categories) as the daily
  sweep, and is marked immediately.
- **Everything else** becomes a captured resource: the extension reads the
  page's own metadata (og:title / description / site name) and the server
  records a `user.resource.captured` event. Saving the same page twice
  converges on one entity.
- The badge shows ✓ on success, ✗ on failure, and opens the sign-in page if
  the SSO session has expired.

## Install

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this directory (`apps/extension`).
3. (Optional) Pin the button. There are no bundled icons yet, so Chrome shows
   the default puzzle piece.

## Auth

Per the repo's no-password rule, the extension carries no credentials. It
POSTs to the sprite UI URL with `credentials: include`, riding the Fly org
SSO session already in your browser; sign in once at the sprite URL and
captures work. For local dev, point the options page at
`http://127.0.0.1:4680`.

## Options

The extension's options page sets the personalbase URL (defaults to the main
sprite UI) and the default mark (`saved` or `want to read`).
