# Dive Manager — User Manual

*For version 0.18.0. Dive Manager manages a Deepblu Cosmiq+ (Gen 5) dive computer and your dive records.*

## Contents
1. [Getting started](#1-getting-started)
2. [Finding your way around](#2-finding-your-way-around)
3. [Summary](#3-summary)
4. [Connecting and syncing](#4-connecting-and-syncing)
5. [Dive log](#5-dive-log)
6. [Dive locations](#6-dive-locations)
7. [Device settings](#7-device-settings)
8. [Account](#8-account) (including [API access](#api-access-let-other-tools-read-your-dive-log))
9. [Understanding your dive data](#9-understanding-your-dive-data)
10. [Privacy and security](#10-privacy-and-security)
11. [Troubleshooting](#11-troubleshooting)
12. [Safety](#12-safety)

---

## 1. Getting started

### Which browser?
| Device | Use |
|---|---|
| Android phone, Windows, Mac, Linux | **Chrome** or **Edge** |
| iPhone / iPad | **Bluefy** (App Store). Safari and Chrome on iOS cannot use Bluetooth. |

Any browser can **view** your saved dive log and Summary. Only the browsers above can **connect** to the dive computer.

### Signing in
The first screen offers two ways in:

* **Continue with Google**: one tap.
* **Email + password**: enter your email and password, tap **Sign in**, then on the next page enter the **6-digit code** from your authenticator app (Google Authenticator or similar) in the six boxes. The boxes move on by themselves, Backspace steps back, a pasted code fills them all, and the code is submitted automatically.

Only accounts that the owner has allowed can sign in. You stay signed in for 30 days on a device.

### Turning on email sign-in (first time)
Email sign-in is switched on from inside the app, so nobody else can claim your address:
1. Sign in with Google once (on any device where Google sign-in works).
2. Tap your **profile icon** (top right) → **Change password** → **Set up email login**.
3. Choose a password (at least 12 characters), scan the QR code with your authenticator app (or type the setup key shown), then enter the 6-digit code.

### Add it to your home screen (optional)
In Chrome use *Add to Home screen* / *Install app*. In Bluefy use its bookmark/home-screen option. The app then opens like a normal app.

---

## 2. Finding your way around

* **Top right: your profile icon** opens **Account** (picture, password, certifications, DAN, regulator, help).
* **Three tabs** under the title: **Summary**, **Dive log** (with your dive count) and **Device** (settings).
* The big blue **Connect & Sync** button is always at the top.
* While syncing, a **progress banner with Cancel** appears on every tab.
* A small green/amber/red **message at the bottom** confirms what just happened.

* **Tab icons:** each tab has an icon above its name (a gauge for Summary, a notebook for Dive log, a watch for Device). They take the colour of the tab text, so they follow the light / dark theme.
* **Fonts:** the app uses **Geist** for text and **Geist Mono** for numbers such as dive numbers, depths and times. Both fonts are part of the app (nothing is loaded from another website) and are under the SIL Open Font License.
* **Light / dark switch** at the top left of every page (also on the sign-in pages): **left = light, right = dark**. Until you use it, the app follows your phone's own light or dark setting; once you choose, your choice is remembered on that device. The map background and the dive charts follow the theme too.

---

## 3. Summary

The Summary opens first and shows, from top to bottom:

1. **You**: your name, your **latest certification**, and your **DAN membership** with how long it is valid.
   * Latest certification = the one you chose with **Set as my latest certification** (Account → Dive certifications). If you never chose one, it is the one with the **newest date earned**; certifications without a date only count if none of them has a date. Tip: add the date to each certification, or just pick the right one yourself.
   * Total dive time and the dive count include both dive computers; a dive recorded by both at the same time is counted once.
   * DAN is **green** while valid, **orange** when it expires within 60 days, **red** once expired.
2. **Regulator service**: dives on your regulator and months since its last service, each with its own bar (**Dives** and **Time**), plus the **last service month**. The card takes the colour of the worse bar: **green**, **orange** 20 dives (or 2 months) before a limit, **red** at the limit. Defaults: every 90 dives or 12 months.
3. **Last dive**: the date, how long ago, and where, with a **SCUBA** or **FREEDIVE** tag.
4. **Total dive time** across all your dives, split into **Scuba** and **Freedive** (each with its dive time and number of dives). A dive in gauge mode counts as scuba. Freedives are counted apart because a freediving session has many short dives: they would otherwise inflate your dive count.

Tap the You card or the regulator card to jump to the matching Account section.

---

## 4. Connecting and syncing

1. Turn the dive computer on and keep it close to the phone.
2. Tap **Connect & Sync** and choose the device (named COSMIQ or Deepblu).
3. The app reads the settings, **sets the dive computer's clock to your phone's time**, then downloads **only the dives you do not have yet**.
4. When new dives arrive you are switched to the **Dive log** and asked where you dived (see [Dive locations](#6-dive-locations)).

Good to know:
* **Each dive is saved the moment it arrives.** If the connection drops, or you tap **Cancel**, you keep what was downloaded; tap sync again to continue.
* Downloading is slow (the device sends very small pieces): a few dives take seconds, a whole log can take minutes. Keep the screen on.
* In **Dive log → Sync** you can switch off the clock sync or the automatic download, and tap **Re-check every dive** if something seems missing.
* **Download raw backup** saves all your dives as a file you can keep.
* **Copy diagnostics / Save diagnostics** produce a report (version, device traffic) you can send when something goes wrong.

---

## 5. Dive log

At the top, choose the dive computer: **Cosmiq+ Gen 5** or **Shearwater Peregrine**. Each has its **own log**; the app remembers your choice.

Your dives are grouped **by year** (newest year open), then by **month** and **date**. Each row shows the dive number (bold, in a small box), time, mode (scuba / freedive / gauge), maximum depth and duration.

Tap a dive to open it:
* **Depth chart** with a **grid**: horizontal lines at round depths (in metres, down the left) and vertical lines at round minutes (along the bottom), so you can read depth and time off the line.
* **Max depth, duration, minimum temperature, O₂ %, dive number, average depth, time since your last dive, surface pressure.**
* **Location** field for that dive.
* **Technical details**: the raw header bytes, for the curious.

A badge may appear on a dive:
| Badge | Meaning |
|---|---|
| *(none)* | Complete depth profile. |
| **PARTIAL PROFILE** | The device had already overwritten the last minutes of the profile; the chart shows the gap. All summary numbers are still correct. |
| **SUMMARY ONLY** | The device overwrote this dive's whole profile (it keeps roughly the last 128). Depth, duration and temperature are intact. |

### Shearwater Peregrine: import from Shearwater Cloud
The Peregrine passes its dives to the **Shearwater Cloud** app; Dive Manager reads what Shearwater Cloud exports.
1. Download your dives from the Peregrine into **Shearwater Cloud**, as you normally do.
2. In Shearwater Cloud **export the database**: on a phone open **Profile** and tap **Export** (you get a `.db` file or an account export, a `.zip`); on a computer use **File › Export › Export Whole Database**. Save it to your phone (Files / Downloads). The menu names differ between app versions.
3. In Dive Manager open **Dive log → Shearwater Peregrine**, then **drag the file into the dashed box** (or tap the box and choose it). Both the `.db` and the `.zip` work, and so does a **UDDF** export.
4. You see *"3 new dives imported, 0 already there"* and are asked where you dived.

On a computer you can also **drag the file onto the card** instead of using the chooser (handy when you cannot find the folder: drag it straight from a Finder or Spotlight result). The file chooser shows **all** files (it does not filter by type), so a `.db` file is never greyed out. Tested on a real export of 138 dives: every dive decoded, and depth and duration match the numbers Shearwater Cloud itself stores.

Importing again later (a newer export) only adds the dives you do not have yet. Dives you **deleted** in Shearwater Cloud are skipped. The dive numbers are the ones of your Shearwater Cloud logbook. Your files stay on your device: they are read in the browser, and only the dives are saved to your account.

If a message says a file could not be read, it names the reason. If the app cannot read your export at all, send me the message: I built this reader from other people's descriptions of Shearwater's file layout and tested it on files I made myself, not on a real Shearwater Cloud export.

### Shearwater Peregrine: Bluetooth (experimental)
Under **Bluetooth download (experimental)** the app can also read the Peregrine directly. It follows the protocol of the open-source libdivecomputer, but it had **not worked on a real Peregrine** when it was released: on the first real try the phone's list did not show the Peregrine. Use the file import above; the Bluetooth route is left in for further testing. It only reads: nothing is written to the Peregrine.

Header line: *"106 dives · 90 with full depth profile · 2 partial · 14 summary only"*.

---

## 6. Dive locations

A location is just **the area**, for example *Banda*, *Komodo*, *Tulamben*. No exact spot, no GPS.

* **After every sync that brings new dives**, the app asks *"Where did you dive?"* with **one row per date** (oldest first).
  * **↑ same** repeats the place from the row above: handy for a trip.
  * When a month has several dates, a **whole month** box sits above them. A date's own entry wins over the month's.
  * Places you used before are suggested as you type; a date that already has a place is pre-filled.
  * **Save** applies them; **Later** closes the question (a banner reminds you: *"N dives have no location"*).
* **In the log**, every **month** has **Set place for the month**: one place for all its dives. By default it only fills dives **without** a place; tick **Replace places that are already set** to change them all.
* Every **date** has a 📍 chip: tap it to add or change that day's place (empty = clear it).
* Every **dive** has its own Location field.

Your 7–14 dives from a single trip are one tap with *Set place for the month*.

---

## 6b. Maps and places

Every dive location you type (for example *Tulamben*) is a **place**. A place gets a position on the map once, and then all dives with that location are on the map.

**Scuba or freedive on the map.** Once you have freedives, a switch above the map shows **All / Scuba / Freedive** (with the number of places for each). Pins are **blue** for scuba, **green** for freedive and **split blue / green** where you did both (the split only says "both"; it is not to scale). The number on a pin is its dive count for what you are showing. Tap a pin for a line per kind: dives and dive time. The choice is remembered; with no freedives the switch is hidden.

**The Summary map** ("Where you have dived") shows a **red pin for every place** you have been to, with the number of dives on it. Tap a pin to see the number of dives and the months you dived there, and **Move pin** to correct it. Under the map, **All places** lists every place with *Set on map / Move* and *Remove pin*.

**The location box searches the map while you type.** In every box where you enter a dive location (the question after a sync, a date, a month, one dive), type at least three letters: a list of matching places from the map appears right under the box, with the region next to each name (for example *Bunaken · North Sulawesi, Indonesia*). Tap one (or use the arrow keys and Enter): the box takes that name and turns **green**, and when you save, the place is **added to your map with that exact position** and shows on the Summary at once. The message says which places were added. You can still type any name you like: a place you did not pick from the list goes to the map search described below. Edit the text after picking and it counts as a different place again.
* The lookup waits half a second after your last key, so fast typing makes one request. It needs internet; without it you simply type as before.
* Not wanted? Tap **Turn off** at the bottom of the list, or untick *Suggest places from the map while I type a location* under **All places** on the Summary.
* The text you type (3 letters or more) is sent to **Photon** (photon.komoot.io, a free service that searches OpenStreetMap data and is made for suggestions while typing). Nothing else is sent. It is a shared free service: if it is busy the list shows a message and you carry on typing.

**Entering a location opens the map.** When you save a location in the dive log that is **not on the map yet** (after a sync, for a date, for a month, or for one dive), the map search opens for it straight away, with the name already searched. Tap the right result (or tap the map), then **Save pin**. Several new places are done one after another; **Skip this one** / **Skip all** leave them for later. A location that is already on the map never asks again. If you would rather do it later, untick **Open the map when I enter a new location** at the bottom of the map screen: the orange buttons and the bar in the dive log remain.

**Putting a place on the map yourself**
1. Orange buttons under the map (and a bar in the **Dive log**) show places that are *not on the map yet*. Tap one.
2. The place name is searched automatically. Tap the right result: the pin drops there and the map zooms in. If nothing is found, or it is the wrong spot, **tap the map** to drop the pin, and **drag** it to fine-tune. Search again with another spelling or a nearby town if you like.
3. **Save pin.** The next place waits in line; **Skip this one** leaves it for later.

The name you typed stays as it is: the map only adds a position to it. Places with different capitalisation (*Tulamben* / *tulamben*) are one place. If you change a dive's location to a new name, that new place appears in the list to be put on the map.

**Privacy and limits.** The map pictures and the place search come from **OpenStreetMap** (free). When you open a map or tap Search, OpenStreetMap sees the map area you look at, the text you search for, and that the request comes from this app; it never sees your dives, your account or the other places. The map search by button (Nominatim) runs only when you tap it, because their usage rules ask for that; the suggestions while typing come from Photon (see above). Without internet the pins and lists still show, but the map background and the search do not. Positions are saved in your account, up to 500 places.

---

## 7. Device settings

Open the **Device** tab (you must be connected). Tabs: **General**, **Environment**, **Scuba**, **Freedive**, **Diagnostics**.

| Tab | You can change |
|---|---|
| General | Default mode, **clock** (Sync Now), units, date display, screen timeout, backlight level, power-saving mode |
| Environment | Normal/sea water, high salinity (advanced), altitude |
| Scuba | Safety factor, max PPO₂, gas mix (O₂ %), depth alarm, time alarm |
| Freedive | Max time, six depth alarms |
| Diagnostics | Raw data packets ("Byte Hunter") |

**Every change is confirmed.** You see *"Applying…"*, then the app **reads the value back from the dive computer** and shows:
* **green ✓** *"Backlight set to level 3"*: the device really holds that value;
* **amber** *"Not applied: the dive computer still shows …"*: the device did not accept it (the screen returns to the real value);
* **red** *"The dive computer rejected this change"*.
The clock cannot be read back, so its message is *"Clock set to HH:MM:SS (phone time)"*: sent and not rejected.

> **Always check the settings on the dive computer's own screen before diving.**

---

## 8. Account

Tap your **profile icon**. Sections open and close with a tap.

### Profile picture
**Upload picture**: pick a photo, it is cropped to a square and stored in your account. **Remove** deletes it. Below it, **Your name** (shown on the Summary; your Google name is suggested, tap **Save** to keep a name of your own).

### Change password
* **Email login off**: *Set up email login* (see [section 1](#turning-on-email-sign-in-first-time)).
* **Email login on**:
  * **Change password**: enter your **current password**, the **new password** twice (12+ characters) and the **current 6-digit code**. Your authenticator stays the same: no new QR code.
  * **Reset authenticator**: new QR code (needs your current code).
  * **Remove**: turns email login off (needs a code). Google sign-in always keeps working.
* After **5 wrong attempts** an account is locked for 15 minutes.

### Dive certifications
Keep a scan or photo of each certification card for dive registrations.
1. Enter a **name** (e.g. *PADI Advanced Open Water*), optionally the **certificate number** and the **date certified**.
2. **Choose file** (PDF, JPEG, PNG or WebP) → **Upload**. Photos are shrunk automatically; a PDF must be **under 1 MB** (otherwise use a photo).
3. Each file has **Open/View**, **Save**, **Share** (where your browser supports it) and **Delete** (tap twice).
Up to 12 files. The Summary shows your **latest certification**: tap **Set as my latest certification** on the right one (it gets a green ★ Latest tag). **Use the newest by date instead** goes back to automatic. If you delete the one you chose, it goes back to automatic.

### DAN insurance
* **DAN member number** (required), **plan** (optional, e.g. *DAN Master*) and **valid until**. Tap **Save DAN details**. A badge next to the section title shows *Valid*, *N days left* or *Expired*.
* **Insurance documents**: upload your DAN card or policy exactly like a certification (up to 12 files, kept separate from certifications).
* **Remove** clears the details (uploaded documents stay until you delete them).

### Regulator
Track when to service your regulator.
1. **Add my regulator**: name, type (e.g. *Balanced piston*) and **dives already on it**. *Use my logged dives* fills in your scuba/gauge dive count.
2. From then on the count **rises with every new dive** you sync. **Freedives are not counted** (they do not use a regulator).
3. **Two reminders, whichever comes first:** *Service every [90] dives or every [12] months* (Edit). Put 0 to switch one off, but keep at least one. **Orange** 20 dives (or 2 months) before the limit, **red** at the limit.
4. **Last serviced** (month and year, optional) starts the time reminder. Without it only the dives remind you.
5. After a service tap **Reset to 0**, pick the **month and year of the service** (month and year are enough) and tap *Reset counter*: counting starts again after your latest logged dive and the service is added to the **Service history** (newest first, with how many dives the regulator had).
One regulator is tracked. **Edit** changes its name, type, starting count, last service or limits; **Remove** stops tracking. Months are whole calendar months, so a limit can fire up to a month early, on the safe side.

### Help / app version
Shows the **app version**, whether a newer one is available, **Check for update** (clears the cached copy and reloads), **Copy diagnostics**, and quick tips.

**Sign out** is at the bottom of the Account page.

### API access (let other tools read your dive log)
Account → **API access** lets another program (a dashboard, a script, a spreadsheet, a phone shortcut) **read** your dives. A key can only read: it cannot change or delete anything, and it cannot sign in to this app.

**Make a key**
1. Open **Account → API access**.
2. Under **Generate a key** write what it is for (for example *Home dashboard*) and choose how long it works: **7 days, 14 days, 30 days or Unlimited**. Prefer a time limit: an unlimited key keeps working until you revoke it.
3. Tap **Generate key**. The key (it starts with `dm_`) appears in a green box. **Copy it now**: it is shown **only once**. The app keeps only a one-way fingerprint of it, so nobody (not even you or the app) can show it again. Lose it? **Rotate** the key to get a new one.

**Your keys**
Every key is **one line**: a coloured dot (green active, orange when it ends within 3 days, red expired, grey revoked), its description, and how long it has left (*18 d*, *Never*, *Expired*, *Revoked*), then small buttons. **Tap the line** to open its details: the first letters of the key, when it was made, when it was **last used** (updated at most once an hour) and the exact expiry date.
* **↻ Rotate**: the same key gets a **new secret and a fresh time limit** (a 7-day key is good for 7 more days). **The old secret stops working at once**, so update your tool with the new key. An expired key can be rotated back to life.
* **⊘ Revoke**: switches the key off for good. It stays in the list, greyed out, until you delete it.
* **Delete** (bin, for revoked or expired keys): removes it from the list.
* Each of these buttons first turns red and says **Sure?**; tap it again within 4 seconds to do it. Rotating shows the new key once, in the green box.
* You can have **10 active keys** (one for each tool is a good habit: then you can cut one off without touching the others).

**Using the API**
The menu itself shows your own address and a ready-to-copy example. In short:
* **Base address:** `https://<your address>/api/v1`
* **Send the key in a header:** `Authorization: Bearer dm_...` (or `X-API-Key: dm_...`). Never put it in the web address.
* **Endpoints** (all read-only `GET`):
  * `/ping`: checks that the key works.
  * `/summary`: number of dives and dive time per computer (Cosmiq+, Peregrine) and kind (scuba, freedive), and the time of the last dive.
  * `/dives`: your dives, newest first. Options: `limit` (1-500, default 100; at most 10 with `include`), `cursor` (the `nextCursor` of the last answer: next page), `order=asc|desc`, `from` and `to` (days like `2025-03-14`), `device=cosmiq|peregrine`, `kind=scuba|freedive`, `location=Tulamben`, `uploadedSince=2025-04-01T10:00:00Z` (only dives added after that: fetch just what is new), `include=samples` (adds the depth profile) or `include=raw` (also the Cosmiq+ device bytes).
  * `/dives/{id}`: one dive with its depth samples (`?include=raw` for the raw bytes).
* **A dive looks like:** `id`, `device`, `kind`, `mode`, `startedAt`, `durationSec`, `maxDepthM`, `minTempC`, `o2Percent`, `diveNumber`, `location`, `position` (`{lat, lon}` where you put the place on the map, else `null`) and `uploadedAt`.
* **Example:**
  ```bash
  curl -H "Authorization: Bearer dm_YOUR_KEY" "https://<your address>/api/v1/dives?kind=scuba&limit=2"
  ```
* Errors come as `{"error": "invalid_key", "message": "..."}` with status 400 (bad option), 401 (missing, invalid, expired or revoked key), 404 or 405 (this API only reads).

**Good to know**
* Depth is in metres, temperature in °C, durations in seconds. `startedAt` is the dive computer's own clock (no time zone).
* A dive recorded by **both** computers appears **once per computer** (see `device`); the app's Summary counts it once, the API leaves that choice to your tool.
* A **Cosmiq+** dive has `samples` only when the depth profile stored for it really belongs to it (`profileStatus`: `complete`, `partial` or `unavailable`). The app can recover some older profiles that the Cosmiq+ itself overwrote; the API does not, so a few old dives have `unavailable` there.
* Treat a key like a password: do not post it online. If it leaks, **Revoke** it. If you remove your email from the list of allowed users, all your keys stop.
* Please keep it to a few requests per second: the app runs on free hosting.

---

---

## 9. Understanding your dive data

* **Depth** is calculated from the pressure the device recorded, **assuming seawater** (like the device does).
* **Minimum temperature** comes from the dive header and is the true minimum, which can be a little lower than the lowest value on the chart.
* **Time since last dive** is counted from the end of the previous dive to the start of this one.
* **Profile memory is a ring.** The Cosmiq+ keeps depth profiles in a fixed-size memory (about the last 128 dives) and overwrites the oldest. Dive Manager matches every profile to the dive it really belongs to, recovers dives the device itself cannot read under their own number, and marks overwritten ones *summary only*. **Sync after every trip**: each new dive overwrites an old profile on the device.
* **Peregrine dives** come from the Shearwater Cloud file (or Bluetooth) you imported: values and depth samples are exactly what Shearwater Cloud wrote (the dive number is the Peregrine's own when the file has it, otherwise the order of your imported dives). From a Shearwater Cloud database the values are decoded from the dive computer's own records (depth, duration, temperature, first gas, depth samples) and the dive number is your Shearwater Cloud logbook number; from UDDF they are what Shearwater Cloud wrote.
* **Two computers, one dive:** if you wore both and both logged the same dive, the Summary totals, the last dive and the regulator counter count it **once and use the Cosmiq+ record**. Both stay visible in their own log; the Peregrine copy is marked *also on Cosmiq+*, and the Summary says how many were counted once.
  * The same dive is recognised when the two records **overlap in time** (the computers' clocks are often a few minutes apart) or when the clocks are **exactly one or two hours apart** (time zone or daylight saving) and the dive has the same length and depth. A dive on the Peregrine only is added.
  * Limits: this is matching by time, length and depth, so two real dives of the same size exactly 1-2 hours apart while one clock is also off by that much could be confused. Very short Peregrine records (under a minute, at the surface) are counted as dives like any other.
* **The Cosmiq+ dive log has no GPS** or location information; locations are what you type.
* The device clock has no time zone: dive times are shown exactly as the dive computer recorded them.

---

## 10. Privacy and security

* Dive Manager runs in the owner's own Cloudflare account. Your data (dives, picture, files, DAN details, regulator) is in a private database, visible only to accounts on the allow-list, and each person only sees their own.
* Passwords are processed in your browser and never sent to the server in plain form; authenticator codes work once.
* Uploaded files are checked by their real content, never run as web pages, and only the owner can read them.
* Bluetooth is handled in your browser. Cloudflare never connects to the dive computer.

---

## 11. Troubleshooting

| Problem | What to try |
|---|---|
| "This browser can't use Bluetooth" | Use Chrome/Edge, or Bluefy on iPhone/iPad. |
| Can't find the dive computer | Wake it, keep it close, make sure Bluetooth is on and no other app is connected to it. |
| Sync stops or times out | Tap **Cancel**/wait, then sync again: downloaded dives are kept and it continues. |
| A dive is missing | **Dive log → Re-check every dive**. |
| A chart says *summary only* | The device overwrote that profile; nothing can bring it back. Sync after each trip. |
| "Not applied: the dive computer still shows …" | Try again; check the device's screen; reconnect if it keeps happening. |
| Signed out / "reload the page to sign in again" | Reload; sign in again. Unsent edits are kept and retried. |
| Authenticator code rejected | Check your phone's clock is automatic; each code works once, so wait for the next one. Locked after 5 failures: wait 15 minutes or use Google sign-in. |
| Lost authenticator | Sign in with Google → Account → Change password → *Reset authenticator* (needs the current code), or ask the owner to remove the email login. |
| Something looks outdated | Account → Help → **Check for update**. |
| Still stuck | Account → Help → **Copy diagnostics** and send it with a description. |

---

## 12. Safety

Dive Manager is **unofficial** software. Always confirm your dive computer's settings on its own screen, never rely on the app for life-safety decisions, and follow your regulator manufacturer's and your insurer's own rules; the service counter and DAN validity are reminders, not authorities. Dive safe.
