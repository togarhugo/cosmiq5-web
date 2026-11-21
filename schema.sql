CREATE TABLE IF NOT EXISTS dives (
  user_email   TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,          -- 6 date/time bytes from the device header (hex)
  device_mac   TEXT,
  started_at   TEXT NOT NULL,          -- device-local time, no timezone (ISO-like)
  mode         TEXT,
  duration_sec INTEGER,
  max_depth_m  REAL,
  o2_percent   INTEGER,
  header_hex   TEXT NOT NULL,          -- raw 36-byte header: source of truth
  profile_hex  TEXT NOT NULL,          -- raw profile bytes: source of truth
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_email, fingerprint)
);
CREATE INDEX IF NOT EXISTS dives_by_time ON dives (user_email, started_at DESC);
