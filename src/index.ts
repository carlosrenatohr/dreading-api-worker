import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { cache } from 'hono/cache';
import { z } from 'zod';

import { isYmd, clampPerPage, pageNum, cutoffFrom, rowToReading, readingToRow } from './lib';
import { enrichReading } from './enrich';

interface Env {
  DB: D1Database;
  INGEST_TOKEN?: string;
  AI?: Ai;
  IMAGES?: R2Bucket;
  ANALYTICS?: AnalyticsEngineDataset;
  ADMIN_KEY?: string;
}

const COLS =
  'date_raw, title, date_title, lecturas, message, reflection, kids_reflection, questions, image_url, source_version';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

// Count each reading request (endpoint + country) in Workers Analytics Engine —
// before the cache middleware so cache hits are still counted. Privacy-first:
// no PII, just aggregate usage.
app.use('/api/v1/readings/*', async (c, next) => {
  const country = (c.req.raw as any).cf?.country || 'XX';
  const endpoint = new URL(c.req.url).pathname;
  c.env.ANALYTICS?.writeDataPoint({ blobs: [endpoint, country], doubles: [1], indexes: [endpoint] });
  await next();
});

// Cache read responses at the edge (Cache API — free, cuts D1 reads). Content is
// daily, so a short TTL is plenty; the daily write refreshes within the window.
app.get('/api/v1/readings/*', cache({ cacheName: 'dreading-readings', cacheControl: 'public, max-age=600' }));
app.get('/images/*', cache({ cacheName: 'dreading-images', cacheControl: 'public, max-age=86400' }));

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function latest(db: D1Database) {
  const row = await db.prepare(`SELECT ${COLS} FROM readings ORDER BY date_raw DESC LIMIT 1`).first();
  return row ? rowToReading(row) : null;
}

// Paginated list response: { data, total, per_page, page }.
async function paginated(c: any, whereSql: string, binds: unknown[]) {
  const url = new URL(c.req.url);
  const perPage = clampPerPage(url.searchParams.get('per_page'));
  const page = pageNum(url.searchParams.get('page'));
  const offset = (page - 1) * perPage;
  const db: D1Database = c.env.DB;

  const countRow = await db.prepare(`SELECT COUNT(*) AS n FROM readings ${whereSql}`).bind(...binds).first<{ n: number }>();
  const rows = await db
    .prepare(`SELECT ${COLS} FROM readings ${whereSql} ORDER BY date_raw DESC LIMIT ? OFFSET ?`)
    .bind(...binds, perPage, offset)
    .all();

  return c.json({
    data: rows.results.map((r) => rowToReading(r as Record<string, unknown>)),
    total: countRow?.n ?? 0,
    per_page: perPage,
    page,
  });
}

// Most recent reading (single object). Aliased at /readings (the index).
const latestHandler = async (c: any) => {
  const reading = await latest(c.env.DB);
  return reading ? c.json(reading) : c.json({ message: 'No readings yet.' }, 404);
};
app.get('/api/v1/readings', latestHandler);
app.get('/api/v1/readings/last', latestHandler);

app.get('/api/v1/readings/today', (c) => paginated(c, 'WHERE date_raw LIKE ?', [`${todayIso()}%`]));
app.get('/api/v1/readings/last_day', (c) => paginated(c, 'WHERE date_raw >= ?', [cutoffFrom(todayIso(), 1)]));
app.get('/api/v1/readings/last_week', (c) => paginated(c, 'WHERE date_raw >= ?', [cutoffFrom(todayIso(), 7)]));
app.get('/api/v1/readings/last_month', (c) => paginated(c, 'WHERE date_raw >= ?', [cutoffFrom(todayIso(), 30)]));

app.get('/api/v1/readings/date/:date', (c) => {
  const date = c.req.param('date');
  if (!isYmd(date)) {
    return c.json(
      { message: 'Invalid date. Expected format: Y-m-d (e.g. 2026-07-13).', errors: { date: ['The date does not match the format Y-m-d.'] } },
      422,
    );
  }
  return paginated(c, 'WHERE date_raw LIKE ?', [`${date}%`]);
});

app.all('/api/v2/readings', (c) => c.redirect('/api/v1/readings', 301));

// Ingest — how the scraper writes readings (dedup/upsert by date_raw). Guarded
// by a bearer token so only the scraper can write.
const ingestSchema = z.object({
  date_raw: z.string().min(1),
  title: z.string().optional(),
  date_title: z.string().nullish(),
  lecturas: z.array(z.any()).optional(),
  message: z.string().nullish(),
  reflection: z.string().nullish(),
  kids_reflection: z.string().nullish(),
  questions: z.array(z.any()).optional(),
  image_url: z.string().nullish(),
  source_version: z.number().optional(),
});

