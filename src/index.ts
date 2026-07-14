import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';

import { isYmd, clampPerPage, pageNum, cutoffFrom, rowToReading, readingToRow } from './lib';
import { enrichReading } from './enrich';

interface Env {
  DB: D1Database;
  INGEST_TOKEN?: string;
  AI?: Ai;
}

const COLS =
  'date_raw, title, date_title, lecturas, message, reflection, kids_reflection, questions, image_url, source_version';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

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
  const reading = await enrichReading(c.env.AI as any, parsed.data);
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

export default app;
