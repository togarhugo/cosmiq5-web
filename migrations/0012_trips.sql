-- Run ONCE on an existing database (idempotent: CREATE ... IF NOT EXISTS):
--   npx wrangler d1 execute cosmiq --remote --file=migrations/0012_trips.sql
-- Dive trips (title, dates, packing lists with weights). One row per trip; `data` is the trip as JSON, cleaned and size-limited by src/trips.js.
CREATE TABLE IF NOT EXISTS trips (
  user_email TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_email, id)
);