app.post('/api/ingest', async (c) => {
  const token = c.env.INGEST_TOKEN;
  if (!token || c.req.header('Authorization') !== `Bearer ${token}`) {
    return c.json({ message: 'Unauthorized' }, 401);
  }
  const parsed = ingestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ message: 'Invalid reading', errors: parsed.error.flatten().fieldErrors }, 422);
  }
  // Enrich at the edge via the Workers AI binding (no external token). The
  // scraper posts the raw reading; the Worker adds the reflection/kids/etc.
  // and a generated illustration stored in R2.
  const origin = new URL(c.req.url).origin;
  const reading = await enrichReading(c.env.AI as any, parsed.data, { images: c.env.IMAGES as any, origin });
  const row = readingToRow(reading);
  await c.env.DB.prepare(
    `INSERT INTO readings (date_raw, title, date_title, lecturas, message, reflection, kids_reflection, questions, image_url, source_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date_raw) DO UPDATE SET
       title=excluded.title, date_title=excluded.date_title, lecturas=excluded.lecturas,
       message=excluded.message, reflection=excluded.reflection, kids_reflection=excluded.kids_reflection,
       questions=excluded.questions, image_url=excluded.image_url, source_version=excluded.source_version`,
  )
    .bind(row.date_raw, row.title, row.date_title, row.lecturas, row.message, row.reflection, row.kids_reflection, row.questions, row.image_url, row.source_version)
    .run();
  return c.json({ ok: true, date_raw: row.date_raw });
});

// Minimal ops dashboard: content health from D1 (no external token). Traffic
// metrics live in Cloudflare Web Analytics + Analytics Engine (linked below).
app.get('/admin', async (c) => {
  if (c.env.ADMIN_KEY && new URL(c.req.url).searchParams.get('key') !== c.env.ADMIN_KEY) {
    return c.text('Unauthorized', 401);
  }
  const db = c.env.DB;
  const s: any = await db
    .prepare(
      `SELECT COUNT(*) n, MIN(date_raw) mn, MAX(date_raw) mx,
        SUM(CASE WHEN reflection IS NOT NULL AND reflection <> '' THEN 1 ELSE 0 END) refl,
        SUM(CASE WHEN image_url IS NOT NULL AND image_url <> '' THEN 1 ELSE 0 END) img,
        SUM(CASE WHEN COALESCE(json_array_length(lecturas), 0) >= 4 THEN 1 ELSE 0 END) feasts
       FROM readings`,
    )
    .first();
  const recent = await db
    .prepare(`SELECT date_raw, title, image_url, reflection FROM readings ORDER BY date_raw DESC LIMIT 12`)
    .all();
  const n = s?.n || 0;
  const pct = (v: number) => (n ? Math.round((v / n) * 100) : 0);
  const esc = (t: unknown) => String(t ?? '').replace(/</g, '&lt;');
  const tile = (label: string, value: string) =>
    `<div class="tile"><div class="v">${value}</div><div class="l">${label}</div></div>`;
  const rows = (recent.results as any[])
    .map(
      (r) => `<tr>
        <td>${esc(r.date_raw).slice(0, 10)}</td>
        <td>${r.image_url ? `<img src="${esc(r.image_url)}" alt="">` : '—'}</td>
        <td>${esc(r.title).slice(0, 60)}</td>
        <td>${r.reflection ? '✓' : '—'}</td></tr>`,
    )
    .join('');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>DReading · panel</title>
<style>
  :root{--bg:#14172a;--panel:#1b1f36;--ink:#ece9e0;--muted:#9aa0b6;--accent:#6bbd93;--line:#2b3052}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--ink);font:16px system-ui,sans-serif;padding:2rem 1.25rem}
  .wrap{max-width:60rem;margin:0 auto}
  h1{font-size:1.4rem;margin:0 0 .25rem} .sub{color:var(--muted);margin:0 0 1.5rem}
  .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.8rem;margin-bottom:1.5rem}
  .tile{background:var(--panel);border:1px solid var(--line);border-radius:1rem;padding:1rem}
  .tile .v{font-size:1.7rem;font-weight:700;color:var(--accent)} .tile .l{color:var(--muted);font-size:.85rem}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:1rem;overflow:hidden}
  th,td{text-align:left;padding:.6rem .8rem;border-bottom:1px solid var(--line);font-size:.9rem}
  th{color:var(--muted);text-transform:uppercase;font-size:.72rem;letter-spacing:.05em}
  td img{height:34px;width:51px;object-fit:cover;border-radius:.3rem;display:block}
  a{color:var(--accent)} .links{margin:1.5rem 0;color:var(--muted);font-size:.9rem}
</style></head><body><div class="wrap">
  <h1>DReading · panel de contenido</h1>
  <p class="sub">Salud de la ingesta (D1). El tráfico (lecturas/día, país, vitals) vive en Web Analytics + Analytics Engine.</p>
  <div class="tiles">
    ${tile('Lecturas', String(n))}
    ${tile('Desde', esc(s?.mn).slice(0, 10) || '—')}
    ${tile('Hasta', esc(s?.mx).slice(0, 10) || '—')}
    ${tile('Con reflexión', pct(s?.refl || 0) + '%')}
    ${tile('Con imagen', pct(s?.img || 0) + '%')}
    ${tile('Domingos/fiestas', String(s?.feasts || 0))}
  </div>
  <table><thead><tr><th>Fecha</th><th>Arte</th><th>Título</th><th>IA</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="links">Tráfico: <a href="https://dash.cloudflare.com/${''}?to=/:account/web-analytics">Web Analytics</a> ·
  Eventos por endpoint/país: <a href="https://dash.cloudflare.com">Analytics Engine (dataset dreading_events)</a></p>
</div></body></html>`;
  return c.html(html);
});

// Serve the daily illustrations stored in R2, cached at the edge.
app.get('/images/:key', async (c) => {
  if (!c.env.IMAGES) return c.notFound();
  const obj = await c.env.IMAGES.get(c.req.param('key'));
  if (!obj) return c.notFound();
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'image/png',
      'cache-control': 'public, max-age=86400',
    },
  });
});

export default app;
