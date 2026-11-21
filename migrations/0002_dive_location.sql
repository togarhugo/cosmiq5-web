-- Run ONCE on an existing database (a fresh install already has the column via schema.sql):
--   npx wrangler d1 execute cosmiq --remote --file=migrations/0002_dive_location.sql
ALTER TABLE dives ADD COLUMN location TEXT;   -- free-text dive area, e.g. "Komodo"; NULL = not set
