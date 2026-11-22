-- Run ONCE on an existing database (idempotent: CREATE ... IF NOT EXISTS):
--   npx wrangler d1 execute cosmiq --remote --file=migrations/0011_deleted_dives.sql
-- Dives a person deleted from their dive log. Only the fingerprint is kept (no dive data), so the same dive is not stored again when the dive computer
-- is synced, a file is imported again, or another person copies their log to this account.
CREATE TABLE IF NOT EXISTS deleted_dives (
  user_email  TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  deleted_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_email, fingerprint)
);
