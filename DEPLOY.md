# Dive Manager: deploy guide

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

### Account area (the avatar at the top right)
- **Profile picture:** cropped to a 256x256 JPEG in the browser and stored in your account; the header and Account page show it.
- **Change password:** needs the current password and a current authenticator code; the authenticator stays the same
  (**Reset authenticator** is the separate flow that shows a new QR code).
- **Dive certifications:** upload a PDF/JPEG/PNG/WebP of a card (up to 1 MB; photos are shrunk automatically), with a name and an
  optional certificate number. View, Save or Share it later, e.g. when registering for a dive. Up to 12 files. The server checks
  the file's real type (first bytes), never serves it back as a web page, and only the owner can read it.
- **Your name** (Profile section; the Google name is suggested) and **DAN insurance** (member number, plan, valid-until date, plus
  uploads of your card or policy, kept apart from the certification files). **Certifications** take an optional date earned.
- **Summary, top card:** your name, your **latest certification** (the newest date earned; files without a date only count when none
  has one) and your **DAN membership with its validity**: green while valid, orange within 60 days of expiry, red once expired.
- **Regulator:** name, type and a starting count. It counts your scuba and gauge dives (not freedives) that began after the last
  reset, and updates itself on every sync. The Summary card is green below 70 dives, **orange from 70, red from 90**. "Reset to 0"
  starts counting again after your latest logged dive. One regulator is tracked.
- **Help / app version:** the version lives only here (and on the sign-in pages); "Check for update" clears the cached copy and reloads.
- **Month bulk locations:** each month in the dive log has "Set place for the month"; the location question after a sync also has a
  "whole month" box above the dates of each month (a date's own entry wins).

Binary data (the picture, certification files) is stored as base64 text and the Worker never decodes it, which keeps requests far below
the free plan's CPU limit.

- **Second dive computer (Shearwater Peregrine):** dives carry a `device` column (`cosmiq` default, `peregrine`). Imported dives have no raw
  bytes: `header_hex`/`profile_hex` are empty and their decoded values + depth samples are JSON in `extra` (the Worker stores it as text,
  never parses it, caps it at 120 KB per dive and 700 KB per request). The file is parsed in the browser (UDDF, `public/dive-import.js`);
  the fingerprint is a hash of device + start minute so re-importing adds nothing. Totals de-duplicate overlapping dives from two devices.
- **Peregrine from a Shearwater Cloud database (`public/sqlite-lite.js`, `public/shearwater-cloud.js`):** the export is a SQLite file (or a ZIP with `dive_data.db`).
  A small read-only SQLite reader (table b-trees, overflow pages, bounds-checked) lists `log_data`; each `data_bytes_1` is a 4-byte little-endian size + gzip
  (browser `DecompressionStream`, trailing junk tolerated) of the same Petrel Native Format records as over Bluetooth, decoded by `Shearwater.parseDive`;
  `dive_details.DiveNumber` gives the logbook number; `DeletedLogs` and rows whose `format` is not `sw-pnf` are skipped. Layout taken from third-party readers
  (divejson-py, divelog, Subsurface issue #4788), tested on databases written by real SQLite, **not yet on a real Shearwater Cloud export**.
- **Peregrine over Bluetooth (experimental, `public/shearwater.js`):** a port of libdivecomputer's Shearwater protocol (LGPL-2.1+, Jef Driesen):
  GATT service `fe25c237-0ece-443c-b0aa-e02033e7029d`; the characteristic that can notify and be written is used (found at run time, as Subsurface does);
  SLIP framing over 20-byte writes with a 2-byte `[frames, index]` header; requests `FF 01 len+1 00 ...`; RDBI `0x22` (serial 0x8010, firmware 0x8011,
  model 0x8060, log layout 0x8021); manifest at 0xE0000000 (records `A5C4`, dive start time = fingerprint, address at +20); dive upload `0x35/0x36/0x37`
  with 9-bit run-length + 32-byte XOR compression; Petrel Native Format records (opening 0x10-, samples 0x01, closing 0x20-, final 0xFF). Only the V1
  protocol (Peregrine, Perdix, Teric, Tern) and the PNF layout are supported, and nothing is written except the end-of-session message libdivecomputer sends.
  Tested against a simulator (`test/peregrine-sim.mjs`) written from the same source, **not yet against a real Peregrine**.
- **Latest certification:** `profiles.latest_cert_id` (empty = newest by date); deleting that file clears it.

- **Maps:** `places` table (`k` lower-case name, `name`, `lat`, `lon`; up to 500 per user, API `/api/places` GET/PUT/DELETE in `src/places.js`). Dives are unchanged: the free-text `location`
  is joined to a position by name. Leaflet 1.9.4 (BSD-2, `public/vendor/leaflet.*`) draws OpenStreetMap tiles (`tile.openstreetmap.org`); place search is Nominatim
  (`nominatim.openstreetmap.org`), one request per tap, >= 1.1 s apart, never while typing. The app sends `referrer-policy: no-referrer`, so map requests set
  `referrerPolicy: "origin"` themselves (OSM asks to be identified). Map data (c) OpenStreetMap contributors, ODbL. For heavy use switch to a tile provider with a plan.
  Suggestions while typing in the location boxes use Photon (`photon.komoot.io/api`, CORS open, public fair-use service; >= 3 letters, 0.5 s debounce, newest request cancels the
  older one; `localStorage.mapSuggest = "0"` turns it off). A suggestion picked by the user is remembered per name until Save, then `Places.save()` stores its position.

### Upgrading an existing database
Run each new migration once, **before** deploying the Worker that needs it (fresh installs already have it via `schema.sql`):
```bash
npx wrangler d1 execute cosmiq --remote --file=migrations/0002_dive_location.sql   # adds dives.location
npx wrangler d1 execute cosmiq --remote --file=migrations/0003_account_area.sql    # profile picture, regulator, certifications (idempotent)
npx wrangler d1 execute cosmiq --remote --file=migrations/0004_dan_and_names.sql   # name, DAN details, certification kind/date (run once)
npx wrangler d1 execute cosmiq --remote --file=migrations/0005_devices_and_latest_cert.sql   # dives.device/extra, pinned latest certification (run once)
npx wrangler d1 execute cosmiq --remote --file=migrations/0006_places.sql                     # map positions of dive places (idempotent)
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
