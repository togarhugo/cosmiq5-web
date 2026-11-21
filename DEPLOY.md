# Cosmiq Manager: deploy guide

Mobile-friendly web app for the Deepblu Cosmiq+ Gen 5 dive computer: settings, **clock set to phone time on
every connect**, **dive-log download**, cloud storage behind **Google sign-in**. Version is shown in the app
footer (single source of truth: `version` in `package.json`).

```
phone/laptop browser --BLE--> dive computer
        |  https, Google sign-in handled by the Worker itself
        v
 Worker (session cookie, allow-list) --> D1 database (dives)
```

## Browser support
| Platform | Works with |
|---|---|
| Android, Windows, macOS, Linux | Chrome / Edge |
| iPhone / iPad | **Bluefy** browser only (Safari and Chrome on iOS have no Web Bluetooth). The saved dive log can be viewed in any browser. |

## Sign-in
The first page is a login page with two choices:

1. **Continue with Google** - Google OAuth (authorization code + PKCE) inside the Worker, like the other thmlab apps.
2. **Email + password**, followed by a **second page with six boxes for the authenticator code** (Google Authenticator and
   compatible TOTP apps). The password is stretched in the browser (PBKDF2-SHA256, 600,000 iterations) so the server never
   sees it and verifying a login costs almost no CPU on the free plan. After the password step the server sets a 5-minute
   signed "password ok" cookie that is only good for the code page; the password alone never signs anyone in. The
   authenticator secret is stored AES-GCM encrypted with `DATA_KEY`; the password verifier is an HMAC keyed with a pepper
   derived from `DATA_KEY`.

Both give the same 30-day HttpOnly session cookie, and only emails in `ALLOWED_EMAILS` can sign in either way.
Pages redirect to the login page; the API returns 401. If any required setting is missing the Worker answers 503
to everything (fails closed).

**Turning on email login** (no open sign-up, so nobody can claim your address): sign in with Google once, open the
**Account** tab, choose a password (12+ characters), scan the QR code with Google Authenticator, enter the 6-digit code.
Changing or removing it later needs a current authenticator code. After 5 failed attempts an email is locked for
15 minutes (20 per IP). Removing someone from `ALLOWED_EMAILS` disables both methods for them.

**Lost phone / authenticator?** Sign in with Google and use the Account tab to set it up again (needs your current
code), or delete the row: `npx wrangler d1 execute cosmiq --remote --command "DELETE FROM users WHERE email='you@gmail.com'"`.

## One-time setup
Needs Node 20+, `thmlab.org` on your Cloudflare account, and a Google OAuth client.

```bash
npm install
npx wrangler login
npx wrangler d1 create cosmiq               # put database_id into wrangler.toml
npx wrangler d1 execute cosmiq --remote --file=schema.sql   # safe to re-run: IF NOT EXISTS
```
1. **Google Cloud Console** > Credentials > your OAuth client > add authorized redirect URI
   `https://dive-comp.thmlab.org/auth/callback`.
