-- Run ONCE on an existing database (idempotent: CREATE ... IF NOT EXISTS):
--   npx wrangler d1 execute cosmiq --remote --file=migrations/0003_account_area.sql

-- Account area: profile picture, regulator tracking, certification files.
-- Files and the picture are stored as base64 TEXT on purpose: the Worker never decodes them (free-plan CPU limit),
-- it only validates the first bytes and hands the text back to the browser.
CREATE TABLE IF NOT EXISTS profiles (
  user_email TEXT PRIMARY KEY,
  avatar     TEXT,                              -- "data:image/jpeg;base64,..." (256x256), NULL = none
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS regulators (
  user_email TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT '',
  baseline   INTEGER NOT NULL DEFAULT 0,        -- dives already on it when it was added / before the last reset
  since      TEXT NOT NULL DEFAULT '',          -- only dives that START after this device-local time count ('' = all)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS certs (
  id         TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  label      TEXT NOT NULL,                     -- e.g. "PADI Advanced Open Water"
  number     TEXT NOT NULL DEFAULT '',          -- certificate / diver number (optional)
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,                  -- bytes of the original file
  data       TEXT NOT NULL,                     -- base64
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS certs_by_user ON certs (user_email, created_at);
