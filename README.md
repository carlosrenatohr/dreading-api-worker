# dreading-api-worker

Cloudflare **Worker (Hono + D1)** serving the Catholic daily readings — the edge-native, zero-cost API for the DReading platform. Replaces the Laravel `dreading-api` (kept as reference); same endpoints, so `dreading-web` works unchanged.

> **Status — MVP.** Reads readings from **D1** (Cloudflare's SQLite) and exposes the same reading endpoints as before, plus a guarded `POST /api/ingest` that the scraper uses to write. Runs and tests fully **locally** (miniflare) with no Cloudflare account.

## Why this stack
Read-heavy, write-daily, identical-per-day content = ideal for the edge. Workers run globally; D1 is native (no external DB round-trips); the daily payload can be edge-cached so reads rarely touch D1. Cost stays ~€0 well into scale.

## Endpoints
Base `/api`. Reads are public + CORS-open (for the PWA).

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/v1/readings` · `/api/v1/readings/last` | most recent reading (object) |
| GET | `/api/v1/readings/today` | today's reading(s), paginated |
| GET | `/api/v1/readings/date/{Y-m-d}` | readings for a date, paginated (422 if not `Y-m-d`) |
| GET | `/api/v1/readings/last_day` · `last_week` · `last_month` | recent window, paginated |
| ANY | `/api/v2/readings` | 301 → `/api/v1/readings` |
| POST | `/api/ingest` | upsert a reading (needs `Authorization: Bearer $INGEST_TOKEN`) |

Lists return `{ data, total, per_page, page }` (`?per_page=` 1–100, default 15; `?page=`).

## Run locally (no Cloudflare account)
```bash
npm install
cp .dev.vars.example .dev.vars       # INGEST_TOKEN for /api/ingest
npm run migrate:local                # apply migrations to a local D1
npm run dev                          # wrangler dev on http://localhost:8787
```
Seed one reading and read it back:
```bash
curl -XPOST localhost:8787/api/ingest -H "Authorization: Bearer dev-ingest-token" \
  -H 'content-type: application/json' \
  -d '{"date_raw":"2026-07-19T00:00:00Z","title":"Domingo XVI","lecturas":[{"title":"Evangelio","content":"..."}],"reflection":"..."}'
curl localhost:8787/api/v1/readings/last
```

## Test
```bash
npm test        # vitest — pure logic (dates, pagination, row (de)serialization)
```
End-to-end is verified by running `wrangler dev` + curl (above).

## Deploy (needs your Cloudflare account)
```bash
npx wrangler login
npx wrangler d1 create dreading           # copy the database_id into wrangler.jsonc
npm run migrate:remote
npm run deploy
npx wrangler secret put INGEST_TOKEN      # the scraper's write token
```
Point `dreading-web` at the deployed Worker URL (`?api=` or `config.js`).
