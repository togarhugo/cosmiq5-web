-- Run ONCE on an existing database (a fresh install already has these columns via schema.sql):
--   npx wrangler d1 execute cosmiq --remote --file=migrations/0004_dan_and_names.sql
ALTER TABLE profiles ADD COLUMN full_name TEXT NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN dan_number TEXT NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN dan_plan TEXT NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN dan_valid_until TEXT NOT NULL DEFAULT '';
ALTER TABLE certs ADD COLUMN kind TEXT NOT NULL DEFAULT 'cert';
ALTER TABLE certs ADD COLUMN certified_on TEXT NOT NULL DEFAULT '';
