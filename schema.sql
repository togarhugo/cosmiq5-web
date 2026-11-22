CREATE TABLE IF NOT EXISTS dives (
  user_email   TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,          -- 6 date/time bytes from the device header (hex)
  device_mac   TEXT,
  started_at   TEXT NOT NULL,          -- device-local time, no timezone (ISO-like)
  mode         TEXT,
  duration_sec INTEGER,
  max_depth_m  REAL,
  o2_percent   INTEGER,
  header_hex   TEXT NOT NULL,          -- raw 36-byte header: source of truth
  profile_hex  TEXT NOT NULL,          -- raw profile bytes: source of truth
  location     TEXT,                   -- free-text dive area ("Komodo"); NULL = not set
  device       TEXT NOT NULL DEFAULT 'cosmiq',  -- which dive computer: 'cosmiq' (Bluetooth) or an imported one ('peregrine')
  extra        TEXT,                   -- imported dives: decoded values + depth samples as JSON (header_hex/profile_hex are empty)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_email, fingerprint)
);
CREATE INDEX IF NOT EXISTS dives_by_time ON dives (user_email, started_at DESC);

-- Email + password + authenticator (TOTP) sign-in. The password is stretched in the browser
-- (PBKDF2); the server only stores an HMAC of the result, keyed with a secret pepper.
CREATE TABLE IF NOT EXISTS users (
  email           TEXT PRIMARY KEY,
  salt            TEXT NOT NULL,        -- hex, random per user (used by the browser KDF)
  kdf_iter        INTEGER NOT NULL,
  pw_hash         TEXT NOT NULL,        -- hex HMAC-SHA256(pepper, derived key)
  totp_secret_enc TEXT NOT NULL,        -- AES-GCM encrypted with DATA_KEY
  totp_last_step  INTEGER NOT NULL DEFAULT 0,  -- replay protection
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS enrollments (   -- authenticator secret waiting for its first valid code
  email      TEXT PRIMARY KEY,
  secret_enc TEXT NOT NULL,
  expires    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_attempts ( -- failed-login counters (per email and per IP)
  k       TEXT PRIMARY KEY,
  n       INTEGER NOT NULL,
  until   INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL
);

-- Account area: profile picture, regulator tracking, certification files.
-- Files and the picture are stored as base64 TEXT on purpose: the Worker never decodes them (free-plan CPU limit),
-- it only validates the first bytes and hands the text back to the browser.
CREATE TABLE IF NOT EXISTS profiles (
  user_email TEXT PRIMARY KEY,
  avatar     TEXT,                              -- "data:image/jpeg;base64,..." (256x256), NULL = none
  full_name  TEXT NOT NULL DEFAULT '',          -- shown on the Summary
  dan_number TEXT NOT NULL DEFAULT '',          -- DAN member number
  dan_plan   TEXT NOT NULL DEFAULT '',          -- membership / plan name
  dan_valid_until TEXT NOT NULL DEFAULT '',     -- YYYY-MM-DD, '' = not set
  latest_cert_id TEXT NOT NULL DEFAULT '',      -- certification pinned as "latest" ('' = work it out from the dates)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS regulators (
  user_email TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT '',
  baseline   INTEGER NOT NULL DEFAULT 0,        -- dives already on it when it was added / before the last reset
  since      TEXT NOT NULL DEFAULT '',          -- only dives that START after this device-local time count ('' = all)
  serviced   TEXT NOT NULL DEFAULT '',          -- 'YYYY-MM' of the last service, '' = not set
  limit_dives  INTEGER NOT NULL DEFAULT 90,     -- service every N dives; 0 = no dive reminder
  limit_months INTEGER NOT NULL DEFAULT 12,     -- service every N months; 0 = no time reminder
  history    TEXT NOT NULL DEFAULT '[]',        -- JSON: [{m, dives, at}] of past services, newest first, at most 20
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS certs (
  id         TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  label      TEXT NOT NULL,                     -- e.g. "PADI Advanced Open Water"
  number     TEXT NOT NULL DEFAULT '',          -- certificate / diver / policy number (optional)
  kind       TEXT NOT NULL DEFAULT 'cert',      -- 'cert' = dive certification, 'dan' = DAN insurance document
  certified_on TEXT NOT NULL DEFAULT '',        -- YYYY-MM-DD the certification was earned (optional)
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,                  -- bytes of the original file
  data       TEXT NOT NULL,                     -- base64
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS certs_by_user ON certs (user_email, created_at);

-- Where each dive place is on the map (see migrations/0006_places.sql).
CREATE TABLE IF NOT EXISTS places (
  user_email TEXT NOT NULL,
  k          TEXT NOT NULL,                 -- lower-case place name
  name       TEXT NOT NULL,                 -- the spelling you use
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_email, k)
);

-- API keys for reading the dive log from other tools (see migrations/0007_api_keys.sql). Only a hash of each key is stored.
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_email   TEXT NOT NULL,
  description  TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  ttl_days     INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT,
  last_used_at TEXT,
  revoked_at   TEXT,
  rotated_from TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_by_user ON api_keys (user_email, created_at);

-- Bluetooth reports / download logs a person sends to their own account (see migrations/0009_bt_reports.sql)
CREATE TABLE IF NOT EXISTS bt_reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  kind       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bt_reports_by_user ON bt_reports (user_email, id);
