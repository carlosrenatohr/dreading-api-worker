-- One row per liturgical day. Arrays (lecturas, questions) are stored as JSON
-- text; date_raw is the UTC ISO date and the primary key (dedup by date).
CREATE TABLE IF NOT EXISTS readings (
  date_raw        TEXT PRIMARY KEY,          -- e.g. '2026-07-19T00:00:00Z'
  title           TEXT NOT NULL,
  date_title      TEXT,
  lecturas        TEXT NOT NULL DEFAULT '[]',
  message         TEXT,
  reflection      TEXT,
  kids_reflection TEXT,
  questions       TEXT DEFAULT '[]',
  image_url       TEXT,
  source_version  INTEGER NOT NULL DEFAULT 2,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_readings_date_raw ON readings (date_raw DESC);
