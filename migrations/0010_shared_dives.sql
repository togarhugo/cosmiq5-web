-- Run ONCE on an existing database:
--   npx wrangler d1 execute cosmiq --remote --file=migrations/0010_shared_dives.sql
-- A person can copy their own dive log into another person's account (Account > Share dives). The copies carry the sender's email in
-- `shared_from` ('' = a dive recorded on this person's own computers), so they can be told apart, ranked after the person's own computers and removed.
ALTER TABLE dives ADD COLUMN shared_from TEXT NOT NULL DEFAULT '';
