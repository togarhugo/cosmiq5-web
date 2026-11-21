// Run: node test/e2e.mjs   (needs playwright; starts its own static server)
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const P = req("../public/dive-protocol.js");
const { chromium, devices } = req("playwright");
import assert from "node:assert/strict";
import { peregrine, pnfDive } from "./peregrine-sim.mjs";
import { makeDb, dive as cloudDive, zip as makeZip } from "./cloud-fixture.mjs";

const root = path.resolve("public");
import { readFileSync } from "node:fs";
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const f = path.join(root, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

// ---- fake device, injected before the page loads ----
const fakeBle = () => {
  window.__tx = [];
  const enc = new TextEncoder();
  const frame = (cmd, data) => { const len = data.length * 2; let s = cmd + len; for (const b of data) s += b;
    const h = [cmd, (256 - (s & 255)) & 255, len, ...data].map((x) => x.toString(16).padStart(2, "0")).join(""); return "$" + h + "\n"; };
  const hdr = (y, mo, d, h, mi, dur, mode, o2, maxRaw, number, n, minT, page) => { const b = new Array(36).fill(0);
    b[0] = number; b[2] = mode; b[3] = o2; b[4] = 0xf5; b[5] = 0xa3; b[6] = y & 255; b[7] = y >> 8; b[8] = d; b[9] = mo; b[10] = mi; b[11] = h;
    b[12] = dur & 255; b[13] = dur >> 8; b[22] = maxRaw & 255; b[23] = maxRaw >> 8; b[24] = minT & 255; b[25] = minT >> 8; b[26] = 10;
    b[28] = n & 255; b[29] = n >> 8; b[30] = page & 255; b[31] = page >> 8; b[32] = (page + 1) & 255; b[33] = (page + 1) >> 8; return b; };
  const smp = (t, d) => [t & 255, t >> 8, d & 255, d >> 8];
  const prof = []; for (let i = 0; i < 40; i++) { const depth = 1013 + Math.round(1800 * Math.sin((i / 39) * Math.PI)); prof.push(...smp(270 + i % 5, depth)); }
  const dives = [{ h: hdr(2025, 3, 14, 9, 30, 42, 2, 32, 1013 + 1800, 1, 40, 270, 0), p: prof }, { h: hdr(2025, 3, 15, 8, 5, 1, 4, 0, 1013 + 1500, 2, 1, 260, 2), p: smp(260, 1013 + 1500) }];
  // window.__wrap: dive #3 lives at page 256 (wrapped) and physically overwrote dive #1's slot, like the real device
  const prof3 = []; for (let i = 0; i < 20; i++) prof3.push(...smp(255 + (i % 3), 1013 + Math.round(900 * Math.sin((i / 19) * Math.PI))));
  const d3 = { h: hdr(2025, 3, 16, 10, 0, 7, 2, 32, 1013 + 900, 3, 20, 255, 256), p: prof3 };
  if (window.__wrap) dives.push(d3);
  window.__dives = dives; window.__d3 = d3;
  const readProfile = (n) => { const d = dives[n - 1]; if (!window.__wrap) return d.p;
    const page = d.h[30] | (d.h[31] << 8), len = (d.h[28] | (d.h[29] << 8)) * 4;
    if (page >= 256) return new Array(len).fill(255);                                  // the device cannot read wrapped pages
    if (page === 0) { const p = prof3.slice(); while (p.length < len) p.push(255); return p.slice(0, len); }   // slot 0 now holds dive #3
    return d.p; };
  // stateful settings, laid out like the real read packets (see technical_documentation.md)
  const st = { env: 0, blEco: 5, mode: 0, depth: 30, tAlarm: 60, air: 21, timeout: 3, date: 0, units: 1, fdTime: 6, safety: 1, ppo2: 14, a: [0, 25, 30, 35, 40, 45, 50] };
  const settingsReply = (cmd) => ({
    0x5f: [0, st.env, st.blEco, 0, 0, 0],
    0x5c: [(st.depth * 100 + 1000) >> 8, (st.depth * 100 + 1000) & 255, st.tAlarm >> 8, st.tAlarm & 255, st.air, st.mode],
    0x5b: [0, 0, 0, st.timeout, st.date, st.units],
    0x5d: [st.a[2] - 5, st.a[1] - 5, 0, st.fdTime, st.safety, st.ppo2],
    0x60: [st.a[4] - 5, st.a[3] - 5, st.a[6] - 5, st.a[5] - 5],
  })[cmd];
  const writeSetting = (cmd, p) => { const last = p[p.length - 1];
    if (cmd === 0x30) st.env = last; else if (cmd === 0x2e) st.blEco = p[0]; else if (cmd === 0x21) st.safety = last; else if (cmd === 0x2b) st.mode = p[0];
    else if (cmd === 0x2a) st.timeout = last; else if (cmd === 0x22) st.air = p[0]; else if (cmd === 0x2d) st.ppo2 = p[0]; else if (cmd === 0x23) st.units = p[0];
    else if (cmd === 0x24) st.date = p[0]; else if (cmd === 0x27) st.depth = (((p[0] << 8) | p[1]) - 1000) / 100;
    else if (cmd === 0x28) st.tAlarm = (p[0] << 8) | p[1]; else if (cmd === 0x26) st.fdTime = p[1];
    else if (cmd === 0x25) { st.a[2] = p[0] + 5; st.a[1] = p[1] + 5; } else if (cmd === 0x31) { st.a[4] = p[0] + 5; st.a[3] = p[1] + 5; } else if (cmd === 0x32) { st.a[6] = p[0] + 5; st.a[5] = p[1] + 5; } };
  let handler = null; const out = [];
  const chunks = (str) => { for (let i = 0; i < str.length; i += 20) out.push(str.slice(i, i + 20)); };
  const flush = () => { while (out.length) { const c = enc.encode(out.shift()); handler && handler({ target: { value: new DataView(c.buffer) } }); } };
  const respond = (line) => {
    const raw = line.trim().slice(1).match(/../g).map((x) => parseInt(x, 16)); const cmd = raw[0], n = raw[3];
    if (cmd === 0x58) chunks(frame(0x58, [0x42]));
    else if (cmd === 0x5a) chunks(frame(0x5a, [1, 2, 3, 4, 5, 6]));
    else if ([0x5f, 0x5b, 0x5c, 0x5d, 0x60].includes(cmd)) chunks(frame(cmd, settingsReply(cmd)));
    else if (cmd >= 0x21 && cmd <= 0x32 && cmd !== 0x20) {                       // a setting is being written
      if (window.__rejectWrites) chunks("$800000\n");
      else if (!window.__ignoreWrites) writeSetting(cmd, raw.slice(3));
    }
    else if (cmd === 0x40) chunks(frame(0x40, [dives.length]));
    else if (cmd === 0x41) { chunks(frame(0x41, [36])); for (let i = 0; i < 36; i += 6) chunks(frame(0x42, dives[n - 1].h.slice(i, i + 6))); }
    else if (cmd === 0x43 && n === 2 && window.__stall) { /* device goes silent */ }
    else if (cmd === 0x43) { const p = readProfile(n); chunks(frame(0x43, [p.length >> 8, p.length & 255])); for (let i = 0; i < p.length; i += 6) chunks(frame(0x44, p.slice(i, i + 6))); }
    setTimeout(flush, 0);
  };
  const tx = { properties: { write: true }, writeValue: async (v) => { const s = new TextDecoder().decode(v); window.__tx.push(s.trim()); respond(s); } };
  const rx = { properties: { notify: true }, startNotifications: async () => {}, addEventListener: (_, h) => { handler = h; } };
  const dev = { gatt: { connected: false, connect: async () => { dev.gatt.connected = true; return { getPrimaryService: async () => ({ getCharacteristics: async () => [tx, rx] }) }; }, disconnect() { dev.gatt.connected = false; } }, addEventListener() {} };
  navigator.bluetooth = { requestDevice: async () => dev };
};

const browser = await chromium.launch();
let failed = 0;
for (const [name, devName, extra] of [["Pixel 7", "Pixel 7"], ["iPhone 13 (WebKit UA, fake BLE)", "iPhone 13"]]) {
  const ctx = await browser.newContext({ ...devices[devName], serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.clock.install({ time: new Date(2026, 10, 21, 14, 7, 9) });
  const uploaded = [];
  await page.route("**/api/dives", async (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: { dives: [] } });
    uploaded.push(...JSON.parse(r.request().postData()).dives); return r.fulfill({ json: { stored: uploaded.length } });
  });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  if (!devName.includes("iPhone")) await page.addInitScript(fakeBle);
  await page.goto(base);
  try {
    if (devName.includes("iPhone")) {
      // real iOS Chromium has no Web Bluetooth: expect the helpful banner, and the log must still be viewable
      await page.evaluate(() => { delete navigator.bluetooth; }); await page.reload();
      assert.match(await page.locator("#btBanner").innerText(), /Bluefy/);
    } else {
      await page.click("#connectBtn");
      await page.waitForFunction(() => /Dive sync done/.test(document.getElementById("diveProgress")?.textContent || ""), null, { timeout: 15000 });
      const tx = await page.evaluate(() => window.__tx);
      const setTime = tx.filter((t) => t.startsWith("#20"));
      assert.equal(setTime.length, 1, "clock set exactly once");
      const f = P.parseFrame("$" + setTime[0].slice(1)); // framing + checksum valid
      assert.equal(P.toHex(f.data).slice(0, 10), "2611211407", "clock = phone time (to the minute)");
      assert.ok(tx.indexOf(setTime[0]) < tx.findIndex((t) => t.startsWith("#43")), "clock set before dive download");
      assert.ok(tx.every((t) => !/^#(2[1-9a-f]|3)/i.test(t) || t.startsWith("#20")), "no writes other than clock");
      assert.match(await page.locator("#clockStatus").innerText(), /clock set/i);
      // the result is shown automatically (no hunting for the tab) and the count is in the nav
      assert.ok(await page.locator("#logView").isVisible(), "switched to the Dive log after a sync that saved dives");
      assert.match(await page.locator("#navLog").innerText(), /Dive log \(2\)/);
      assert.match(await page.locator("#lastSync").innerText(), /Last sync .*Dive sync done: 2 on device, 2 new/);
      await page.waitForFunction(() => getComputedStyle(document.getElementById("syncBanner")).display === "none", null, { timeout: 5000 });   // progress banner hidden when finished
      assert.equal(await page.locator("details.dive").count(), 2);
      // grouped by year: both dives are from 2025 -> one group, open by default (newest year)
      assert.equal(await page.locator("details.year").count(), 1);
      assert.match(await page.locator("details.year > summary").innerText(), /2025[\s\S]*2 dives[\s\S]*max \d+\.\d m/);
      assert.ok(await page.locator("details.year").evaluate((e) => e.open), "newest year starts open");
      assert.match(await page.locator("details.dive").first().innerText(), /^2\n/, "number without #"); assert.match(await page.locator("details.dive").last().innerText(), /^1\n/);
      assert.ok(!/#/.test(await page.locator("details.dive").first().locator("summary").innerText()), "no # in the dive row");
      assert.match(await page.locator("#diveList > p").first().innerText(), /2 dives . 2 with full depth profile/);      await page.locator("details.dive").last().locator("summary").click();
      await page.waitForSelector("details.dive[open] svg polyline");
      // technical details expose the raw header with undecoded bytes highlighted (to spot e.g. a location field)
      const tech = page.locator("details.dive[open] details.tech"); await tech.locator("summary").click();
      assert.ok((await tech.locator("table.hdr tr").count()) >= 15, "header map rendered");
      assert.ok((await tech.locator("tr.unk").count()) >= 3, "undecoded byte ranges highlighted");
      assert.match(await tech.innerText(), /no location \(GPS\) field/);
      // diagnostics file contains version, device traffic and the stored headers
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#diagSave")]);
      const diagText = fs.readFileSync(await dl.path(), "utf8");
      assert.match(diagText, /app version: \d+\.\d+\.\d+/); assert.match(diagText, /TX #40/); assert.match(diagText, /RX \$40/); assert.match(diagText, /header=[0-9a-f]{72}/);
      assert.equal(uploaded.length, 2, "both dives uploaded to cloud API");
      // second connect must not re-download profiles
      await page.evaluate(() => { window.__tx.length = 0; });
      await page.click("#diveSyncBtn");
      await page.waitForFunction(() => /0 new, 2 already saved/.test(document.getElementById("diveProgress").textContent), null, { timeout: 15000 });
      assert.equal((await page.evaluate(() => window.__tx)).filter((t) => t.startsWith("#43")).length, 0, "no profile re-download");
      await page.screenshot({ path: process.env.SHOT || "/tmp/shot-log.png", fullPage: true });
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, "horizontal overflow " + overflow);
    assert.deepEqual(errors, [], "page errors");
    console.log("PASS", name);
  } catch (e) { failed++; console.log("FAIL", name, "\n ", e.message); await page.screenshot({ path: "/tmp/fail.png" }); }
  await ctx.close();
}
// ---- scenario: the device stalls on dive 2 -> progress is visible, Cancel keeps dive 1, a re-sync finishes the rest ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  const uploaded = [];
  await page.route("**/api/dives", async (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: { dives: [] } });
    uploaded.push(...JSON.parse(r.request().postData()).dives); return r.fulfill({ json: { stored: uploaded.length } });
  });
  await page.addInitScript(fakeBle); await page.addInitScript(() => { window.__stall = true; });
  await page.goto(base);
  try {
    await page.click("#connectBtn");
    // progress is visible on the Device tab (banner), with the dive being fetched
    await page.waitForFunction(() => /Downloading dive 2 of 2/.test(document.getElementById("bannerText").textContent), null, { timeout: 15000 });
    assert.ok(await page.locator("#syncBanner").isVisible(), "banner visible while syncing, on every tab");
    assert.ok(await page.locator("#summaryView").isVisible() && !(await page.locator("#logView").isVisible()), "still on the tab you were on (Summary)");
    assert.match(await page.locator("#navLog").innerText(), /\(1\)/, "dive 1 already counted while dive 2 is still downloading");
    await page.click("#cancelSync");
    await page.waitForFunction(() => /Cancelled by you/.test(document.getElementById("diveProgress").textContent), null, { timeout: 10000 });
    assert.match(await page.locator("#diveProgress").innerText(), /1 dive\(s\) were saved/);
    await page.waitForFunction(() => getComputedStyle(document.getElementById("syncBanner")).display === "none", null, { timeout: 5000 });
    await page.waitForFunction(() => /Cancelled by you/.test(document.getElementById("lastSync")?.textContent || ""));
    assert.equal(uploaded.length, 1, "the dive that was saved is also uploaded");
    // the device recovers: a second sync only fetches what is missing
    await page.evaluate(() => { window.__stall = false; window.__tx.length = 0; });
    await page.click("#navLog"); await page.click("#diveSyncBtn");
    await page.waitForFunction(() => /Dive sync done: 2 on device, 1 new, 1 already saved/.test(document.getElementById("diveProgress").textContent), null, { timeout: 15000 });
    const reqs = (await page.evaluate(() => window.__tx)).filter((t) => t.startsWith("#43"));
    assert.equal(reqs.length, 1, "only the missing dive's profile was requested");
    assert.equal(uploaded.length, 2); assert.equal(await page.locator("details.dive").count(), 2);
    console.log("PASS cancel + resume");
  } catch (e) { failed++; console.log("FAIL cancel + resume\n ", e.message.split("\n").slice(0, 6).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-cancel.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: wrapped profile memory (what really happened on the real device) ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  await page.route("**/api/dives", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { dives: [] } }) : r.fulfill({ json: { stored: 3 } })));
  await page.addInitScript(() => { window.__wrap = true; }); await page.addInitScript(fakeBle);
  await page.goto(base);
  try {
    await page.click("#connectBtn");
    await page.waitForFunction(() => /Dive sync done: 3 on device, 3 new/.test(document.getElementById("diveProgress").textContent), null, { timeout: 15000 });
    assert.equal(await page.locator("details.dive").count(), 3);
    assert.match(await page.locator("#diveList > p").first().innerText(), /3 dives . 2 with full depth profile . 1 summary only/);
    const row = (n) => page.locator("details.dive", { has: page.locator(".dive-num", { hasText: new RegExp("^" + n + "$") }) });
    assert.match(await row(1).innerText(), /summary only/i, "dive #1: its profile was overwritten by dive #3");
    assert.equal(await row(3).locator(".badge").count(), 0, "dive #3 has its own profile (recovered from the wrapped slot)");
    await row(3).locator("summary").click(); await page.waitForSelector("details.dive[open] svg polyline");
    assert.equal(await row(3).locator(".numtile").innerText(), "3", "number tile without #"); assert.match(await row(3).innerText(), /dive number/);
    await row(1).locator("summary").click();
    assert.match(await row(1).locator(".note").innerText(), /no longer exists on the device/);
    assert.equal(await row(1).locator("svg").count(), 0, "no chart is drawn from another dive's bytes");
    console.log("PASS wrapped profile memory");
  } catch (e) {
    failed++; console.log("FAIL wrapped\n ", e.message.split("\n").slice(0, 4).join(" | "));
    console.log("  progress:", await page.evaluate(() => document.getElementById("diveProgress").textContent));
    console.log("  last log:", (await page.evaluate(() => (window.__diag || []).slice(-14))).join("\n            "));
    await page.screenshot({ path: "/tmp/fail-wrap.png", fullPage: true });
  }
  await ctx.close();
}
// ---- scenario: every change on the dive computer is confirmed (or honestly reported) ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  await page.route("**/api/**", (r) => r.fulfill({ status: 404, body: "{}" }));
  await page.addInitScript(() => { localStorage.setItem("optDives", "0"); }); await page.addInitScript(fakeBle);
  await page.goto(base);
  const toastText = async () => (await page.locator("#toast").innerText()).replace(/\s+/g, " ").trim();
  const waitToast = (re, cls) => page.waitForFunction(([src, c]) => { const t = document.getElementById("toast"); return new RegExp(src).test(t.textContent) && t.classList.contains(c); }, [re.source, cls], { timeout: 8000 });
  try {
    await page.click("#connectBtn"); await page.click("#navDevice"); await page.waitForSelector("#app", { state: "visible" });
    await page.waitForFunction(() => document.getElementById("clockStatus").textContent.includes("clock set"));
    // 1. a successful change: "Applying..." first, then a green confirmation that names what changed; the button flashes
    await page.locator("#bl7").tap();
    await waitToast(/Setting backlight/, "pending");
    await waitToast(/Backlight set to level 5/, "ok");
    assert.ok(await page.locator("#toast").evaluate((e) => e.classList.contains("show")), "toast visible");
    assert.ok(await page.locator("#bl7").evaluate((e) => e.classList.contains("applied") && e.classList.contains("selected")), "button flashed and selected");
    // 2. more kinds of settings
    await page.locator("#unit0").tap(); await waitToast(/Units set to Imperial/, "ok");
    await page.locator("#ecoOff").tap(); await waitToast(/Power-saving mode off/, "ok");
    await page.locator("#date1").tap(); await waitToast(/Date display set to last dive date/, "ok");
    await page.selectOption("#timeoutSel", "60"); await page.locator("#timeoutSel + button").tap(); await waitToast(/Screen timeout set to 1 min/, "ok");
    await page.locator(".tab", { hasText: "Environment" }).tap();
    await page.locator("#env1").tap(); await waitToast(/Environment set to High salinity/, "ok");
    await page.locator(".tab", { hasText: "Scuba" }).tap();
    await page.fill("#scubaDepth", "35"); await page.locator("#scubaDepth + button").tap(); await waitToast(/Depth alarm set to 35 m/, "ok");
    await page.fill("#scubaTime", "45"); await page.locator("#scubaTime + button").tap(); await waitToast(/Time alarm set to 45 min/, "ok");
    await page.locator("#safeGroup .btn-opt", { hasText: "Prog" }).tap(); await waitToast(/Safety factor set to Progressive/, "ok");
    await page.locator(".tab", { hasText: "Freedive" }).tap();
    await page.fill("#fd3", "22"); await page.locator("#fd3 + button").tap(); await waitToast(/Freedive depth alarm 3 set to 22 m/, "ok");
    await page.fill("#fd6", "48"); await page.locator("#fd6 + button").tap(); await waitToast(/Freedive depth alarm 6 set to 48 m/, "ok");
    // the partner of a paired alarm must not be disturbed (alarms are written in pairs)
    assert.equal(await page.inputValue("#fd4"), "40"); assert.equal(await page.inputValue("#fd5"), "45");
    // 3. clock: no read-back exists, so the message says what is actually known
    await page.locator(".tab", { hasText: "General" }).tap();
    await page.locator("button", { hasText: "Sync Now" }).tap(); await waitToast(/Clock set to \d\d:\d\d:\d\d.* \(phone time\)/, "ok");
    // 4. the device does NOT apply the change: an honest warning, and the screen goes back to what the device really has
    await page.evaluate(() => { window.__ignoreWrites = true; });
    await page.locator("#unit1").tap();
    await waitToast(/Not applied: the dive computer still shows Imperial/, "warn");
    assert.ok(await page.locator("#unit0").evaluate((e) => e.classList.contains("selected")), "UI reverted to the device's real value");
    assert.ok(!(await page.locator("#unit1").evaluate((e) => e.classList.contains("selected"))));
    // 5. the device rejects the change
    await page.evaluate(() => { window.__ignoreWrites = false; window.__rejectWrites = true; });
    await page.locator("#unit1").tap(); await waitToast(/rejected/, "err");
    // 6. back to normal: the next change confirms again; rapid taps are applied one after another, all confirmed
    await page.evaluate(() => { window.__rejectWrites = false; });
    await page.locator("#unit1").tap(); await waitToast(/Units set to Metric/, "ok");
    await page.locator("#bl3").tap(); await page.locator("#bl4").tap(); await waitToast(/Backlight set to level 2/, "ok");
    assert.ok(await page.locator("#bl4").evaluate((e) => e.classList.contains("selected")));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll");
    await page.screenshot({ path: process.env.SHOT_TOAST || "/tmp/shot-toast.png" });
    console.log("PASS setting confirmations");
  } catch (e) { failed++; console.log("FAIL setting confirmations\n ", e.message.split("\n").slice(0, 4).join(" | "), "\n  toast now:", await toastText().catch(() => "?")); await page.screenshot({ path: "/tmp/fail-settings.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: summary page + dive locations (asked after each sync, per date) ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  await page.clock.install({ time: new Date(2025, 2, 17, 12, 0, 0) });
  const uploaded = [], locCalls = [];
  await page.route("**/api/dives/location", (r) => { locCalls.push(JSON.parse(r.request().postData()).items); return r.fulfill({ json: { updated: 1 } }); });
  await page.route("**/api/dives", async (r) => {
    if (r.request().method() === "GET") return r.fulfill({ json: { dives: [] } });
    uploaded.push(...JSON.parse(r.request().postData()).dives); return r.fulfill({ json: { stored: uploaded.length } });
  });
  await page.addInitScript(fakeBle); await page.goto(base);
  const until = async (fn, what) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await page.waitForTimeout(50); } throw new Error("timed out waiting for " + what); };
  const chips = () => page.locator(".dh-loc").allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, " ").trim()));
  const toastIs = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("toast").textContent), re.source, { timeout: 8000 });
  try {
    // the app opens on the Summary tab; with no dives it says so
    assert.ok(await page.locator("#summaryView").isVisible()); assert.match(await page.locator("#sumEmpty").innerText(), /No dives yet/);
    await page.click("#connectBtn");
    await page.waitForFunction(() => /Dive sync done: 2 on device, 2 new/.test(document.getElementById("diveProgress").textContent), null, { timeout: 15000 });
    // 1. after the sync we are asked where we dived, one row per DATE, oldest first
    assert.ok(await page.locator("#logView").isVisible(), "switched to the Dive log"); await page.waitForSelector("#locPrompt", { state: "visible", timeout: 5000 });
    assert.match(await page.locator("#locPrompt h3").innerText(), /Where did you dive\?/);
    const rows = page.locator("#locPrompt .locask"); assert.equal(await rows.count(), 2);
    assert.match(await rows.nth(0).locator("label").innerText(), /14.*2025|2025.*14/); assert.match(await rows.nth(1).locator("label").innerText(), /15.*2025|2025.*15/);
    assert.equal(await page.locator("#locPrompt .same").count(), 1, "no 'same as above' on the first row");
    await page.fill("#locIn0", "  Komodo "); await page.locator("#locPrompt .same").tap();
    assert.equal(await page.inputValue("#locIn1"), "  Komodo ", "same as above copies the value");
    await page.click("#locSave"); await toastIs(/Location saved for 2 dives/);
    assert.ok(!(await page.locator("#locPrompt").isVisible()), "question closed");
    assert.deepEqual(await chips(), ["\u{1F4CD} Komodo", "\u{1F4CD} Komodo"]);
    await until(() => locCalls.length >= 1, "the location update to reach the cloud");
    assert.equal(locCalls.length, 1); assert.deepEqual(locCalls[0].map((i) => i.location), ["Komodo", "Komodo"]); assert.equal(locCalls[0].length, 2);
    assert.ok(uploaded.every((d) => /^[0-9a-f]{12}$/.test(d.fingerprint)), "dives were uploaded before their location");
    // 2. summary: last dive date (with how long ago and where) and total dive time
    await page.click("#navSummary");
    assert.match(await page.locator("#sumLastDate").innerText(), /March 15, 2025|15 March 2025/);
    assert.match(await page.locator("#sumLastSub").innerText(), /2 days ago.*Komodo/);
    assert.equal(await page.locator("#sumHours").innerText(), "0 h 42 min"); assert.match(await page.locator("#sumCount").innerText(), /across 2 dives/);
    // 3. it survives a reload (stored on the phone)
    await page.reload(); await page.click("#navLog"); await page.waitForSelector(".dh-loc");
    assert.deepEqual(await chips(), ["\u{1F4CD} Komodo", "\u{1F4CD} Komodo"]);
    // 4. change the place of one date from its header; a known place is always written with its existing spelling
    await page.locator(".dh-loc").last().tap(); await page.waitForSelector(".dh-edit input");
    assert.ok(await page.locator("#locList option[value='Komodo']").count(), "known places are suggested");
    await page.evaluate(() => Dives.render());                                              // a background refresh must not wipe what is being typed
    await page.fill(".dh-edit input", "Banda"); await page.evaluate(() => Dives.render());
    assert.equal(await page.inputValue(".dh-edit input"), "Banda", "typing is not interrupted by a refresh");
    await page.locator(".dh-save").tap(); await toastIs(/Location saved/); await until(() => locCalls.length >= 2, "the date edit to reach the cloud");
    const after = await chips(); assert.ok(after.includes("\u{1F4CD} Banda") && after.includes("\u{1F4CD} Komodo"), after.join(" | "));
    assert.deepEqual(locCalls.at(-1).map((i) => i.location), ["Banda"]);
    await page.locator(".dh-loc", { hasText: "Banda" }).tap(); await page.fill(".dh-edit input", "KOMODO"); await page.locator(".dh-save").tap(); await toastIs(/Location saved/);
    await until(() => locCalls.length >= 3, "the second date edit to reach the cloud"); assert.deepEqual(locCalls.at(-1).map((i) => i.location), ["Komodo"], "re-uses the existing spelling");
    // 5. per-dive field inside the dive
    await page.locator("details.dive").first().locator("summary").tap(); await page.waitForSelector("details.dive[open] .dive-loc");
    await page.fill("details.dive[open] .dive-loc", "Tulamben"); await page.locator("details.dive[open] .dive-loc-save").tap(); await toastIs(/Location saved/);
    await until(async () => (await chips()).filter((c) => /Tulamben/.test(c)).length === 1, "the date header to show Tulamben");
    assert.ok(await page.locator("details.dive[open]").count(), "the dive you are editing stays open");
    // 6. clearing a place brings up the 'no location' banner; it opens the same question, pre-filled from other dives of that day where possible
    await page.locator(".dh-loc", { hasText: "Tulamben" }).tap(); await page.fill(".dh-edit input", ""); await page.locator(".dh-save").tap(); await toastIs(/Location cleared/);
    await page.waitForSelector("#locBanner", { state: "visible", timeout: 5000 }); assert.match(await page.locator("#locBannerText").innerText(), /1 dive has no location/);
    await page.click("#locBannerBtn"); await page.waitForSelector("#locPrompt .locask", { timeout: 5000 }); assert.equal(await page.locator("#locPrompt .locask").count(), 1);
    assert.ok(!(await page.locator("#locBanner").isVisible()), "the banner steps aside while its question is open");
    assert.doesNotMatch(await page.locator("#locPrompt p").innerText(), /same/, "no same-as-above hint for a single row");
    await page.locator("#locPrompt input").fill("Banda"); await page.click("#locSave"); await toastIs(/Location saved for 1 dive/);
    assert.ok(!(await page.locator("#locBanner").isVisible()), "banner gone when every dive has a place");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll");
    await page.screenshot({ path: process.env.SHOT_LOC || "/tmp/shot-loc.png", fullPage: true });
    console.log("PASS summary + locations");
  } catch (e) { failed++; console.log("FAIL summary + locations\n ", e.message.split("\n").slice(0, 4).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-loc.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: new header/account structure, regulator colours (70 orange, 90 red) + reset, month bulk locations ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  await page.clock.install({ time: new Date(2025, 2, 17, 12, 0, 0) });
  let reg = null; const regPuts = [], locCalls = [];
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", version: "9.9.9" } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null } }));
  await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } }));
  await page.route("**/api/dives/location", (r) => { locCalls.push(JSON.parse(r.request().postData()).items); return r.fulfill({ json: { updated: 1 } }); });
  await page.route("**/api/dives", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { dives: [] } }) : r.fulfill({ json: { stored: 1 } })));
  await page.route("**/api/regulator", (r) => { const m = r.request().method();
    if (m === "PUT") { reg = JSON.parse(r.request().postData()); regPuts.push(reg); } if (m === "DELETE") reg = null; return r.fulfill({ json: m === "GET" ? { regulator: reg } : { ok: true } }); });
  await page.addInitScript(fakeBle); await page.goto(base);
  const until = async (fn, what) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await page.waitForTimeout(50); } throw new Error("timed out waiting for " + what); };
  const toastIs = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("toast").textContent), re.source, { timeout: 8000 });
  const chips = () => page.locator(".dh-loc").allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, " ").trim()));
  const card = () => page.locator("#sumReg").evaluate((e) => ({ cls: e.className, role: e.getAttribute("role"), border: getComputedStyle(e).borderLeftColor, big: getComputedStyle(e.querySelector(".sum-big")).color, count: e.querySelector("#sumRegCount").textContent, msg: e.querySelector("#sumRegMsg").textContent, bar: e.querySelector("#sumRegBar").style.width }));
  try {
    // 1. new title, avatar at the top right, no Account tab, no version in the header or footer
    assert.equal(await page.title(), "Dive Manager"); assert.equal(await page.locator("h1").innerText(), "Dive Manager");
    const box = await page.locator("#acctBtn").boundingBox(), vw = page.viewportSize().width;
    assert.ok(box.x > vw / 2 && box.y < 80, "avatar sits at the top right"); assert.equal(await page.locator(".nav button").count(), 3, "Summary, Dive log, Device");
    assert.equal(await page.locator("#verTop, #appFooter, #navAccount").count(), 0, "no version badge in the header/footer, no Account tab");
    assert.ok(!/v\d+\.\d+\.\d+/.test(await page.locator("header").innerText()), "no version text in the header");
    // 2. sync: the question has a 'whole month' input; a date's own entry wins over it
    await page.click("#connectBtn");
    await page.waitForFunction(() => /Dive sync done: 2 on device, 2 new/.test(document.getElementById("diveProgress").textContent), null, { timeout: 15000 });
    await page.waitForSelector("#locPrompt", { state: "visible", timeout: 5000 });
    assert.equal(await page.locator("#locPrompt .month-in").count(), 1, "one month (March 2025) with two dates");
    assert.match(await page.locator("#locPrompt .monthask label").first().innerText(), /March 2025 . 2 dates/);
    await page.fill("#locPrompt .month-in", "Komodo"); await page.fill("#locIn0", "Banda"); await page.click("#locSave"); await toastIs(/Location saved for 2 dives/);
    await until(async () => (await chips()).length === 2, "date headers");
    const byDate = Object.fromEntries(await page.locator(".datehead").evaluateAll((els) => els.map((e) => [e.querySelector(".dh-date").textContent.trim(), e.querySelector(".dh-loc").textContent.replace(/\s+/g, " ").trim()])));
    assert.deepEqual(Object.values(byDate).sort(), ["\u{1F4CD} Banda", "\u{1F4CD} Komodo"], "14 March Banda (own entry), 15 March Komodo (the month's place)");
    // 3. month bulk in the log: keeps places already set unless 'replace' is ticked
    assert.match(await page.locator(".monthhead").first().innerText(), /March . 2 dives . Komodo, Banda/);
    await page.locator(".mh-set").tap(); await page.waitForSelector(".mh-edit input[type=text]");
    await page.fill(".mh-edit input[type=text]", "Tulamben"); await page.locator(".mh-save").tap(); await toastIs(/Every dive this month already has a place/);
    await page.locator(".mh-replace").check(); await page.locator(".mh-save").tap(); await toastIs(/Location saved for 2 dives/);
    await until(async () => (await chips()).every((c) => /Tulamben/.test(c)), "both dates to read Tulamben");
    await until(() => locCalls.length >= 2 && locCalls.at(-1).length === 2 && locCalls.at(-1).every((i) => i.location === "Tulamben"), "the bulk update to reach the cloud");
    // 4. Summary: no regulator yet -> a hint; Account sections in the requested order, with the version only inside Help
    await page.click("#navSummary"); assert.ok(await page.locator("#sumRegHint").isVisible()); assert.ok(!(await page.locator("#sumReg").isVisible()));
    await page.click("#acctBtn"); assert.ok(await page.locator("#accountView").isVisible()); assert.ok(await page.locator("#acctBtn").evaluate((e) => e.classList.contains("active")));
    assert.deepEqual(await page.locator("details.acc > summary").evaluateAll((e) => e.map((x) => x.textContent.replace(/\s+/g, " ").trim())), ["Profile picture", "Change password", "Dive certifications", "DAN insurance", "Regulator", "Help / app version"]);
    await page.locator("details.acc[data-sec=help] > summary").click();
    assert.equal(await page.locator("#appVer").innerText(), "v" + (await page.evaluate(() => self.APP_VERSION))); assert.match(await page.locator("#serverVer").innerText(), /newer version \(v9\.9\.9\) is available/);
    assert.ok(await page.locator("#signOut").isVisible()); assert.equal(await page.locator("#who").textContent(), "you@example.com");
    // 5. regulator: add it, watch the card turn green -> orange (70) -> red (90)
    await page.locator("details.acc[data-sec=regulator] > summary").click();
    await page.locator("#regAdd").tap(); await page.fill("#regName", "Apeks XTX50"); await page.fill("#regType", "Balanced piston"); await page.fill("#regBase", "68");
    await page.locator("#regSave").tap(); await toastIs(/Regulator saved/);
    assert.equal(await page.locator("#regShownCount").innerText(), "68"); assert.match(await page.locator("#regBadge").innerText(), /68 dives/);
    assert.deepEqual({ ...regPuts.at(-1), since: typeof regPuts.at(-1).since }, { name: "Apeks XTX50", type: "Balanced piston", baseline: 68, since: "string" }, "stored with the starting count");
    await page.click("#navSummary"); await until(async () => (await card()).count === "68", "the Summary card");
    let c = await card(); assert.equal(c.cls, "card sum reg-ok"); assert.equal(c.border, "rgb(43, 138, 62)"); assert.match(c.msg, /Service is due at 70 dives \(2 to go\)/);
    const edit = async (n) => { await page.click("#acctBtn"); await page.locator("#regEdit").tap(); await page.fill("#regBase", String(n)); await page.locator("#regSave").tap(); await toastIs(/Regulator saved/); await page.click("#navSummary"); await until(async () => (await card()).count === String(n), "count " + n); return card(); };
    c = await edit(69); assert.equal(c.cls, "card sum reg-ok", "69 is still green");
    c = await edit(70); assert.equal(c.cls, "card sum reg-orange", "70 turns orange"); assert.equal(c.border, "rgb(230, 119, 0)"); assert.equal(c.big, "rgb(217, 72, 15)"); assert.equal(c.role, "alert"); assert.match(c.msg, /Service soon: 20 dives to the 90-dive limit/);
    c = await edit(89); assert.equal(c.cls, "card sum reg-orange", "89 is still orange");
    c = await edit(90); assert.equal(c.cls, "card sum reg-red", "90 turns red"); assert.equal(c.border, "rgb(201, 42, 42)"); assert.equal(c.big, "rgb(201, 42, 42)"); assert.match(c.msg, /Service now/); assert.equal(c.bar, "100%");
    assert.match(await page.locator("#regBadge").evaluate((e) => e.className), /red/, "badge in the Account list is red too");
    // 6. reset to 0 (needs a second tap), then every new dive adds one
    await page.click("#acctBtn"); await page.locator("#regReset").tap();
    assert.match(await page.locator("#regReset").innerText(), /Tap again/); assert.equal(await page.locator("#regShownCount").innerText(), "90", "the first tap does not reset");
    await page.locator("#regReset").tap(); await toastIs(/reset to 0/);
    assert.equal(await page.locator("#regShownCount").innerText(), "0"); assert.deepEqual(regPuts.at(-1), { name: "Apeks XTX50", type: "Balanced piston", baseline: 0, since: "2025-03-15T08:05:00" }, "since = the latest dive logged so far");
    await page.click("#navSummary"); await until(async () => (await card()).cls === "card sum reg-ok" && (await card()).count === "0", "green at 0");
    await page.evaluate(() => window.__dives.push(window.__d3));                    // a new dive appears on the dive computer
    await page.click("#navLog"); await page.click("#diveSyncBtn");
    await page.waitForFunction(() => /Dive sync done: 3 on device, 1 new/.test(document.getElementById("diveProgress").textContent), null, { timeout: 15000 });
    await page.click("#navSummary"); await until(async () => (await card()).count === "1", "the new dive to count");
    assert.match((await card()).msg, /\(69 to go\)/);
    // 7. remove
    await page.click("#acctBtn"); await page.locator("#regRemove").tap(); await page.locator("#regRemove").tap(); await toastIs(/Regulator removed/);
    await page.click("#navSummary"); await until(async () => !(await page.locator("#sumReg").isVisible()) && (await page.locator("#sumRegHint").isVisible()), "card gone, hint back");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll");
    console.log("PASS account structure + regulator + month bulk");
  } catch (e) { failed++; console.log("FAIL account structure + regulator + month bulk\n ", e.message.split("\n").slice(0, 4).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-acct.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: Summary diver card (name, latest certification, DAN + validity) and the DAN section ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  await page.clock.install({ time: new Date(2025, 2, 17, 12, 0, 0) });
  const profile = { avatar: null, fullName: "", dan: { number: "", plan: "", validUntil: "" } }, files = []; let seq = 0; const calls = [];
  const PDFB = (n = 0) => Buffer.from("%PDF-1.4\n" + "x".repeat(n) + "\n%%EOF\n");
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", name: "Google Name", version: "0.0.0" } }));
  await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } }));
  await page.route("**/api/dives", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { dives: [] } }) : r.fulfill({ json: { stored: 1 } })));
  await page.route("**/api/profile", (r) => r.fulfill({ json: profile }));
  await page.route("**/api/profile/name", (r) => { const b = JSON.parse(r.request().postData()); calls.push(["name", b]); profile.fullName = b.fullName; return r.fulfill({ json: { ok: true } }); });
  await page.route("**/api/profile/dan", (r) => { const m = r.request().method();
    if (m === "PUT") { const b = JSON.parse(r.request().postData()); calls.push(["dan", b]); profile.dan = { number: b.number, plan: b.plan || "", validUntil: b.validUntil || "" }; } else profile.dan = { number: "", plan: "", validUntil: "" };
    return r.fulfill({ json: { ok: true } }); });
  await page.route("**/api/certs", (r) => { if (r.request().method() === "POST") { const b = JSON.parse(r.request().postData()); calls.push(["file", { ...b, data: undefined }]);
      const f = { id: (++seq).toString(16).padStart(16, "0"), label: b.label, number: b.number, kind: b.kind, certifiedOn: b.certifiedOn, filename: b.filename, mime: b.mime, size: 100, createdAt: "2025-03-1" + seq, data: b.data }; files.push(f); return r.fulfill({ json: { id: f.id } }); }
    return r.fulfill({ json: { certs: files.map(({ data, ...m }) => m) } }); });
  await page.route(/\/api\/certs\/[0-9a-f]{16}$/, (r) => { const id = r.request().url().split("/").pop(), i = files.findIndex((f) => f.id === id);
    if (r.request().method() === "DELETE") { if (i >= 0) files.splice(i, 1); return r.fulfill({ json: { deleted: 1 } }); } return r.fulfill({ json: { cert: files[i] } }); });
  await page.goto(base);
  const until = async (fn, what) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await page.waitForTimeout(50); } throw new Error("timed out waiting for " + what); };
  const toastIs = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("toast").textContent), re.source, { timeout: 8000 });
  const diver = () => page.evaluate(() => ({ name: document.getElementById("sumName").textContent, cert: document.getElementById("sumCert").textContent, certSub: document.getElementById("sumCertSub").textContent,
    danCls: document.getElementById("sumDanRow").className, dan: document.getElementById("sumDan").textContent, valid: document.getElementById("sumDanValid").textContent.replace(/\s+/g, " "),
    validColor: getComputedStyle(document.getElementById("sumDanValid")).color, rowBorder: getComputedStyle(document.getElementById("sumDanRow")).borderLeftColor }));
  const setDan = async (n, plan, valid) => { await page.fill("#danNumber", n); await page.fill("#danPlan", plan); await page.fill("#danValid", valid); await page.click("#danSave"); await toastIs(/DAN details saved/); };
  try {
    // icons: a dive flag for the certification, the DAN logo for the membership (no emoji)
    assert.equal(await page.locator("#sumDiver .diver-row svg.flag").count(), 1, "dive flag on the certification row");
    assert.equal(await page.locator("#sumDiver .diver-row .ico", { hasText: /\S/ }).count(), 0, "no emoji or text icons left");
    assert.ok(await page.locator("#sumDanRow img.dan-logo").evaluate((i) => i.complete && i.naturalWidth > 50), "the DAN logo loads");
    assert.equal(await page.locator("#sumDiver .diver-row svg.flag polygon").getAttribute("fill"), "#fff");
    await page.locator("#sumDiver").screenshot({ path: process.env.SHOT_DIVER || "/tmp/shot-diver.png" });
    // 1. nothing entered yet: placeholders and hints; your Google name is the fallback for the name
    await until(async () => (await diver()).name === "Google Name", "the Google name as a fallback");
    let d = await diver(); assert.equal(d.cert, "None added yet"); assert.equal(d.dan, "Not added yet"); assert.match(d.danCls, /dan-none/); assert.match(d.certSub, /Add one in Account/);
    // 2. name: the field is pre-filled with the Google name, saving stores YOUR name
    await page.click("#acctBtn"); await page.locator("details.acc[data-sec=profile] > summary").click();
    assert.equal(await page.inputValue("#fullName"), "Google Name", "suggested, not yet saved"); assert.equal(profile.fullName, "");
    await page.fill("#fullName", "  Togar Hugo "); await page.click("#nameSave"); await toastIs(/Name saved/); assert.equal(profile.fullName, "Togar Hugo");
    await page.click("#navSummary"); await until(async () => (await diver()).name === "Togar Hugo", "the saved name");
    // 3. DAN details: green when valid, orange within 60 days, red when expired (clock is 17 Mar 2025)
    await page.click("#acctBtn"); await page.locator("details.acc[data-sec=dan] > summary").click();
    await page.fill("#danNumber", ""); await page.click("#danSave"); assert.match(await page.locator("#danState").innerText(), /Enter your DAN member number/); assert.equal(calls.filter((c) => c[0] === "dan").length, 0);
    await setDan("4412 3399", "DAN Master", "2026-03-31");
    assert.deepEqual(calls.at(-1), ["dan", { number: "4412 3399", plan: "DAN Master", validUntil: "2026-03-31" }]);
    assert.match(await page.locator("#danState").innerText(), /Valid until .*2026 . 12 months left/); assert.equal(await page.locator("#danBadge").innerText(), "Valid");
    await page.click("#navSummary"); d = await diver(); await page.locator("#sumDiver").screenshot({ path: process.env.SHOT_DIVER_DAN || "/tmp/shot-diver-dan.png" });
    assert.match(d.danCls, /dan-ok/); assert.equal(d.dan, "#4412 3399 \u00b7 DAN Master"); assert.match(d.valid, /Valid until .*2026 . 12 months left/); assert.equal(d.rowBorder, "rgb(43, 138, 62)"); assert.equal(d.validColor, "rgb(43, 138, 62)");
    await page.click("#acctBtn"); await setDan("4412 3399", "DAN Master", "2025-04-30"); await page.click("#navSummary"); d = await diver();
    assert.match(d.danCls, /dan-soon/); assert.match(d.valid, /Valid until .*2025 . 44 days left/); assert.equal(d.rowBorder, "rgb(230, 119, 0)"); assert.equal(d.validColor, "rgb(217, 72, 15)");
    await page.click("#acctBtn"); assert.equal(await page.locator("#danBadge").innerText(), "44 days left");
    await setDan("4412 3399", "DAN Master", "2025-03-01"); await page.click("#navSummary"); d = await diver();
    assert.match(d.danCls, /dan-expired/); assert.match(d.valid, /^Expired .*2025 . 16 days ago$/); assert.equal(d.rowBorder, "rgb(201, 42, 42)"); assert.equal(d.validColor, "rgb(201, 42, 42)");
    await page.click("#acctBtn"); assert.equal(await page.locator("#danBadge").innerText(), "Expired");
    // 4. files: a DAN document goes to the DAN list (named by default), certifications to theirs, never mixed
    await page.setInputFiles("#danFile", { name: "dan-card.pdf", mimeType: "application/pdf", buffer: PDFB() });
    assert.equal(await page.inputValue("#danLabel"), "DAN insurance card"); await page.fill("#danDocNumber", "POL-77"); await page.click("#danAdd"); await toastIs(/Insurance document uploaded/);
    await until(async () => (await page.locator("#danList .cert").count()) === 1, "the DAN document"); assert.equal(await page.locator("#certList .cert").count(), 0, "not listed as a certification");
    assert.equal(calls.at(-1)[1].kind, "dan"); assert.match(await page.locator("#danList .cert").innerText(), /DAN insurance card[\s\S]*policy #POL-77[\s\S]*dan-card\.pdf/);
    // 5. latest certification = the newest date earned, not the newest upload
    await page.locator("details.acc[data-sec=certs] > summary").click();
    const addCert = async (label, num, date, name) => { const before = await page.locator("#certList .cert").count(); await page.fill("#certLabel", label); await page.fill("#certNumber", num); await page.fill("#certDate", date); await page.setInputFiles("#certFile", { name, mimeType: "application/pdf", buffer: PDFB() }); await page.click("#certAdd");
      await until(async () => (await page.locator("#certList .cert").count()) === before + 1 && (await page.inputValue("#certLabel")) === "", "the upload to finish and the form to clear"); };
    await addCert("PADI Open Water", "OW-1", "2019-05-04", "ow.pdf"); await addCert("PADI Advanced Open Water", "AOW-2", "2023-06-10", "aow.pdf");
    await page.fill("#certLabel", "Old card, date unknown"); await page.setInputFiles("#certFile", { name: "old.pdf", mimeType: "application/pdf", buffer: PDFB() }); await page.click("#certAdd");
    await until(async () => (await page.locator("#certList .cert").count()) === 3 && (await page.inputValue("#certLabel")) === "", "three certifications"); assert.equal(calls.at(-1)[1].certifiedOn, "", "date is optional");
    assert.equal(await page.locator("#danList .cert").count(), 1);
    await page.click("#navSummary"); d = await diver(); assert.equal(d.cert, "PADI Advanced Open Water"); assert.match(d.certSub, /#AOW-2 . Jun 10, 2023/, "newest date earned; the undated card uploaded last does not win");
    await page.click("#acctBtn"); const del = page.locator("#certList .cert", { hasText: "PADI Advanced" }).locator(".cert-del"); await del.click(); await del.click(); await toastIs(/Certification deleted/);
    await page.click("#navSummary"); await until(async () => (await diver()).cert === "PADI Open Water", "the latest certification to fall back to Open Water");
    // 6. tapping the card leads to the right Account section; removing DAN resets its row
    await page.locator("#sumDanRow").click(); assert.ok(await page.locator("#accountView").isVisible()); assert.ok(await page.locator("details.acc[data-sec=dan]").evaluate((e) => e.open));
    await page.locator("#danClear").click(); await page.locator("#danClear").click(); await toastIs(/DAN details removed/);
    await page.click("#navSummary"); d = await diver(); assert.equal(d.dan, "Not added yet"); assert.match(d.danCls, /dan-none/); assert.equal(profile.dan.number, "");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll");
    await page.screenshot({ path: process.env.SHOT_DIVER || "/tmp/shot-diver.png", fullPage: true });
    console.log("PASS diver card + DAN");
  } catch (e) { failed++; console.log("FAIL diver card + DAN\n ", e.message.split("\n").slice(0, 4).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-diver.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: choose which certification is your latest (the Summary was showing the wrong one) ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  let pinned = ""; const calls = [];
  const files = [["0000000000000001", "PADI Dive Master", "2026-05-01 10:00:00"], ["0000000000000002", "SSI Advance Adventurer", "2026-05-01 10:05:00"], ["0000000000000003", "PADI EFR", "2026-05-01 10:02:00"]]
    .map(([id, label, createdAt]) => ({ id, label, number: "", kind: "cert", certifiedOn: "", filename: label + ".jpg", mime: "image/jpeg", size: 100, createdAt }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", name: "Me", version: "0.0.0" } }));
  await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } }));
  await page.route("**/api/dives", (r) => r.fulfill({ json: { dives: [] } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Me", latestCertId: pinned, dan: { number: "", plan: "", validUntil: "" } } }));
  await page.route("**/api/profile/latest-cert", (r) => { const b = JSON.parse(r.request().postData()); calls.push(b.id); pinned = b.id; return r.fulfill({ json: { ok: true } }); });
  await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: files } }));
  await page.goto(base);
  try {
    const cert = () => page.locator("#sumCert").innerText();
    await page.waitForFunction(() => document.getElementById("sumCert").textContent !== "None added yet", null, { timeout: 8000 });
    assert.equal(await cert(), "SSI Advance Adventurer", "without dates the last upload is picked (the wrong result the user saw)");
    await page.click("#acctBtn"); await page.locator("details.acc[data-sec=certs] > summary").click();
    assert.equal(await page.locator("#certList .latest-tag").count(), 1, "exactly one is marked latest"); assert.match(await page.locator("#certList .cert.latest").innerText(), /Advance Adventurer/);
    assert.equal(await page.locator("#certList .cert-latest").count(), 2, "the other two offer 'Set as my latest certification'");
    assert.equal(await page.locator("#certAuto").isVisible(), false, "no 'use newest' button while automatic");
    await page.locator("#certList .cert", { hasText: "Dive Master" }).locator(".cert-latest").click();
    await page.waitForFunction(() => /Dive Master/.test(document.querySelector("#certList .cert.latest")?.textContent || ""), null, { timeout: 5000 });
    assert.deepEqual(calls, ["0000000000000001"]); assert.equal(await page.locator("#certList .latest-tag").count(), 1);
    assert.ok(await page.locator("#certAuto").isVisible(), "a way back to automatic appears"); assert.match(await page.locator("#certLatestHint").innerText(), /You chose/);
    await page.click("#navSummary"); assert.equal(await cert(), "PADI Dive Master", "the Summary now shows the one you chose");
    await page.reload(); await page.waitForFunction(() => /Dive Master/.test(document.getElementById("sumCert").textContent), null, { timeout: 8000 });
    assert.equal(await cert(), "PADI Dive Master", "still the one you chose after a reload (saved in your account)");
    await page.click("#acctBtn"); await page.locator("details.acc[data-sec=certs] > summary").click(); await page.click("#certAuto");
    await page.waitForFunction(() => /Advance Adventurer/.test(document.getElementById("certList").querySelector(".cert.latest")?.textContent || ""), null, { timeout: 5000 });
    assert.deepEqual(calls, ["0000000000000001", ""], "back to automatic");
    console.log("PASS latest certification");
  } catch (e) { failed++; console.log("FAIL latest certification\n ", e.message.split("\n").slice(0, 6).join(" | ")); await page.screenshot({ path: "/tmp/fail-latest.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: second dive computer (Shearwater Peregrine): import a UDDF file, separate log, grid chart, boxed numbers ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  const uploaded = [], errors2 = []; page.on("pageerror", (e) => errors2.push(e.message));
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", name: "Me", version: "0.0.0" } }));
  await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: { name: "Tecline", type: "R4", baseline: 0, since: "" } } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Me", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } }));
  await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } }));
  await page.route("**/api/dives/location", (r) => r.fulfill({ json: { updated: 1 } }));
  await page.route("**/api/dives", (r) => { if (r.request().method() === "GET") return r.fulfill({ json: { dives: [] } });
    const b = JSON.parse(r.request().postData()); uploaded.push(...b.dives); return r.fulfill({ json: { stored: b.dives.length } }); });
  await page.addInitScript(fakeBle); await page.addInitScript(() => { window.__wrap = false; });
  await page.goto(base);
  const wp = (t, d, k) => `<waypoint><divetime>${t}</divetime><depth>${d}</depth><temperature>${k}</temperature></waypoint>`;
  const dive = (when, num, maxd, dur) => `<dive id="d${num}"><informationbeforedive><datetime>${when}</datetime><divenumber>${num}</divenumber></informationbeforedive><tankdata><link ref="ean32"/></tankdata><samples>${[wp(0, 0, 302.15), wp(60, maxd / 2, 301.65), wp(120, maxd, 301.15), wp(180, maxd / 2, 301.65), wp(240, 0, 302.15)].join("")}</samples><informationafterdive><greatestdepth>${maxd}</greatestdepth><diveduration>${dur}</diveduration><lowesttemperature>301.15</lowesttemperature></informationafterdive></dive>`;
  const uddf = (dives) => Buffer.from(`<?xml version="1.0"?><uddf version="3.2.0" xmlns="http://www.streit.cc/uddf/3.2/"><gasdefinitions><mix id="ean32"><o2>0.32</o2></mix></gasdefinitions><profiledata><repetitiongroup>${dives}</repetitiongroup></profiledata></uddf>`);
  try {
    // two Cosmiq dives first (14 and 15 March 2025), then the Peregrine file with one dive that overlaps Cosmiq dive 1 (same dive worn on both wrists) and two new ones
    await page.click("#connectBtn"); await page.waitForFunction(() => /Dive sync done: 2 on device, 2 new/.test(document.getElementById("diveProgress").textContent), null, { timeout: 15000 });
    await page.click("#locLater").catch(() => {});
    assert.ok(await page.locator("#devTabs").isVisible(), "computer selector in the dive log");
    assert.equal(await page.locator("#devTabs button").count(), 2); assert.match(await page.locator("#devTabs button.active").innerText(), /Cosmiq\+ Gen 5.*2/);
    assert.ok(await page.locator("#syncCard").isVisible() && !(await page.locator("#importCard").isVisible()), "Cosmiq shows the sync card");
    await page.locator("#devTabs button", { hasText: "Peregrine" }).click(); await page.waitForSelector("#importCard", { state: "visible" });
    assert.ok(await page.locator("#importCard").isVisible() && !(await page.locator("#syncCard").isVisible()), "Peregrine shows the import card, not the Bluetooth sync");
    assert.match(await page.locator("#diveList").innerText(), /No Shearwater Peregrine dives yet/);
    const bad = { name: "log.uddf", mimeType: "application/xml", buffer: Buffer.from("<html><body>hello</body></html>") };
    await page.setInputFiles("#impFile", bad); await page.waitForFunction(() => /not a UDDF/.test(document.getElementById("impMsg").textContent), null, { timeout: 5000 });
    assert.equal(uploaded.filter((d) => d.device === "peregrine").length, 0, "nothing uploaded from a bad file"); assert.equal(await page.locator("details.dive").count(), 0);
    const good = { name: "shearwater.uddf", mimeType: "application/xml", buffer: uddf(dive("2025-03-14T09:33:10", 41, 28.4, 2520) + dive("2025-03-16T10:00:00", 42, 18.2, 2400) + dive("2025-03-16T14:00:00", 43, 12.5, 3000)) };
    await page.setInputFiles("#impFile", good);
    await page.waitForFunction(() => /3 new dives imported/.test(document.getElementById("impMsg").textContent), null, { timeout: 8000 });
    assert.match(await page.locator("#impMsg").innerText(), /3 uploaded/);
    assert.equal(uploaded.length, 5, "2 Cosmiq + 3 Peregrine"); const u = uploaded.find((d) => d.startedAt === "2025-03-16T10:00:00");
    assert.equal(u.device, "peregrine"); assert.equal(u.headerHex, ""); assert.equal(u.maxDepthM, 18.2); assert.equal(u.o2Percent, 32); const x = JSON.parse(u.extra); assert.equal(x.n, 42); assert.equal(x.s.length, 5); assert.deepEqual(x.s[2], [120, 18.2, 28]);
    // separate logs: Peregrine tab lists only its 3 dives, the Cosmiq tab still only its 2
    assert.equal(await page.locator("details.dive").count(), 3); assert.match(await page.locator("#devTabs button.active").innerText(), /Peregrine.*3/);
    assert.match(await page.locator("#diveList > p").first().innerText(), /^3 dives$/);
    await page.locator("#devTabs button", { hasText: "Cosmiq" }).click(); await page.waitForFunction(() => document.querySelectorAll("details.dive").length === 2, null, { timeout: 5000 });
    assert.match(await page.locator("#navLog").innerText(), /Dive log \(5\)/, "the nav counts every dive");
    // the choice is remembered
    await page.locator("#devTabs button", { hasText: "Peregrine" }).click(); await page.waitForFunction(() => document.querySelectorAll("details.dive").length === 3, null, { timeout: 5000 });
    // dive numbers: bold, boxed, no '#'
    const num = page.locator("details.dive .dive-num").first();
    assert.equal(await num.innerText(), "43"); const st = await num.evaluate((e) => { const c = getComputedStyle(e); return { w: c.fontWeight, br: c.borderTopWidth, bg: c.backgroundColor, rad: c.borderTopLeftRadius }; });
    assert.ok(+st.w >= 700, "bold"); assert.equal(st.br, "1px"); assert.notEqual(st.bg, "rgba(0, 0, 0, 0)"); assert.notEqual(st.rad, "0px");
    // a dive with the grid: horizontal depth lines labelled in metres, vertical time lines in minutes
    await page.locator("details.dive", { has: page.locator(".dive-num", { hasText: /^41$/ }) }).locator("summary").click();
    const svg = page.locator("details.dive[open] svg.chart"); await svg.waitFor();
    const lines = await svg.locator("line").count(); assert.ok(lines >= 6, "grid lines drawn: " + lines);
    const labels = await svg.locator("text").evaluateAll((els) => els.map((e) => e.textContent)); assert.ok(labels.includes("0 m") && labels.includes("10") && labels.includes("30"), "depth labels: " + labels.join(","));
    await page.screenshot({ path: process.env.SHOT_PEREGRINE || "/tmp/shot-peregrine.png", fullPage: true });
    assert.match(await svg.getAttribute("aria-label"), /gridlines every 10 m/);
    assert.match(await page.locator("details.dive[open]").innerText(), /28\.4 m[\s\S]*42 min[\s\S]*28\.0 .C[\s\S]*32%/);
    assert.match(await page.locator("details.dive[open]").innerText(), /Imported from a file/);
    // the same file again adds nothing; the same dive on both wrists counts once in the Summary and the regulator
    await page.setInputFiles("#impFile", good); await page.waitForFunction(() => /0 new dives imported, 3 already there/.test(document.getElementById("impMsg").textContent), null, { timeout: 8000 });
    assert.equal(uploaded.length, 5, "no duplicate upload");
    await page.click("#navSummary");
    assert.match(await page.locator("#sumCount").innerText(), /across 4 dives . 1 recorded on both computers, counted once \(Cosmiq\+ used\)/, "5 logged, one recorded by both computers = 4, and the Summary says so");
    assert.equal(await page.locator("#sumRegCount").innerText(), "3", "regulator: 4 dives minus the freedive; the dive on both wrists counted once");
    // location prompt covers imported dives, and saving it reaches them
    await page.click("#navLog"); await page.waitForSelector("#locPrompt input", { state: "visible" });
    assert.equal(await page.locator("details.dive", { has: page.locator(".dive-num", { hasText: /^41$/ }) }).locator(".badge.also").count(), 1, "the Peregrine copy of the dive Cosmiq also recorded is marked");
    assert.equal(await page.locator("details.dive .badge.also").count(), 1, "and only that one");
    assert.match(await page.locator("#locPrompt h3").innerText(), /Where did you dive/); assert.match(await page.locator("#locPrompt").innerText(), /imported dives?/);
    const locCalls = []; await page.unroute("**/api/dives/location"); await page.route("**/api/dives/location", (r) => { locCalls.push(...JSON.parse(r.request().postData()).items); return r.fulfill({ json: { updated: 1 } }); });
    const firstIn = page.locator("#locPrompt .locask input").first(); await firstIn.fill("Banda"); await page.click("#locSave");
    await page.waitForFunction(() => /Location saved for/.test(document.getElementById("toast").textContent), null, { timeout: 5000 });
    assert.ok(locCalls.length >= 1 && locCalls.every((i) => i.location === "Banda"), "the place of imported dives is sent to the cloud: " + JSON.stringify(locCalls));
    // reload: imported dives come back from the cloud (device + extra) and the selected computer is remembered
    const stored = uploaded.filter((d) => d.device === "peregrine");
    await page.unroute("**/api/dives"); await page.route("**/api/dives", (r) => r.request().method() === "GET" ? r.fulfill({ json: { dives: stored.map((d) => ({ ...d, deviceMac: null, location: null })) } }) : r.fulfill({ json: { stored: 0 } }));
    await page.evaluate(() => indexedDB.deleteDatabase("cosmiq")); await page.reload();
    await page.waitForFunction(() => /Dive log \(3\)/.test(document.getElementById("navLog").textContent), null, { timeout: 8000 });
    await page.click("#navLog"); assert.match(await page.locator("#devTabs button.active").innerText(), /Peregrine.*3/, "remembered the computer");
    await page.locator("details.dive", { has: page.locator(".dive-num", { hasText: /^41$/ }) }).locator("summary").click(); await page.locator("details.dive[open] svg.chart").waitFor();
    assert.deepEqual(errors2, [], "page errors");
    console.log("PASS second dive computer");
  } catch (e) { failed++; console.log("FAIL second dive computer\n ", e.message.split("\n").slice(0, 8).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-peregrine.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: Shearwater Peregrine over (fake) Web Bluetooth: connect, download only new dives, errors are explained ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  const uploaded = [], errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", name: "Me", version: "0.0.0" } }));
  await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Me", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } }));
  await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } }));
  await page.route("**/api/dives/location", (r) => r.fulfill({ json: { updated: 1 } }));
  await page.route("**/api/dives", (r) => { if (r.request().method() === "GET") return r.fulfill({ json: { dives: [] } });
    const b = JSON.parse(r.request().postData()); uploaded.push(...b.dives); return r.fulfill({ json: { stored: b.dives.length } }); });
  const T = (d, h) => Date.UTC(2026, 4, d, h, 30) / 1000, mk = (ticks, d10, n) => ({ ticks, blob: pnfDive({ ticks, maxDepth10: d10, duration: 2400 + n * 60, samples: [[0, 50, 28], [0, d10 / 2, 28], [0, d10, 27], [0, 30, 27]] }) });
  const sim = peregrine({ dives: [mk(T(2, 9), 285, 1), mk(T(2, 14), 190, 2), mk(T(3, 9), 240, 3)] });
  await page.exposeFunction("__pgWrite", async (arr) => { await sim.io.write(Uint8Array.from(arr)); return sim.drain().map((a) => Array.from(a)); });
  await page.addInitScript(() => {
    window.__pgMode = "ok";
    const dev = { name: "Peregrine", addEventListener() {}, gatt: { connect: async () => server, disconnect() { window.__pgDisconnected = true; } } };
    let onChange = null;
    const ch = { properties: { notify: true, writeWithoutResponse: true }, addEventListener(t, f) { if (t === "characteristicvaluechanged") onChange = f; }, async startNotifications() {},
      async writeValueWithoutResponse(v) { if (v.byteLength > 20) throw new Error("write longer than 20 bytes"); const notes = await window.__pgWrite(Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
        setTimeout(() => notes.forEach((n) => onChange({ target: { value: new DataView(Uint8Array.from(n).buffer) } })), 0); } };
    const server = { getPrimaryService: async (u) => { if (window.__pgMode === "wrong") throw new Error("no service"); if (u !== "fe25c237-0ece-443c-b0aa-e02033e7029d") throw new Error("bad uuid"); return { getCharacteristics: async () => [{ properties: { read: true }, uuid: "x" }, ch] }; } };
    Object.defineProperty(navigator, "bluetooth", { configurable: true, value: { requestDevice: async (o) => {
      if (window.__pgMode === "cancel") throw Object.assign(new Error("User cancelled"), { name: "NotFoundError" });
      if (!o.optionalServices || !o.optionalServices.includes("fe25c237-0ece-443c-b0aa-e02033e7029d")) throw new Error("service not requested"); window.__pgAsked = o; return dev; } } });
  });
  await page.goto(base);
  try {
    await page.click("#navLog"); await page.locator("#devTabs button", { hasText: "Peregrine" }).click(); assert.ok(!(await page.locator("#pgBtn").isVisible()), "Bluetooth is tucked away (experimental)"); await page.locator("#importCard details summary").click(); await page.waitForSelector("#pgBtn", { state: "visible" });
    assert.match(await page.locator("#pgMsg").innerText(), /Bluetooth menu/);
    // a device that is not a Shearwater, and a cancelled chooser: clear messages, nothing saved
    await page.evaluate(() => { window.__pgMode = "wrong"; }); await page.click("#pgBtn");
    await page.waitForFunction(() => /not a Shearwater dive computer/.test(document.getElementById("pgMsg").textContent), null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__pgDisconnected), true, "disconnected again after the wrong device");
    await page.evaluate(() => { window.__pgMode = "cancel"; }); await page.click("#pgBtn");
    await page.waitForFunction(() => /No dive computer was chosen/.test(document.getElementById("pgMsg").textContent), null, { timeout: 5000 });
    assert.equal(await page.locator("#pgMsg").evaluate((e) => getComputedStyle(e).color !== "rgb(201, 42, 42)"), true, "cancelling is not shown as an error");
    // the real thing
    await page.evaluate(() => { window.__pgMode = "ok"; }); await page.click("#pgBtn");
    await page.waitForFunction(() => /Peregrine: 3 on the dive computer, 3 new/.test(document.getElementById("pgMsg").textContent), null, { timeout: 20000 });
    assert.match(await page.locator("#pgMsg").innerText(), /3 uploaded/);
    assert.equal(uploaded.length, 3); assert.deepEqual(uploaded.map((d) => d.startedAt).sort(), ["2026-05-02T09:30:00", "2026-05-02T14:30:00", "2026-05-03T09:30:00"]);
    const u = uploaded.find((d) => d.startedAt === "2026-05-02T09:30:00"); assert.equal(u.device, "peregrine"); assert.equal(u.maxDepthM, 28.5); assert.equal(u.durationSec, 2460); assert.equal(u.o2Percent, 32); assert.equal(u.headerHex, "");
    const x = JSON.parse(u.extra); assert.equal(x.s.length, 4); assert.equal(x.iv, 10); assert.deepEqual(x.s[2], [30, 28.5, 27]);
    assert.equal(await page.evaluate(() => window.__pgDisconnected), true); assert.equal(await page.locator("#pgBtn").isDisabled(), false);
    assert.equal(sim.log.filter((l) => /^35/.test(l)).length, 4, "1 manifest + 3 dives were requested"); assert.equal(sim.log.at(-1), "shutdown");
    assert.match(await page.locator("#devTabs button.active").innerText(), /Peregrine.*3/); assert.equal(await page.locator("details.dive").count(), 3);
    await page.waitForSelector("#locPrompt input", { state: "visible" }); assert.match(await page.locator("#locPrompt").innerText(), /3 new Peregrine dives/);
    await page.locator("details.dive").first().locator("summary").click(); await page.waitForSelector("details.dive[open] svg.chart");
    // second run: nothing new, no dive is downloaded again
    sim.log.length = 0; await page.click("#pgBtn");
    await page.waitForFunction(() => /Peregrine: 3 on the dive computer, 0 new/.test(document.getElementById("pgMsg").textContent), null, { timeout: 20000 });
    assert.equal(sim.log.filter((l) => /^35/.test(l)).length, 1, "only the manifest is read"); assert.equal(uploaded.length, 3);
    assert.deepEqual(errs, [], "page errors");
    console.log("PASS peregrine bluetooth");
  } catch (e) { failed++; console.log("FAIL peregrine bluetooth\n ", e.message.split("\n").slice(0, 8).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-pg.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: import the Peregrine's dives from a Shearwater Cloud database (.db) or its ZIP ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  const uploaded = [], errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", name: "Me", version: "0.0.0" } }));
  await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Me", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } }));
  await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } }));
  await page.route("**/api/dives/location", (r) => r.fulfill({ json: { updated: 1 } }));
  await page.route("**/api/dives", (r) => { if (r.request().method() === "GET") return r.fulfill({ json: { dives: [] } });
    const b = JSON.parse(r.request().postData()); uploaded.push(...b.dives); return r.fulfill({ json: { stored: b.dives.length } }); });
  await page.goto(base);
  try {
    await page.click("#navLog"); await page.locator("#devTabs button", { hasText: "Peregrine" }).click(); await page.waitForSelector("#impFile", { state: "attached" });
    await page.waitForSelector("#dropZone", { state: "visible" }); assert.ok(await page.locator("#dropZone").isVisible(), "a visible drop box"); assert.match(await page.locator("#dropZone").innerText(), /Drop your Shearwater Cloud file here/);
    assert.equal(await page.locator("#impFile").getAttribute("accept"), null, "no file-type filter: macOS greys out files the filter does not know (.db)");
    await page.locator("#importCard").screenshot({ path: process.env.SHOT_IMPORT || "/tmp/shot-import.png" });
    assert.match(await page.locator("#importCard").innerText(), /Export the database|export the database/i); assert.match(await page.locator("#importCard").innerText(), /Shearwater Cloud/);
    const dbBytes = makeDb({ dives: [cloudDive(0), cloudDive(1), cloudDive(2, { deleted: true }), cloudDive(3, { format: "sw-clouddb" }), cloudDive(4, { blob: Buffer.from("this is not a dive, only text that is long enough") }), cloudDive(5)] });
    await page.setInputFiles("#impFile", { name: "dive_data.db", mimeType: "application/octet-stream", buffer: Buffer.from(dbBytes) });
    await page.waitForFunction(() => /3 new dives imported/.test(document.getElementById("impMsg").textContent), null, { timeout: 20000 });
    const msg = await page.locator("#impMsg").innerText(); assert.match(msg, /2 skipped/); assert.match(msg, /3 uploaded/); assert.match(msg, /could not be read|implausible|unexpected/i, "the broken dive is reported: " + msg);
    assert.equal(uploaded.length, 3); assert.ok(uploaded.every((d) => d.device === "peregrine" && d.headerHex === "" && JSON.parse(d.extra).s.length > 50));
    assert.deepEqual(await page.locator("details.dive .dive-num").allInnerTexts(), ["105", "101", "100"], "logbook numbers from the Shearwater Cloud database, newest first");
    await page.waitForSelector("#locPrompt input", { state: "visible" });
    await page.locator("details.dive").last().locator("summary").click(); const svg = page.locator("details.dive[open] svg.chart"); await svg.waitFor();
    assert.ok((await svg.locator("line").count()) >= 6); assert.match(await page.locator("details.dive[open]").innerText(), /28\.5 m[\s\S]*20 min[\s\S]*32%/);
    // the same database again adds nothing; a ZIP (the account export) with one more dive adds just that one
    await page.setInputFiles("#impFile", { name: "again.db", mimeType: "application/octet-stream", buffer: Buffer.from(dbBytes) });
    await page.waitForFunction(() => /0 new dives imported, 3 already there/.test(document.getElementById("impMsg").textContent), null, { timeout: 20000 });
    const zipBytes = makeZip([["SyncReport.txt", Buffer.from("ok"), 8], ["dive_data.db", Buffer.from(makeDb({ dives: [cloudDive(0), cloudDive(6)] })), 8]]);
    await page.setInputFiles("#impFile", { name: "account.zip", mimeType: "application/zip", buffer: Buffer.from(zipBytes) });
    await page.waitForFunction(() => /1 new dive imported, 1 already there/.test(document.getElementById("impMsg").textContent), null, { timeout: 20000 });
    assert.equal(uploaded.length, 4); assert.equal(await page.locator("details.dive").count(), 4);
    // drag and drop onto the card works like the chooser (the file need not be found in a folder dialog)
    await page.locator("#importCard").evaluate((card) => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(0)], "empty.db")); card.querySelector("#dropZone").dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true })); window.__dropClass = card.className; });
    assert.match(await page.evaluate(() => window.__dropClass), /dropping/, "the box highlights while a file is dragged over it");
    assert.equal(await page.locator("#dropZone").evaluate((e) => getComputedStyle(e).borderTopStyle), "solid", "visibly changes while hovering");
    const dropBytes = makeDb({ dives: [cloudDive(7)] });
    await page.locator("#dropZone").evaluate(async (zone, arr) => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(arr)], "dropped.db")); zone.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true })); }, Array.from(dropBytes));
    await page.waitForFunction(() => /1 new dive imported/.test(document.getElementById("impMsg").textContent), null, { timeout: 20000 });
    assert.equal(uploaded.length, 5); assert.ok(!(await page.locator("#importCard").getAttribute("class")).includes("dropping"), "highlight cleared after the drop");
    // not a Shearwater file: a plain message
    await page.setInputFiles("#impFile", { name: "notes.db", mimeType: "application/octet-stream", buffer: Buffer.from("PK\u0003\u0004 nope".padEnd(100, " ")) });
    await page.waitForFunction(() => /damaged|no database|neither/i.test(document.getElementById("impMsg").textContent), null, { timeout: 8000 });
    assert.equal(uploaded.length, 5); assert.deepEqual(errs, [], "page errors");
    console.log("PASS shearwater cloud database");
  } catch (e) { failed++; console.log("FAIL shearwater cloud database\n ", e.message.split("\n").slice(0, 8).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-cloud.png", fullPage: true }); }
  await ctx.close();
}
// ---- optional: a real Shearwater Cloud export (REAL_DB=/path/to/file.db node test/e2e.mjs); skipped when not set ----
if (process.env.REAL_DB) {
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage(); const uploaded = [], errs = []; page.on("pageerror", (e) => errs.push(e.message));
  for (const [u, j] of [["me", { email: "you@example.com", name: "Me", version: "0.0.0" }], ["regulator", { regulator: null }], ["profile", { avatar: null, fullName: "Me", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } }], ["certs", { certs: [] }]]) await page.route("**/api/" + u, (r) => r.fulfill({ json: j }));
  await page.route("**/api/dives/location", (r) => r.fulfill({ json: { updated: 1 } }));
  await page.route("**/api/dives", (r) => { if (r.request().method() === "GET") return r.fulfill({ json: { dives: [] } }); const b = JSON.parse(r.request().postData()); uploaded.push(...b.dives); return r.fulfill({ json: { stored: b.dives.length } }); });
  await page.goto(base);
  try {
    await page.click("#navLog"); await page.locator("#devTabs button", { hasText: "Peregrine" }).click(); await page.waitForSelector("#impFile", { state: "attached" });
    await page.setInputFiles("#impFile", process.env.REAL_DB);
    await page.waitForFunction(() => /dives? imported/.test(document.getElementById("impMsg").textContent), null, { timeout: 120000 });
    console.log("  real file:", await page.locator("#impMsg").innerText());
    const nums = await page.locator("details.dive .dive-num").allInnerTexts(); console.log("  newest numbers:", nums.slice(0, 5).join(","), "oldest:", nums.slice(-3).join(","), "total", nums.length);
    await page.locator("details.dive").first().locator("summary").click(); await page.locator("details.dive[open] svg.chart").waitFor(); await page.screenshot({ path: process.env.SHOT_REAL || "/tmp/shot-real.png", fullPage: true });
    assert.deepEqual(errs, [], "page errors"); console.log("PASS real shearwater export");
  } catch (e) { failed++; console.log("FAIL real shearwater export\n ", e.message.split("\n").slice(0, 8).join(" | ")); await page.screenshot({ path: "/tmp/fail-real.png", fullPage: true }); }
  await ctx.close();
}
await browser.close(); server.close(); process.exit(failed ? 1 : 0);
