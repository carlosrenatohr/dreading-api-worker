// Pure helpers: no D1, no Hono — unit-tested directly.

export function isYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function clampPerPage(raw: string | null): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (Number.isNaN(n)) return 15;
  return Math.min(Math.max(n, 1), 100);
}

export function pageNum(raw: string | null): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isNaN(n) || n < 1 ? 1 : n;
}

// UTC cutoff `days` before `iso` (YYYY-MM-DD), as a full ISO-Z string to compare
// against date_raw lexically.
export function cutoffFrom(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return `${d.toISOString().slice(0, 10)}T00:00:00Z`;
}

function safeJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return (text as T) ?? fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// D1 row (arrays stored as JSON text) -> API reading (arrays parsed).
export function rowToReading(row: Record<string, unknown>) {
  return {
    date_raw: row.date_raw,
    title: row.title,
    date_title: row.date_title,
    lecturas: safeJson(row.lecturas, [] as unknown[]),
    message: row.message,
    reflection: row.reflection,
    kids_reflection: row.kids_reflection,
    questions: safeJson(row.questions, [] as unknown[]),
    image_url: row.image_url,
    source_version: row.source_version,
  };
}

// Incoming reading -> D1 column values (arrays serialized, defaults applied).
export function readingToRow(r: Record<string, any>) {
  return {
    date_raw: String(r.date_raw),
    title: r.title ?? '',
    date_title: r.date_title ?? null,
    lecturas: JSON.stringify(r.lecturas ?? []),
    message: r.message ?? null,
    reflection: r.reflection ?? null,
    kids_reflection: r.kids_reflection ?? null,
    questions: JSON.stringify(r.questions ?? []),
    image_url: r.image_url ?? null,
    source_version: r.source_version ?? 2,
  };
}
