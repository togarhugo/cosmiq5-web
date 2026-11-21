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
Same pattern as the other thmlab apps: Google OAuth (authorization code + PKCE) inside the Worker, an HttpOnly signed
session cookie (30 days), and an `ALLOWED_EMAILS` allow-list. Pages redirect to Google; the API returns 401. If any
setting below is missing, the Worker answers 503 to everything (fails closed).

## One-time setup
Needs Node 20+, `thmlab.org` on your Cloudflare account, and a Google OAuth client.

```bash
npm install
npx wrangler login
npx wrangler d1 create cosmiq               # put database_id into wrangler.toml
npx wrangler d1 execute cosmiq --remote --file=schema.sql
```
1. **Google Cloud Console** > Credentials > your OAuth client > add authorized redirect URI
   `https://dive-comp.thmlab.org/auth/callback`.
2. Put the client ID in `wrangler.toml` (`GOOGLE_CLIENT_ID`).
3. Secrets:
   ```bash
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put SESSION_SECRET      # openssl rand -hex 32
   npx wrangler secret put ALLOWED_EMAILS      # you@gmail.com[,other@gmail.com]
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

## Develop / test
```bash
npm test               # protocol + sign-in/API tests (build runs first)
node test/e2e.mjs      # mobile browser e2e against a simulated dive computer (needs Playwright)
```

## Safety
Unofficial software. Always verify settings on the dive computer before diving. Dive-log protocol reimplemented from
the public description in libdivecomputer's `deepblu_cosmiq` driver (LGPL-2.1+, (C) Linus Torvalds, Jef Driesen);
verified only against a simulator until tested on real hardware.
