# Dive Manager — User Manual

*For version 0.9.0. Dive Manager manages a Deepblu Cosmiq+ (Gen 5) dive computer and your dive records.*

## Contents
1. [Getting started](#1-getting-started)
2. [Finding your way around](#2-finding-your-way-around)
3. [Summary](#3-summary)
4. [Connecting and syncing](#4-connecting-and-syncing)
5. [Dive log](#5-dive-log)
6. [Dive locations](#6-dive-locations)
7. [Device settings](#7-device-settings)
8. [Account](#8-account)
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

---

## 3. Summary

The Summary opens first and shows, from top to bottom:

1. **You**: your name, your **latest certification**, and your **DAN membership** with how long it is valid.
   * Latest certification = the one you chose with **Set as my latest certification** (Account → Dive certifications). If you never chose one, it is the one with the **newest date earned**; certifications without a date only count if none of them has a date. Tip: add the date to each certification, or just pick the right one yourself.
   * Total dive time and the dive count include both dive computers; a dive recorded by both at the same time is counted once.
   * DAN is **green** while valid, **orange** when it expires within 60 days, **red** once expired.
2. **Regulator service**: dives on your regulator since its last reset, with a progress bar. **Green** below 70, **orange from 70**, **red from 90**.
3. **Last dive**: the date, how long ago, and where.
4. **Total dive time** across all your dives.

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

### Shearwater Peregrine: download over Bluetooth (beta)
1. On the Peregrine open its **Bluetooth** menu (as for Shearwater Cloud) and keep it close to the phone.
2. In Dive Manager open **Dive log → Shearwater Peregrine** and tap **Download dives over Bluetooth**.
3. Choose your Peregrine in the list your browser shows (Chrome on Android, Bluefy on iPhone). Dives are downloaded **one at a time, oldest first, and only the ones you do not have yet**; each is saved as it arrives. **Cancel** stops safely.
4. You are asked where you dived, as with the Cosmiq+.

This is **beta**: it follows the protocol of the open-source libdivecomputer (the library Subsurface uses) and is tested against a simulated Peregrine, but it had not yet run on a real one when it was released. If it fails, the message says why; then use **Account → Help → Copy diagnostics** and send me the text. The app never writes anything to the Peregrine (it only reads) and does not change its clock.

### Shearwater Peregrine: import a file
If Bluetooth does not work for you, import a file instead.
1. In the **Shearwater Cloud** app (download your dives from the Peregrine there first), export your dives as **UDDF** (Export › UDDF) and keep the file on your phone or laptop.
2. In Dive Manager open **Dive log → Shearwater Peregrine → Choose UDDF file(s)**.
3. You see *"3 new dives imported, 0 already there"* and are asked where you dived. Importing the same file (or a newer export that includes the old dives) again only adds the new dives.

If a file cannot be read you get a plain message (for example "not a UDDF dive log"). Subsurface can also export UDDF, so any app that exports UDDF works.

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
3. **Green below 70, orange from 70, red from 90** (Summary and the badge here).
4. After a service tap **Reset to 0** (tap twice to confirm): counting starts again after your latest logged dive.
One regulator is tracked. **Edit** changes its name, type or starting count; **Remove** stops tracking.

### Help / app version
Shows the **app version**, whether a newer one is available, **Check for update** (clears the cached copy and reloads), **Copy diagnostics**, and quick tips.

**Sign out** is at the bottom of the Account page.

---

## 9. Understanding your dive data

* **Depth** is calculated from the pressure the device recorded, **assuming seawater** (like the device does).
* **Minimum temperature** comes from the dive header and is the true minimum, which can be a little lower than the lowest value on the chart.
* **Time since last dive** is counted from the end of the previous dive to the start of this one.
* **Profile memory is a ring.** The Cosmiq+ keeps depth profiles in a fixed-size memory (about the last 128 dives) and overwrites the oldest. Dive Manager matches every profile to the dive it really belongs to, recovers dives the device itself cannot read under their own number, and marks overwritten ones *summary only*. **Sync after every trip**: each new dive overwrites an old profile on the device.
* **Peregrine dives** come from Bluetooth or from the file you imported: values and depth samples are exactly what Shearwater Cloud wrote (the dive number is the Peregrine's own when the file has it, otherwise the order of your imported dives). With Bluetooth, the values are decoded from the dive computer's own records (depth, duration, temperature, first gas, depth samples); the dive number is the order of your downloaded dives.
* **Two computers, one dive:** if you wore both and both logged the same dive, Summary totals and the regulator counter count it once (a dive from the other computer that starts before the first one has ended). Both stay visible in their own log.
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
