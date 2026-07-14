# CLAUDE.md — dreading-api-worker

Cloudflare Worker (Hono + zod + D1) serving the daily readings. Edge-native replacement for the Laravel `dreading-api` (kept as reference). Sibling repos: `dreading-scrape` (writes via `POST /api/ingest`), `dreading-web` (reads), `dreading-bot`.

## Engineering (harness flow)
- Conventional commits, one logical unit per commit. Test-first for non-trivial logic.
- **Gate before commit**: `npm test` (vitest) green + `wrangler dev` boots and the endpoints answer (curl acceptance).
- Minimal, useful comments; no dead code / stray TODOs / unused code.

## Structure
- `src/index.ts` — Hono app + routes (reads + guarded `/api/ingest`).
- `src/lib.ts` — pure helpers (date validation, pagination, row↔reading JSON), unit-tested in `test/`.
- `migrations/` — D1 SQL migrations (`readings` table). `wrangler.jsonc` binds D1 as `DB`.

## Commands
- `npm run migrate:local` then `npm run dev` — local D1 + Worker (miniflare, no CF account).
- `npm test` — vitest. Deploy: see README (needs `wrangler login` + a real D1 `database_id`).

## Notes
- `date_raw` is UTC ISO (`YYYY-MM-DDT00:00:00Z`), primary key (dedup). Lists paginate; `/last` is a single object — matches what `dreading-web` expects.
- `/api/ingest` requires `Authorization: Bearer $INGEST_TOKEN`.
