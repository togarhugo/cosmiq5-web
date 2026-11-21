-- Run ONCE on an existing database (idempotent: CREATE ... IF NOT EXISTS):
--   npx wrangler d1 execute cosmiq --remote --file=migrations/0006_places.sql
-- Where each dive place is on the map. A place is the free-text dive location you already type ("Tulamben"); `k` is its
-- lower-case form so "tulamben" and "Tulamben" are one place. Dives are not changed: only places get coordinates.
CREATE TABLE IF NOT EXISTS places (
  user_email TEXT NOT NULL,
  k          TEXT NOT NULL,
  name       TEXT NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_email, k)
);
