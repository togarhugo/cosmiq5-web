-- Run ONCE on an existing database (idempotent: CREATE ... IF NOT EXISTS):
--   npx wrangler d1 execute cosmiq --remote --file=migrations/0007_api_keys.sql
-- API keys for reading the dive log from other tools (read-only). Only a SHA-256 hash of each key is stored: the key itself is shown once, when it is made.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,                -- 16 hex: the handle the account page uses (not secret, cannot be used to read data)
  user_email   TEXT NOT NULL,
  description  TEXT NOT NULL,                   -- what the key is for, e.g. "Home dashboard"
  prefix       TEXT NOT NULL,                   -- first 10 characters of the key, to recognise it in the list
  key_hash     TEXT NOT NULL UNIQUE,            -- hex SHA-256 of the whole key
  ttl_days     INTEGER,                         -- 7, 14 or 30; NULL = unlimited (a rotation gives a new key the same lifetime)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT,                            -- NULL = never
  last_used_at TEXT,                            -- updated at most once an hour
  revoked_at   TEXT,
  rotated_from TEXT                             -- id of the key this one replaced
);
CREATE INDEX IF NOT EXISTS api_keys_by_user ON api_keys (user_email, created_at);
