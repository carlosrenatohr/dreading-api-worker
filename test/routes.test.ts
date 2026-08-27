import { describe, it, expect, vi } from 'vitest';
import app from '../src/index';

// ---------------------------------------------------------------------------
// Helpers — fake D1 + bindings
// ---------------------------------------------------------------------------

const FAKE_READING = {
  date_raw: '2026-08-26T00:00:00Z',
  title: 'Martes XX Ordinary Time',
  date_title: '26 de agosto',
  lecturas: JSON.stringify([
    { title: 'First Reading', content: '...' },
    { title: 'Gospel', content: 'En aquel tiempo...' },
  ]),
  message: 'Beatitude of the day',
  reflection: 'Daily reflection',
  kids_reflection: 'Kids version',
  questions: JSON.stringify(['Q1?', 'Q2?']),
  image_url: 'https://r2.example.com/2026-08-26.png',
  source_version: 1,
};

function fakeDb(rows: unknown[] = [FAKE_READING]) {
  // D1 mock: prepare() returns a statement; statement.first() returns one row;
  // statement.bind(...).first() returns one row; statement.bind(...).all() returns rows.
  const statement = {
    first: vi.fn().mockResolvedValue(rows[0] ?? null),
    all: vi.fn().mockResolvedValue({ results: rows }),
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({}),
  };
  return {
    prepare: vi.fn().mockReturnValue(statement),
  } as unknown as D1Database;
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    DB: fakeDb(),
    INGEST_TOKEN: 'test-token',
    AI: { run: async () => ({}) },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /api/v1/readings (latest, single object)
// ---------------------------------------------------------------------------

describe('GET /api/v1/readings', () => {
  it('returns a single reading object', async () => {
    const res = await app.request('/api/v1/readings', undefined, env());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.date_raw).toBe('2026-08-26T00:00:00Z');
    expect(body.title).toBeTruthy();
  });

  it('returns 404 when no readings exist', async () => {
    const res = await app.request('/api/v1/readings', undefined, env({ DB: fakeDb([]) }));
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/readings/last (alias for latest)
// ---------------------------------------------------------------------------

describe('GET /api/v1/readings/last', () => {
  it('returns a single reading object', async () => {
    const res = await app.request('/api/v1/readings/last', undefined, env());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.date_raw).toBeTruthy();
    expect(body.lecturas).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/readings/today (paginated envelope)
// ---------------------------------------------------------------------------

describe('GET /api/v1/readings/today', () => {
  it('returns a paginated envelope with data array', async () => {
    const res = await app.request('/api/v1/readings/today', undefined, env());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(typeof body.per_page).toBe('number');
    expect(typeof body.page).toBe('number');
  });

  it('supports per_page and page params', async () => {
    const res = await app.request('/api/v1/readings/today?per_page=5&page=2', undefined, env());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.per_page).toBe(5);
    expect(body.page).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/readings/date/:date
// ---------------------------------------------------------------------------

describe('GET /api/v1/readings/date/:date', () => {
  it('returns paginated envelope for a valid date', async () => {
    const res = await app.request('/api/v1/readings/date/2026-08-26', undefined, env());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('returns 422 for an invalid date format', async () => {
    const res = await app.request('/api/v1/readings/date/not-a-date', undefined, env());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.message).toContain('Invalid date');
  });

  it('returns empty data for a date with no readings', async () => {
    const res = await app.request('/api/v1/readings/date/2000-01-01', undefined, env({ DB: fakeDb([]) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/readings/last_week, last_month, last_day
// ---------------------------------------------------------------------------

describe('date-range endpoints', () => {
  it('GET /last_week returns paginated envelope', async () => {
    const res = await app.request('/api/v1/readings/last_week', undefined, env());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('GET /last_month returns paginated envelope', async () => {
    const res = await app.request('/api/v1/readings/last_month', undefined, env());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('GET /last_day returns paginated envelope', async () => {
    const res = await app.request('/api/v1/readings/last_day', undefined, env());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/ingest
// ---------------------------------------------------------------------------

describe('POST /api/ingest', () => {
  const validPayload = {
    date_raw: '2026-08-26T00:00:00Z',
    title: 'Test Reading',
    lecturas: [{ title: 'Gospel', content: 'En aquel tiempo...' }],
  };

  it('returns 401 without a bearer token', async () => {
    const res = await app.request('/api/ingest', {
      method: 'POST',
      body: JSON.stringify(validPayload),
      headers: { 'content-type': 'application/json' },
    }, env());
    expect(res.status).toBe(401);
  });

  it('returns 401 with a wrong token', async () => {
    const res = await app.request('/api/ingest', {
      method: 'POST',
      body: JSON.stringify(validPayload),
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
    }, env());
    expect(res.status).toBe(401);
  });

  it('returns 200 with a valid token and payload', async () => {
    const res = await app.request('/api/ingest', {
      method: 'POST',
      body: JSON.stringify(validPayload),
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    }, env());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.date_raw).toBe('2026-08-26T00:00:00Z');
  });

  it('returns 422 for invalid payload', async () => {
    const res = await app.request('/api/ingest', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-token' },
    }, env());
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v2/readings (redirect)
// ---------------------------------------------------------------------------

describe('GET /api/v2/readings', () => {
  it('redirects 301 to /api/v1/readings', async () => {
    const res = await app.request('/api/v2/readings', undefined, env());
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toContain('/api/v1/readings');
  });
});
