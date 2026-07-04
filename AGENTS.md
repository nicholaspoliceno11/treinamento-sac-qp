# AGENTS.md

## Cursor Cloud specific instructions

This repo is a **static [Docsify](https://docsify.js.org) documentation site** ("Treinamento Quero Passagem", a Brazilian customer-support training portal). Content is Brazilian Portuguese Markdown. There is **no build step, no bundler, no package manager, and no backend/database** — `index.html` renders the Markdown files in the browser at runtime.

### Running the site (dev mode)
Docsify fetches the Markdown over HTTP, so you must serve the folder over HTTP — opening `index.html` via `file://` will not render. Serve from the repo root:

- Recommended (live reload): `docsify serve . --port 3000` then open `http://localhost:3000`.
  - `docsify-cli` is installed to `~/.npm-global/bin` and added to `PATH` via `~/.bashrc` (the update script reinstalls it idempotently). If `docsify` is not found, run `export PATH="$HOME/.npm-global/bin:$PATH"`.
- Zero-dependency fallback (no install needed): `python3 -m http.server 3000` from `/workspace`.

### Non-obvious caveats
- **Requires outbound internet to `cdn.jsdelivr.net`.** Docsify core, the search plugin, and the `vue.css` theme are all loaded from the jsDelivr CDN at runtime (see `index.html`). With no internet the page only shows the "Carregando…" placeholder and never renders.
- The sidebar logo is loaded from `images.comparaonline.com`; if it fails only that one image is missing and the site still works.
- **There are no lint, test, or build commands** — none are defined and none apply to this static site.

### Portal de login / progresso (opcional, via Google Apps Script)
- The site can act as a gated portal (login, roles, progress, comments). The front-end is a Docsify plugin in `assets/app.js` (+ `assets/app.css`); config in `assets/config.js`.
- Backend is a **Google Apps Script Web App** bound to the login spreadsheet (`apps-script/Code.gs`), which keeps passwords private and exposes a small JSON API. Deploy/contract docs: `apps-script/README.md`.
- **Feature flag:** the portal stays fully **inactive** while `assets/config.js` `API_URL` is empty — the site then behaves like the plain open Docsify site. It only activates when `API_URL` points to the deployed Apps Script.
- **Local testing without the real backend:** run a local mock implementing the same contract (see `apps-script/README.md`) and, in the browser console, `localStorage.setItem('qp_api_url','http://localhost:8787')` then reload. A local mock lives under `dev-mock/` which is git-ignored (contains test credentials — never commit real passwords; the repo is public).
