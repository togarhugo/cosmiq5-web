-- Run ONCE on an existing database (idempotent: CREATE ... IF NOT EXISTS):
--   npx wrangler d1 execute cosmiq --remote --file=migrations/0009_bt_reports.sql
-- Bluetooth reports and download logs that a person chooses to send to their own account (Bluetooth lab / Dive log > Bluetooth download), so a
-- failed attempt can be looked at afterwards. Plain text, private to the signed-in user, the newest 30 are kept.
CREATE TABLE IF NOT EXISTS bt_reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  kind       TEXT NOT NULL,                      -- 'lab' (the Bluetooth lab report) or 'download' (the download log)
  body       TEXT NOT NULL,                      -- the report text (max 200,000 characters)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bt_reports_by_user ON bt_reports (user_email, id);
