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
2. **Email + password + authenticator code** - the password is stretched in the browser (PBKDF2-SHA256, 600,000
   iterations) so the server never sees it and verifying a login costs almost no CPU on the free plan. The second factor
   is a standard 6-digit TOTP (Google Authenticator and compatible apps). The authenticator secret is stored AES-GCM
   encrypted with `DATA_KEY`; the password verifier is an HMAC keyed with a pepper derived from `DATA_KEY`.

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

## Develop / test
```bash
npm test               # protocol, Google + password/TOTP sign-in, API tests (build runs first)
node test/e2e.mjs      # mobile browser e2e against a simulated dive computer (needs Playwright)
node test/e2e-real.mjs # real Worker + local D1 + browser: Account setup and password/TOTP login
                       # (needs a .dev.vars with the secrets above and `npx wrangler dev --local --port 8799`)
```

## Safety
Unofficial software. Always verify settings on the dive computer before diving. Dive-log protocol reimplemented from
the public description in libdivecomputer's `deepblu_cosmiq` driver (LGPL-2.1+, (C) Linus Torvalds, Jef Driesen);
verified only against a simulator until tested on real hardware.
