# xefig

Single Cloudflare Worker puzzle platform.

## Prerequisites

- **Node.js** v18 or later
- **npm** (ships with Node)
- A **Cloudflare** account (for deployment; not needed for local dev)

## Install

```bash
git clone <repo-url> xefig
cd xefig
npm install
```

This installs dependencies for both workspaces (`apps/worker` and `apps/web`).

## Local development

```bash
npm run dev
```

This builds the web app then starts a local Wrangler dev server with simulated
Cloudflare bindings (R2, KV, D1). The site is served at
`http://localhost:8787` by default.

To run only the Vite frontend dev server (hot-reload, no worker):

```bash
npm run web:dev
```

The Vite server starts at `http://localhost:5173`.

## Project layout

- `apps/worker`: Cloudflare Worker runtime (API, admin portal, R2/KV/D1 bindings, static asset serving)
- `apps/web`: Vite web app (launcher + puzzle gameplay UI)
- `apps/messages`: archived legacy encrypted message-board app (not used by deploy)

## Commands

From repo root:

- `npm run dev`: build web app and run Worker locally
- `npm run deploy:dry`: build web app and run Wrangler dry-run deploy
- `npm run deploy`: build web app and deploy Worker
- `npm run web:dev`: run Vite dev server only

## Deploy

1. `npx wrangler login`
2. Ensure bindings in `apps/worker/wrangler.toml` exist in your Cloudflare account:
   - R2 bucket: `assets`
   - KV namespace id for `metadata`
   - D1 database for `DB`
3. `cd apps/worker`
4. `npx wrangler secret put ADMIN_PASSWORD --config wrangler.toml`
5. Optional prompt rewriter in admin prompt generation:
   - `npx wrangler secret put OPENROUTER_API_KEY --config wrangler.toml`
   - Optional model override (must be a free-capable OpenRouter model id):
     `npx wrangler secret put OPENROUTER_MODEL --config wrangler.toml`
   - If `OPENROUTER_MODEL` is not set, the worker defaults to `openrouter/free`.
6. `cd ../.. && npm run deploy`

## Runtime URLs

- Puzzle game: `/`
- Admin portal: `/admin` (redirects to `/admin-portal`)
- Health check: `/api/health`
