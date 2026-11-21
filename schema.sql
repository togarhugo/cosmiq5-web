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