2. Put the client ID in `wrangler.toml` (`GOOGLE_CLIENT_ID`).
3. Secrets:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET      # openssl rand -hex 32
   npx wrangler secret put ALLOWED_EMAILS      # you@gmail.com[,other@gmail.com]
   npx wrangler secret put DATA_KEY            # openssl rand -hex 32  (never change it: it protects stored authenticator secrets)
   ```
4. Deploy (builds the bundled app + version first):
   ```bash
   npm run deploy
   ```

## Releasing a new version
Bump `version` in `package.json`, then `npm run deploy`. The footer shows the version and warns when the server
has a newer one than the loaded page; the offline cache is keyed by version so phones pick up the update.

## First connect
Open the site, sign in with Google, tap **Connect**. The clock is set to your phone's time, then new dives
download and upload. Tap **Download raw backup** after the first sync.

## Dive sync notes
- **Only new dives are downloaded.** Headers are scanned from the newest dive and the scan stops at the first dive you
  already have, so syncing a few new dives takes seconds. If that leaves a gap, or you tap **Re-check every dive**, every
  header is checked. New dives are fetched oldest first and each is saved the moment it arrives (and uploaded at the end),
  so a dropped connection or **Cancel** loses at most the dive in flight; running the sync again continues.
- Progress shows on every tab. After a sync that saved dives the app switches to the **Dive log** tab, grouped by year.
- **Copy / Save diagnostics** (Dive log tab) exports the app version, device traffic and stored dive headers: attach it when
  reporting a problem. Each dive's **Technical details** shows the raw 36-byte header with undecoded bytes highlighted.

### Summary, locations and setting changes
- **Summary tab** (opens first): the date of your last dive (and how long ago, and where) and your total dive time.
- **Locations** are free text, just the area (Banda, Komodo, Tulamben), one per date. After every sync that brings in new
  dives the app asks "Where did you dive?" with one row per date (oldest first, **same** repeats the row above; places you
  used before are suggested, and a date that already has a place is pre-filled). Each date header in the log has a chip to
  add or change the place for that day, each dive has its own field, and a banner offers to fill in dives that have none.
  Locations are saved on the phone first and sent to the cloud (`POST /api/dives/location`).
- **Changing a setting** on the dive computer shows "Applying...", then reads the value back from the device and confirms
  ("Backlight set to level 3"), or says the device did not apply or rejected it. The clock cannot be read back, so its
  message only says it was sent and not rejected.

### Upgrading an existing database
Run each new migration once, **before** deploying the Worker that needs it (fresh installs already have it via `schema.sql`):
```bash
npx wrangler d1 execute cosmiq --remote --file=migrations/0002_dive_location.sql   # adds dives.location
```

### What the dive computer actually stores (decoded from a real Cosmiq+ Gen 5 with 106 dives)
Header (36 bytes): 0-1 dive number, 2 mode, 3 O2 %, 4-5 surface pressure (13 bits) + 3 flag bits, 6-11 date/time,
12-13 duration, 22-23 max depth (raw pressure), **24-25 minimum temperature (0.1 C)**, 26 sample interval,
**28-29 number of profile samples, 30-31 / 32-33 first / last profile page**. Bytes 14-21, 27 and 34-35 are still unknown
(constants / a 16-bit value). **There is no location (GPS) field.** Profile samples are 4 bytes: temperature (0.1 C) and
pressure (mbar).

**The profile memory is a ring of 256 pages (512 bytes each, 2 pages per dive: about the last 128 dives).** Writes wrap
around and erase the oldest dives, but the device can only read pages 0-255, so a dive stored at page 256 or above reads
back as erased bytes (0xFF) under its own number, while its real data is returned under the oldest dive's number. The app
matches every profile to the dive whose header it fits (sample count, minimum temperature, maximum depth, nothing but
erased bytes after the last sample), recovers the wrapped dives, and marks dives whose profile was overwritten as
"summary only" (their depth, time and temperature survive in the header). A dive that is longer than the older dive whose
slot it occupies loses the tail of its profile ("partial profile"). To keep profiles of new dives, sync before the ring
wraps over them: each new dive overwrites an old one.

## Develop / test
```bash
npm test               # protocol, Google + password/TOTP sign-in, API, locations, summary helpers (build runs first)
node test/e2e.mjs      # mobile browser e2e against a simulated dive computer (needs Playwright)
node test/e2e-real.mjs # real Worker + local D1 + browser: Account setup and password/TOTP login
                       # (needs a .dev.vars with the secrets above and `npx wrangler dev --local --port 8799`)
```

## Safety
Unofficial software. Always verify settings on the dive computer before diving. Dive-log protocol reimplemented from
the public description in libdivecomputer's `deepblu_cosmiq` driver (LGPL-2.1+, (C) Linus Torvalds, Jef Driesen);
verified only against a simulator until tested on real hardware.
