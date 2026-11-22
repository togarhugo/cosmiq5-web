# **Dive Manager** — Deepblu Cosmiq+ (Gen 5) companion

A web app to **manage a Deepblu Cosmiq+ Gen 5 dive computer** now that the official app has been discontinued: change its settings, download and keep your dive log, and track your diving, all from a phone or laptop browser over Bluetooth.

> **Current version: 0.19.1** · User manual: [MANUAL.md](MANUAL.md) · Deployment: [DEPLOY.md](DEPLOY.md) · Bluetooth protocol notes: [technical_documentation.md](technical_documentation.md)

## What it does

| | |
|---|---|
| **Summary** | Your name, latest certification (**you can choose which one**), **DAN membership and validity**, date of your last dive, **total dive time**, and a **regulator service card** with two reminders, by dives (default 90) and by time (default 12 months), showing the last service month. |
| **Dive log** | Downloads your Cosmiq+ dives over Bluetooth (only the new ones), grouped by year, month and date, with **grid** depth charts, minimum temperature, surface interval and a dive location you choose (e.g. *Komodo*). A second computer, the **Shearwater Peregrine**, has its own separate log, filled by importing a **Shearwater Cloud database export** (or a UDDF file), or, experimentally, over Bluetooth. |
| **Map** | Every place you have dived is a **pin on a map** in the Summary (with the number of dives). Put a place on the map by **searching** for it or tapping / dragging the pin. Maps and search come from OpenStreetMap. |
| **Device settings** | Backlight, units, screen timeout, clock, gas mix, PPO₂, alarms, safety factor, freedive alarms. Every change is **read back from the dive computer and confirmed**. |
| **Certificates** | Your certification scans as a **wallet of overlapping cards**: scroll, tap one to open it, **Make main** to choose the one the Summary shows. |
| **Account** | Profile picture and name, change password, **DAN insurance** details and documents, regulator tracker, API keys, help and app version. |
| **Laptop layout** | From 1024 px wide the tabs become a **left sidebar** and the content uses the width; phones keep the single-column layout. |
| **API** | Make **API keys** in the Account area (7, 14, 30 days or unlimited; rotate and revoke) and let other tools read your dive log through a small read-only API: `/api/v1/dives`, `/dives/{id}`, `/summary`. The menu shows the endpoints. Keys are shown once and stored only as a hash. |
| **Sign-in** | Google, or email + password followed by a 6-digit authenticator code. |

The clock of the dive computer is set to your phone's time every time you connect.

## Quick start

1. Open your Dive Manager address (the one you deployed, see [DEPLOY.md](DEPLOY.md)) and sign in.
2. On **Android / Windows / Mac / Linux** use **Chrome or Edge**. On **iPhone/iPad** Safari cannot use Bluetooth: open the page in the **Bluefy** browser.
3. Turn on the dive computer, tap **Connect & Sync**, choose the device.
4. New dives are downloaded, you are asked where you dived, and the Summary is up to date.

The full walkthrough is in the **[user manual](MANUAL.md)**.

## Project layout

| Path | What is there |
|---|---|
| `public/` | The app: pages, scripts, sign-in screens (`auth/`), dive protocol and parser (`dive-protocol.js`), helpers (`dive-utils.js`) |
| `src/` | The Cloudflare Worker: sign-in (Google and password + authenticator), dive log and account API |
| `schema.sql`, `migrations/` | The D1 database layout and the one-off upgrade steps |
| `test/` | Unit tests and browser tests (including a simulated dive computer) |
| `index.html` | The **original** single-file controller from the upstream project, unchanged |
| `DEPLOY.md` | How to deploy, how sign-in works, what the dive computer stores (decoded header, ring-buffer memory) |
| `MANUAL.md` | User manual |

Develop and test: `npm install`, `npm test`, `node test/e2e.mjs` (needs Playwright), `npm run deploy`.

## Privacy

Dive Manager runs in **your own Cloudflare account** (free plan). Your dives, picture, certification files, DAN details and regulator are stored in your private database and can only be read by accounts you allow (`ALLOWED_EMAILS`). Bluetooth is handled in your browser; Cloudflare never talks to the dive computer. The original `index.html` still runs entirely in the browser and sends nothing anywhere.

## ⚠️ Important safety warning

**This software is UNOFFICIAL and experimental.**

Diving involves significant risks, including decompression sickness, oxygen toxicity, and drowning.

1. **ALWAYS** verify your settings on the physical device screen before entering the water.
2. **NEVER** rely solely on this software to configure life-safety parameters.
3. Regulator and insurance reminders are conveniences, not a substitute for your service schedule, your insurer, or your training agency.
4. The authors and the AI assistants accept **NO RESPONSIBILITY** for malfunctions, incorrect settings, or any safety incidents resulting from the use of this tool.

*Dive safe. Always carry a backup.*

## Credits

- The original Web Bluetooth settings controller (`index.html`, `technical_documentation.md`) is by the upstream project, "vibecoded" with Gemini Pro 3 through an iterative conversation between a human operator (providing logs and testing) and the AI.
- The dive-log download protocol was reimplemented from the public description in the **libdivecomputer** project's `deepblu_cosmiq` driver (LGPL-2.1+, © Linus Torvalds, Jef Driesen), then verified and extended against a real Cosmiq+ Gen 5 (header fields, and the 256-page profile-memory ring described in `DEPLOY.md`).
- QR codes: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT).
- Dive Manager's web app, Worker and tests were written with Claude (Anthropic).

See [LICENSE](LICENSE).
