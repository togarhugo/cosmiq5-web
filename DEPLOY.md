# Cosmiq Manager (Cloudflare deployment guide)

Mobile-friendly web app for the Deepblu Cosmiq+ Gen 5 dive computer:
device settings, **automatic clock sync on every connect**, **dive-log download**,
and cloud storage behind **Google login** (Cloudflare Access).

Bluetooth stays in your browser (Web Bluetooth). Cloudflare only hosts the page and stores dives.

```
phone/laptop browser --BLE--> dive computer
        |  https (Cloudflare Access: Google login)
        v
 Worker (verifies Access JWT) --> D1 database (dives)
```

## Browser support
| Platform | Works with |
|---|---|
| Android, Windows, macOS, Linux | Chrome / Edge |
| iPhone / iPad | **Bluefy** browser only (Safari and Chrome on iOS have no Web Bluetooth). The saved dive log can be viewed in any browser. |

## What happens on every connect
1. Read current settings.
2. **Set the dive computer clock to the phone's time** (toggle in the Dive log tab).
3. Download dives not already saved (read-only commands 0x40-0x44, 0x58, 0x5A), save them locally, upload to the cloud.

Raw device bytes are stored, so parser improvements apply to old dives. Use **Download raw backup** regularly.

## Deploy (one-time, ~15 min)
Prereqs: Node 20+, a Cloudflare account with `thmlab.org` as a zone.

```bash
npm install
npx wrangler login
npx wrangler d1 create cosmiq            # copy database_id into wrangler.toml
npx wrangler d1 execute cosmiq --remote --file=schema.sql
```

**Google login via Cloudflare Access** (dashboard, Zero Trust):
1. Google Cloud Console > APIs & Services > Credentials > *OAuth client ID* (Web). Authorized redirect URI:
   `https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback`
2. Zero Trust > Settings > Authentication > Login methods > add **Google** with that client ID/secret.
3. Edit `wrangler.toml`: set `TEAM_DOMAIN` (`<your-team>.cloudflareaccess.com`) and `ALLOWED_EMAILS`. Deploy once:
   ```bash
   npx wrangler deploy
   ```
4. Zero Trust > Access > Applications > *Add self-hosted* for `cosmiq.thmlab.org`; policy **Allow** > Emails > your Google email.
   Copy the application's **Audience (AUD) tag** into `POLICY_AUD` in `wrangler.toml`, then `npx wrangler deploy` again.
5. Also protect the `workers.dev` URL: Workers > cosmiq-manager > Settings > Domains & Routes > disable `workers.dev` (the Worker also rejects requests without a valid Access token).

Until `TEAM_DOMAIN` / `POLICY_AUD` are set, the API refuses every request (fails closed).

## Develop / test
```bash
npm test                 # protocol + auth unit tests
node test/e2e.mjs        # mobile browser e2e against a simulated dive computer (needs Playwright)
```

## Safety
Unofficial software. Always verify settings on the dive computer before diving.
Dive-log protocol reimplemented from the public description in libdivecomputer's
`deepblu_cosmiq` driver (LGPL-2.1+, (C) Linus Torvalds, Jef Driesen); written for the Cosmiq+, verified here
only against a simulator until tested on real hardware.
