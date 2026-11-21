-- Run ONCE on an existing database (a fresh install already has these columns via schema.sql):
--   npx wrangler d1 execute cosmiq --remote --file=migrations/0005_devices_and_latest_cert.sql
-- Which dive computer a dive came from ('cosmiq' = downloaded over Bluetooth; others are imported from a file).
-- Imported dives keep their decoded values and depth samples as JSON in `extra`; header_hex / profile_hex are empty for them.
ALTER TABLE dives ADD COLUMN device TEXT NOT NULL DEFAULT 'cosmiq';
ALTER TABLE dives ADD COLUMN extra TEXT;
-- The certification you pinned as "latest" ('' = work it out from the dates).
ALTER TABLE profiles ADD COLUMN latest_cert_id TEXT NOT NULL DEFAULT '';
