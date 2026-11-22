-- Run ONCE on an existing database (a fresh install already has these columns via schema.sql):
--   npx wrangler d1 execute cosmiq --remote --file=migrations/0008_regulator_service.sql
-- Regulator service: the month of the last service, two reminder limits (dives and months) and a short history of services.
-- Existing regulators keep working as before: 90 dives, 12 months, and no time reminder until a service month is set.
ALTER TABLE regulators ADD COLUMN serviced TEXT NOT NULL DEFAULT '';          -- 'YYYY-MM' of the last service, '' = not set
ALTER TABLE regulators ADD COLUMN limit_dives INTEGER NOT NULL DEFAULT 90;    -- service every N dives; 0 = no dive reminder
ALTER TABLE regulators ADD COLUMN limit_months INTEGER NOT NULL DEFAULT 12;   -- service every N months; 0 = no time reminder
ALTER TABLE regulators ADD COLUMN history TEXT NOT NULL DEFAULT '[]';         -- JSON: [{m: 'YYYY-MM', dives, at: 'YYYY-MM-DD'}], newest first, at most 20
