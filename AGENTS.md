# AGENTS.md

## Cursor Cloud specific instructions

This repo is a **static [Docsify](https://docsify.js.org) documentation site** ("Universidade Quero Passagem", a Brazilian customer-support training portal). Content is Brazilian Portuguese Markdown. There is **no build step, no bundler, no package manager, and no backend/database** — `index.html` renders the Markdown files in the browser at runtime.

### Running the site (dev mode)
Docsify fetches the Markdown over HTTP, so you must serve the folder over HTTP — opening `index.html` via `file://` will not render. Serve from the repo root:

- Recommended (live reload): `docsify serve . --port 3000` then open `http://localhost:3000`.
  - `docsify-cli` is installed to `~/.npm-global/bin` and added to `PATH` via `~/.bashrc` (the update script reinstalls it idempotently). If `docsify` is not found, run `export PATH="$HOME/.npm-global/bin:$PATH"`.
- Zero-dependency fallback (no install needed): `python3 -m http.server 3000` from `/workspace`.

### Non-obvious caveats
- **Requires outbound internet to `cdn.jsdelivr.net`.** Docsify core, the search plugin, and the `vue.css` theme are all loaded from the jsDelivr CDN at runtime (see `index.html`). With no internet the page only shows the "Carregando…" placeholder and never renders.
- The sidebar logo is loaded from `images.comparaonline.com`; if it fails only that one image is missing and the site still works.
- **There are no lint, test, or build commands** — none are defined and none apply to this static site.
