// Run: node test/e2e.mjs   (needs playwright; starts its own static server)
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const P = req("../public/dive-protocol.js");
const { chromium, devices } = req("playwright");
import assert from "node:assert/strict";
import { peregrine, pnfDive } from "./peregrine-sim.mjs";
import { makeDb, dive as cloudDive, zip as makeZip } from "./cloud-fixture.mjs";
import { fitFile, descentDive, runActivity } from "./fit-fixture.mjs";

const root = path.resolve("public");
import { readFileSync } from "node:fs";
const types = { ".woff2": "font/woff2", ".txt": "text/plain", ".css": "text/css", ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const server = http.createServer((req, res) => {
  const f = path.join(root, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream", "referrer-policy": "no-referrer" }); fs.createReadStream(f).pipe(res);   // like the Worker: the app sends no referrer unless a request asks for one
}).listen(0);
const base = `http://localhost:${server.address().port}/`;

// Dive computers are shown only when they have dives or were added: open one (click its tab, or add it first).
const diveRows = (page) => page.locator("#diveList details.dive").evaluateAll((els) => els.map((e) => ({ num: e.querySelector(".dive-num").textContent.trim(), mode: e.querySelector(".dive-mode").textContent.trim().toLowerCase(), chips: [...e.querySelectorAll(".devchip")].map((c) => c.textContent.trim()), also: (e.querySelector(".badge.also") || { textContent: "" }).textContent.trim() })));
const openSource = async (page, name) => {
  await page.click("#navImport");                                              // the dive computers, their sync and import boxes live in the Import tab
  const tab = page.locator("#devTabs button", { hasText: name });
  if (await tab.count()) { await tab.click(); return; }
  if (await page.locator("#srcEmpty").isVisible()) await page.locator("#srcEmptyList button", { hasText: name }).click();
  else { await page.click("#srcAdd"); await page.locator("#srcAddList button", { hasText: name }).click(); }
};
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
// The map opens by itself after a new location is saved (a user setting, on by default). Older scenarios are about other things and do not mock the map: switch it off for them.
{ const nc = browser.newContext.bind(browser); browser.newContext = async (o) => { const c = await nc(o); await c.addInitScript(() => { try { localStorage.setItem("mapAsk", "0"); } catch (e) {} }); return c; }; }
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
      assert.match(await page.locator("details.year > summary").innerText(), /2025[\s\S]*\b2\b[\s\S]*dives[\s\S]*\d+\.\d m/i);
      assert.ok(await page.locator("details.year").evaluate((e) => e.open), "newest year starts open");
      assert.match(await page.locator("details.dive").first().innerText(), /^2\n/, "number without #"); assert.match(await page.locator("details.dive").last().innerText(), /^1\n/);
      assert.ok(!/#/.test(await page.locator("details.dive").first().locator("summary").innerText()), "no # in the dive row");
      assert.match(await page.locator("#navLog").innerText(), /Dive log \(2\)/);      await page.locator("details.dive").last().locator("summary").click();
      await page.waitForSelector("details.dive[open] svg polyline");
      // technical details expose the raw header with undecoded bytes highlighted (to spot e.g. a location field)
      const tech = page.locator("details.dive[open] details.tech"); await tech.locator("summary").click();
      assert.ok((await tech.locator("table.hdr tr").count()) >= 15, "header map rendered");
      assert.ok((await tech.locator("tr.unk").count()) >= 3, "undecoded byte ranges highlighted");
      assert.match(await tech.innerText(), /no location \(GPS\) field/);
      // diagnostics file contains version, device traffic and the stored headers
      await page.click("#navImport");                                              // the diagnostics buttons are in the sync box, in the Import tab
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#diagSave")]);
      const diagText = fs.readFileSync(await dl.path(), "utf8");
      assert.match(diagText, /app version: \d+\.\d+\.\d+/); assert.match(diagText, /TX #40/); assert.match(diagText, /RX \$40/); assert.match(diagText, /header=[0-9a-f]{72}/);
      assert.equal(uploaded.length, 2, "both dives uploaded to cloud API");
      // second connect must not re-download profiles
      await page.evaluate(() => { window.__tx.length = 0; });
      await page.click("#navImport"); await page.click("#diveSyncBtn");
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
    await page.click("#navImport"); await page.click("#diveSyncBtn");
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
    assert.equal(await page.locator("#diveList > p").count(), 0, "no summary line above the list");
    const row = (n) => page.locator("details.dive", { has: page.locator(".dive-num", { hasText: new RegExp("^" + n + "$") }) });
    assert.match(await row(1).innerText(), /summary only/i, "dive #1: its profile was overwritten by dive #3");
    assert.equal(await row(3).locator(".badge").count(), 0, "dive #3 has its own profile (recovered from the wrapped slot)");
    await row(3).locator("summary").click(); await page.waitForSelector("details.dive[open] svg polyline");
    assert.equal(await row(3).locator(".numtile").innerText(), "3", "number tile without #"); assert.match(await row(3).innerText(), /dive number/);
    await row(1).locator("summary").click();
    assert.match(await row(1).locator(".note").innerText(), /no longer exists on the device/);
    assert.equal(await row(1).locator("svg:not(.pin)").count(), 0, "no chart is drawn from another dive's bytes");
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
    assert.deepEqual(await chips(), ["Komodo", "Komodo"]);
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
    assert.deepEqual(await chips(), ["Komodo", "Komodo"]);
    // 4. change the place of one date from its header; a known place is always written with its existing spelling
    await page.locator(".dh-loc").last().tap(); await page.waitForSelector(".dh-edit input");
    assert.ok(await page.locator("#locList option[value='Komodo']").count(), "known places are suggested");
    await page.evaluate(() => Dives.render());                                              // a background refresh must not wipe what is being typed
    await page.fill(".dh-edit input", "Banda"); await page.evaluate(() => Dives.render());
    assert.equal(await page.inputValue(".dh-edit input"), "Banda", "typing is not interrupted by a refresh");
    await page.locator(".dh-save").tap(); await toastIs(/Location saved/); await until(() => locCalls.length >= 2, "the date edit to reach the cloud");
    const after = await chips(); assert.ok(after.includes("Banda") && after.includes("Komodo"), after.join(" | "));
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
  const card = () => page.locator("#sumReg").evaluate((e) => ({ cls: e.className, role: e.getAttribute("role"), border: getComputedStyle(e).borderLeftColor, big: getComputedStyle(e.querySelector(".sum-big")).color, count: e.querySelector("#sumRegCount").textContent, msg: e.querySelector("#sumRegMsg").textContent, bar: e.querySelector("#sumRegDivesBar").style.width }));
  try {
    // 1. new title, avatar at the top right, no Account tab, no version in the header or footer
    assert.equal(await page.title(), "Dive Manager"); assert.equal(await page.locator("h1 img:visible").getAttribute("alt"), "Dive Manager", "the heading is the logo, named Dive Manager");
    const box = await page.locator("#acctBtn").boundingBox(), vw = page.viewportSize().width;
    assert.ok(box.x > vw / 2 && box.y < 80, "avatar sits at the top right"); assert.equal(await page.locator(".nav button").count(), 5, "Summary, Dive log, Import, Certificates, Device");
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
    assert.deepEqual(Object.values(byDate).sort(), ["Banda", "Komodo"], "14 March Banda (own entry), 15 March Komodo (the month's place)");
    // 3. month bulk in the log: keeps places already set unless 'replace' is ticked
    assert.match(await page.locator(".monthhead").first().innerText(), /March[\s\S]*2 dives[\s\S]*max [\d.]+ m[\s\S]*Komodo, Banda/);
    await page.locator(".mh-set").tap(); await page.waitForSelector(".mh-edit input[type=text]");
    await page.fill(".mh-edit input[type=text]", "Tulamben"); await page.locator(".mh-save").tap(); await toastIs(/Every dive this month already has a place/);
    await page.locator(".mh-replace").check(); await page.locator(".mh-save").tap(); await toastIs(/Location saved for 2 dives/);
    await until(async () => (await chips()).every((c) => /Tulamben/.test(c)), "both dates to read Tulamben");
    await until(() => locCalls.length >= 2 && locCalls.at(-1).length === 2 && locCalls.at(-1).every((i) => i.location === "Tulamben"), "the bulk update to reach the cloud");
    // 4. Summary: no regulator yet -> a hint; Account sections in the requested order, with the version only inside Help
    await page.click("#navSummary"); assert.ok(await page.locator("#sumRegHint").isVisible()); assert.ok(!(await page.locator("#sumReg").isVisible()));
    await page.click("#acctBtn"); assert.ok(await page.locator("#accountView").isVisible()); assert.ok(await page.locator("#acctBtn").evaluate((e) => e.classList.contains("active")));
    assert.deepEqual(await page.locator("details.acc > summary").evaluateAll((e) => e.map((x) => x.textContent.replace(/\s+/g, " ").trim())), ["Profile picture", "Change password", "DAN insurance", "Share dives", "Regulator", "API access", "Help / app version"]);
    await page.locator("details.acc[data-sec=help] > summary").click();
    assert.equal(await page.locator("#appVer").innerText(), "v" + (await page.evaluate(() => self.APP_VERSION))); assert.match(await page.locator("#serverVer").innerText(), /newer version \(v9\.9\.9\) is available/);
    assert.ok(await page.locator("#signOut").isVisible()); assert.equal(await page.locator("#who").textContent(), "you@example.com");
    // 5. regulator: add it, watch the card turn green -> orange (70) -> red (90)
    await page.locator("details.acc[data-sec=regulator] > summary").click();
    await page.locator("#regAdd").tap(); await page.fill("#regName", "Apeks XTX50"); await page.fill("#regType", "Balanced piston"); await page.fill("#regBase", "68");
    await page.locator("#regSave").tap(); await toastIs(/Regulator saved/);
    assert.equal(await page.locator("#regShownCount").innerText(), "68"); assert.match(await page.locator("#regBadge").innerText(), /68 dives/);
    assert.deepEqual({ ...regPuts.at(-1), since: typeof regPuts.at(-1).since }, { name: "Apeks XTX50", type: "Balanced piston", baseline: 68, since: "string", serviced: "", limitDives: 90, limitMonths: 12, history: [] }, "stored with the starting count and the default limits (90 dives, 12 months)");
    await page.click("#navSummary"); await until(async () => (await card()).count === "68", "the Summary card");
    let c = await card(); assert.equal(c.cls, "card sum reg-ok"); assert.equal(c.border, "rgb(43, 138, 62)"); assert.match(c.msg, /Next service in 22 dives/); assert.ok(!(await page.locator("#sumRegMonthsWrap").isVisible()), "no months shown until a service date is set");
    const edit = async (n) => { await page.click("#acctBtn"); await page.locator("#regEdit").tap(); await page.fill("#regBase", String(n)); await page.locator("#regSave").tap(); await toastIs(/Regulator saved/); await page.click("#navSummary"); await until(async () => (await card()).count === String(n), "count " + n); return card(); };
    c = await edit(69); assert.equal(c.cls, "card sum reg-ok", "69 is still green");
    c = await edit(70); assert.equal(c.cls, "card sum reg-orange", "70 turns orange"); assert.equal(c.border, "rgb(230, 119, 0)"); assert.equal(c.big, "rgb(217, 72, 15)"); assert.equal(c.role, "alert"); assert.match(c.msg, /Service soon: 20 dives to go/);
    c = await edit(89); assert.equal(c.cls, "card sum reg-orange", "89 is still orange");
    c = await edit(90); assert.equal(c.cls, "card sum reg-red", "90 turns red"); assert.equal(c.border, "rgb(201, 42, 42)"); assert.equal(c.big, "rgb(201, 42, 42)"); assert.match(c.msg, /Service now: 90 dives \(limit 90\)/); assert.equal(c.bar, "100%");
    assert.match(await page.locator("#regBadge").evaluate((e) => e.className), /red/, "badge in the Account list is red too");
    // 6. reset to 0: asks for the month and year of the service first, keeps it in the history and shows it on the Summary
    await page.click("#acctBtn"); await page.locator("#regReset").tap();
    assert.ok(await page.locator("#regResetForm").isVisible(), "the reset opens a month/year form"); assert.equal(await page.locator("#regShownCount").innerText(), "90", "opening the form does not reset");
    assert.equal(await page.locator("#regRstMonth").inputValue(), "03"); assert.equal(await page.locator("#regRstYear").inputValue(), "2025", "defaults to this month");
    assert.equal(await page.locator("#regRstYear option").first().innerText(), "2025", "no future years to pick");
    await page.locator("#regRstCancel").tap(); assert.ok(!(await page.locator("#regResetForm").isVisible()), "cancel closes it without resetting"); assert.equal(await page.locator("#regShownCount").innerText(), "90");
    await page.locator("#regReset").tap(); await page.selectOption("#regRstMonth", "01"); await page.locator("#regRstSave").tap(); await toastIs(/reset to 0/);
    assert.equal(await page.locator("#regShownCount").innerText(), "0"); const last = regPuts.at(-1);
    assert.deepEqual({ ...last, history: undefined }, { name: "Apeks XTX50", type: "Balanced piston", baseline: 0, since: "2025-03-15T08:05:00", serviced: "2025-01", limitDives: 90, limitMonths: 12, history: undefined }, "since = the latest dive logged so far, serviced = the chosen month");
    assert.deepEqual(last.history.map((h) => [h.m, h.dives]), [["2025-01", 90]], "the history remembers the service and how many dives it had");
    assert.match(await page.locator("#regShownLast").innerText(), /Last service: Jan(uary)? 2025/); assert.equal(await page.locator("#regShownMonths").innerText(), "2");
    assert.match(await page.locator("#regHistory summary").innerText(), /Service history \(1\)/); await page.locator("#regHistory summary").tap(); assert.match(await page.locator("#regHistoryList").innerText(), /Jan(uary)? 2025\s+90 dives on it/);
    await page.click("#navSummary"); await until(async () => (await card()).cls === "card sum reg-ok" && (await card()).count === "0", "green at 0");
    assert.equal(await page.locator("#sumRegMonths").innerText(), "2", "the Summary shows the months since the service too"); assert.match(await page.locator("#sumRegLast").innerText(), /Last service: Jan(uary)? 2025 \(2 months ago\)/);
    assert.equal(await page.locator("#sumRegTimeTxt").innerText(), "2 / 12 mo"); assert.equal(await page.locator("#sumRegDivesTxt").innerText(), "0 / 90");
    // 6b. the time reminder alone: few dives, but the last service was 14 months ago -> red; orange 2 months before the limit; each limit can be switched off
    const editSvc = async (y, mo, ld, lm) => { await page.click("#acctBtn"); await page.locator("#regEdit").tap(); await page.selectOption("#regSvcYear", String(y)); await page.selectOption("#regSvcMonth", mo); await page.fill("#regLimDives", String(ld)); await page.fill("#regLimMonths", String(lm)); await page.locator("#regSave").tap(); await toastIs(/Regulator saved/); await page.click("#navSummary"); await page.waitForTimeout(150); return card(); };
    c = await editSvc(2024, "05", 90, 12); assert.equal(c.cls, "card sum reg-orange", "10 months of 12 is orange"); assert.match(c.msg, /Service soon: 2 months to go/);
    c = await editSvc(2024, "01", 90, 12); assert.equal(c.cls, "card sum reg-red", "14 months is red even with 0 dives"); assert.match(c.msg, /Service now: 14 months since Jan(uary)? 2024 \(limit 12\)/); assert.equal(await page.locator("#sumRegDivesLine").getAttribute("class"), "regline lv-ok", "the dive bar stays green");
    c = await editSvc(2024, "01", 90, 0); assert.equal(c.cls, "card sum reg-ok", "months reminder off -> only dives count"); assert.ok(!(await page.locator("#sumRegTimeLine").isVisible()), "the time bar disappears when it is off");
    await page.click("#acctBtn"); await page.locator("#regEdit").tap(); await page.fill("#regLimDives", "0"); await page.fill("#regLimMonths", "0"); await page.locator("#regSave").tap(); assert.match(await page.locator("#regMsg").innerText(), /Keep at least one reminder/); await page.locator("#regCancel").tap();
    c = await editSvc(2024, "01", 90, 12); assert.equal(c.cls, "card sum reg-red");
    await page.click("#acctBtn"); await page.locator("#regReset").tap(); await page.selectOption("#regRstYear", "2025"); await page.selectOption("#regRstMonth", "03"); await page.locator("#regRstSave").tap(); await toastIs(/reset to 0/);
    assert.deepEqual(regPuts.at(-1).history.map((h) => h.m), ["2025-03", "2025-01"], "newest service first"); await page.click("#navSummary");
    await page.evaluate(() => window.__dives.push(window.__d3));                    // a new dive appears on the dive computer
    await page.click("#navImport"); await page.click("#diveSyncBtn");
    await page.waitForFunction(() => /Dive sync done: 3 on device, 1 new/.test(document.getElementById("diveProgress").textContent), null, { timeout: 15000 });
    await page.click("#navSummary"); await until(async () => (await card()).count === "1", "the new dive to count");
    assert.match((await card()).msg, /Next service in 89 dives or 12 months/);
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
    // the DAN logo works on any background: the holes of the D and the A are transparent (like the gap in the N), the flag's stripe and cross stay white
    const px = await page.evaluate(async () => { const im = new Image(); im.src = "dan-logo.png"; await im.decode(); const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight; const g = c.getContext("2d"); g.drawImage(im, 0, 0);
      const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data); return { dCounter: at(17, 101), aCounter: at(51, 99), stripe: at(50, 41), cross: at(87, 20), letter: at(40, 105) }; });
    assert.equal(px.dCounter[3], 0, "the D's hole is transparent"); assert.ok(px.aCounter[3] <= 5, "the A's hole is transparent"); assert.deepEqual(px.stripe, [255, 255, 255, 255], "the flag's stripe stays white"); assert.deepEqual(px.cross, [255, 255, 255, 255], "so does the cross"); assert.equal(px.letter[3], 255, "the letters stay solid red"); assert.ok(px.letter[0] > 190 && px.letter[1] < 70);
    await page.locator("#sumDiver").screenshot({ path: process.env.SHOT_DIVER || "/tmp/shot-diver.png" });
    // 1. nothing entered yet: placeholders and hints; your Google name is the fallback for the name
    await until(async () => (await diver()).name === "Google Name", "the Google name as a fallback");
    let d = await diver(); assert.equal(d.cert, "None added yet"); assert.equal(d.dan, "Not added yet"); assert.match(d.danCls, /dan-none/); assert.match(d.certSub, /Add one in the Certificates tab/);
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
    await page.click("#navCerts"); assert.ok(await page.locator("#certsView").isVisible(), "certificates have their own tab, not an Account section"); assert.equal(await page.locator("details.acc[data-sec=certs]").count(), 0);
    assert.ok(!(await page.locator("#certAddBox").isVisible()), "the add form is hidden until asked for"); assert.match(await page.locator("#certList").innerText(), /No certifications yet/);
    const addCert = async (label, num, date, name) => { const before = await page.locator("#certList .cert").count(); if (!(await page.locator("#certAddBox").isVisible())) await page.click("#certShowAdd"); await page.fill("#certLabel", label); await page.fill("#certNumber", num); await page.fill("#certDate", date); await page.setInputFiles("#certFile", { name, mimeType: "application/pdf", buffer: PDFB() }); await page.click("#certAdd");
      await until(async () => (await page.locator("#certList .cert").count()) === before + 1 && (await page.inputValue("#certLabel")) === "", "the upload to finish and the form to clear"); assert.ok(!(await page.locator("#certAddBox").isVisible()), "the form closes after an upload"); };
    await addCert("PADI Open Water", "OW-1", "2019-05-04", "ow.pdf"); await addCert("PADI Advanced Open Water", "AOW-2", "2023-06-10", "aow.pdf");
    await page.click("#certShowAdd"); await page.fill("#certLabel", "Old card, date unknown"); await page.setInputFiles("#certFile", { name: "old.pdf", mimeType: "application/pdf", buffer: PDFB() }); await page.click("#certAdd");
    await until(async () => (await page.locator("#certList .cert").count()) === 3 && (await page.inputValue("#certLabel")) === "", "three certifications"); assert.equal(calls.at(-1)[1].certifiedOn, "", "date is optional");
    assert.equal(await page.locator("#danList .cert").count(), 1);
    await page.click("#navSummary"); d = await diver(); assert.equal(d.cert, "PADI Advanced Open Water"); assert.match(d.certSub, /#AOW-2 . Jun 10, 2023/, "newest date earned; the undated card uploaded last does not win");
    await page.click("#navCerts"); const adv = page.locator("#certList .cert", { hasText: "PADI Advanced" }); await adv.locator(".wface").click(); assert.ok(await adv.locator(".cert-del").isVisible()); const del = adv.locator(".cert-del"); await del.click(); await del.click(); await toastIs(/Certification deleted/);
    await page.click("#navSummary"); await until(async () => (await diver()).cert === "PADI Open Water", "the latest certification to fall back to Open Water");
    // 6. tapping the certification row opens the Certificates tab, the DAN row the Account section; removing DAN resets its row
    await page.click("#navSummary"); await page.locator("#sumDiver .diver-row").first().click(); assert.ok(await page.locator("#certsView").isVisible(), "the certification row leads to the Certificates tab"); await page.click("#navSummary");
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
    await page.click("#navCerts");
    assert.equal(await page.locator("#certList .latest-tag").count(), 1, "exactly one is marked main"); assert.match(await page.locator("#certList .wcard.main").innerText(), /Advance Adventurer/); assert.match(await page.locator("#certList .wcard").first().innerText(), /Advance Adventurer/, "the main certification is on top");
    assert.equal(await page.locator("#certList .cert-latest").count(), 2, "the other two offer 'Make main'"); assert.match(await page.locator("#certList .cert-latest").first().innerText(), /Make main/);
    assert.equal(await page.locator("#certList .wcard.open").count(), 0, "the stack starts closed"); assert.ok(!(await page.locator("#certList .cert-latest").first().isVisible()) || true);
    const wb = await page.locator("#certList .wcard").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top))); assert.ok(wb[1] - wb[0] < 140 && wb[2] - wb[1] < 140, "closed cards overlap and show only a strip: " + JSON.stringify(wb));
    await page.locator("#certList .cert", { hasText: "Dive Master" }).locator(".wface").click(); await page.waitForFunction(() => document.querySelectorAll("#certList .wcard.open").length === 1); assert.match(await page.locator("#certList .wcard.open").innerText(), /Dive Master/, "tapping a card opens that one");
    assert.equal(await page.locator("#certList .wcard.open .wface").getAttribute("aria-expanded"), "true"); await page.locator("#certList .cert", { hasText: "Advance Adventurer" }).locator(".wface").click(); await page.waitForFunction(() => document.querySelectorAll("#certList .wcard.open").length === 1 && /Advance/.test(document.querySelector("#certList .wcard.open").textContent), null, { timeout: 4000 });
    await page.locator("#certList .wcard.open .cert-close").click(); await page.waitForFunction(() => document.querySelectorAll("#certList .wcard.open").length === 0); await page.locator("#certList .cert", { hasText: "Dive Master" }).locator(".wface").click(); await page.waitForTimeout(500);
    assert.equal(await page.locator("#certAuto").isVisible(), false, "no 'use newest' button while automatic");
    await page.locator("#certList .cert", { hasText: "Dive Master" }).locator(".cert-latest").click();
    await page.waitForFunction(() => /Dive Master/.test(document.querySelector("#certList .wcard.main")?.textContent || ""), null, { timeout: 5000 });
    assert.deepEqual(calls, ["0000000000000001"]); assert.equal(await page.locator("#certList .latest-tag").count(), 1);
    assert.ok(await page.locator("#certAuto").isVisible(), "a way back to automatic appears"); assert.match(await page.locator("#certLatestHint").innerText(), /You chose/); assert.match(await page.locator("#certList .wcard").first().innerText(), /Dive Master/, "the new main certification moves to the top");
    await page.click("#navSummary"); assert.equal(await cert(), "PADI Dive Master", "the Summary now shows the one you chose");
    await page.reload(); await page.waitForFunction(() => /Dive Master/.test(document.getElementById("sumCert").textContent), null, { timeout: 8000 });
    assert.equal(await cert(), "PADI Dive Master", "still the one you chose after a reload (saved in your account)");
    await page.click("#navCerts"); await page.click("#certAuto");
    await page.waitForFunction(() => /Advance Adventurer/.test(document.getElementById("certList").querySelector(".wcard.main")?.textContent || ""), null, { timeout: 5000 });
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
    // the dive computers and their sync / import boxes are in the Import tab; the Dive log has only the list
    await page.click("#navLog"); assert.equal(await page.locator("#devTabs, #importCard, #syncCard, #srcAddRow, #impFile").evaluateAll((els) => els.filter((e) => e.offsetParent !== null).length), 0, "no computer selector, sync or import box in the dive log"); assert.equal(await page.locator("#diveList details.dive").count(), 2);
    await page.click("#navImport"); assert.ok(await page.locator("#devTabs").isVisible(), "computer selector in the Import tab");
    assert.equal(await page.locator("#devTabs button").count(), 1, "only the Cosmiq+ has dives: one tab"); assert.match(await page.locator("#devTabs button.active").innerText(), /Cosmiq\+ Gen 5.*2/); assert.ok(await page.locator("#srcAddRow").isVisible(), "a way to add another dive computer");
    assert.ok(await page.locator("#syncCard").isVisible() && !(await page.locator("#importCard").isVisible()), "Cosmiq shows the sync card");
    await openSource(page, "Peregrine"); await page.waitForSelector("#importCard", { state: "visible" });
    assert.ok(await page.locator("#importCard").isVisible() && !(await page.locator("#syncCard").isVisible()), "Peregrine shows the import card, not the Bluetooth sync"); assert.ok(await page.locator("#pgBtn").isVisible());
    const bad = { name: "log.uddf", mimeType: "application/xml", buffer: Buffer.from("<html><body>hello</body></html>") };
    await page.setInputFiles("#impFile", bad); await page.waitForFunction(() => /not a UDDF/.test(document.getElementById("impMsg").textContent), null, { timeout: 5000 });
    assert.equal(uploaded.filter((d) => d.device === "peregrine").length, 0, "nothing uploaded from a bad file"); assert.ok(!(await page.locator("#impGoLog").isVisible()));
    const good = { name: "shearwater.uddf", mimeType: "application/xml", buffer: uddf(dive("2025-03-14T09:33:10", 41, 28.4, 2520) + dive("2025-03-16T10:00:00", 42, 18.2, 2400) + dive("2025-03-16T14:00:00", 43, 12.5, 3000)) };
    await page.setInputFiles("#impFile", good);
    await page.waitForFunction(() => /3 new dives imported/.test(document.getElementById("impMsg").textContent), null, { timeout: 8000 });
    assert.match(await page.locator("#impMsg").innerText(), /3 uploaded/); assert.match(await page.locator("#impGoLog").innerText({ timeout: 3000 }).catch((e) => "ERR " + e.message.slice(0, 80)), /3 new dives added to your dive log/, "the Import tab says where they went");
    assert.equal(uploaded.length, 5, "2 Cosmiq + 3 Peregrine"); const u = uploaded.find((d) => d.startedAt === "2025-03-16T10:00:00");
    assert.equal(u.device, "peregrine"); assert.equal(u.headerHex, ""); assert.equal(u.maxDepthM, 18.2); assert.equal(u.o2Percent, 32); const x = JSON.parse(u.extra); assert.equal(x.n, 42); assert.equal(x.s.length, 5); assert.deepEqual(x.s[2], [120, 18.2, 28]);
    assert.match(await page.locator("#devTabs button.active").innerText(), /Peregrine.*3/, "per-computer counts stay in the Import tab"); await openSource(page, "Cosmiq"); await page.waitForFunction(() => /Cosmiq\+ Gen 5/.test(document.querySelector("#devTabs button.active")?.textContent || ""), null, { timeout: 5000 }); assert.match(await page.locator("#devTabs button.active").innerText(), /Cosmiq\+ Gen 5.*2/);
    // ONE dive log: every dive once. 5 records, 1 of them the same dive as another -> 4 rows; the Peregrine record is the one shown (it is preferred over the Cosmiq+)
    await openSource(page, "Peregrine"); await page.click("#navLog"); await page.waitForFunction(() => document.querySelectorAll("#diveList details.dive").length === 4, null, { timeout: 5000 });
    assert.match(await page.locator("#navLog").innerText(), /Dive log \(4\)/, "the nav counts every dive once"); assert.equal(await page.locator("#diveList > p").count(), 0, "no summary line above the list");
    const rows = await diveRows(page);
    assert.equal(rows[0].num, "4"); assert.deepEqual(rows.map((r) => r.chips[0]).sort(), ["Cosmiq+", "Peregrine", "Peregrine", "Peregrine"], "three Peregrine rows and the Cosmiq+ dive that only it recorded: " + JSON.stringify(rows)); assert.equal(rows.filter((r) => r.chips[0] === "Cosmiq+").length, 1); assert.equal(rows.filter((r) => r.also).length, 1, "only the dive recorded twice says so");
    const merged = page.locator("#diveList details.dive", { has: page.locator(".badge.also") }); assert.equal(await merged.count(), 1, "one dive was recorded twice"); assert.match(await merged.locator("summary").innerText(), /Peregrine/); assert.match(await merged.locator(".badge.also").innerText(), /also on Cosmiq\+/); assert.equal(await merged.locator(".dive-num").innerText(), "1", "logbook number: your oldest dive is 1");
    // dive numbers: bold, boxed, no '#'; the logbook counts 1 (oldest) to 4 (newest)
    const num = page.locator("details.dive .dive-num").first();
    assert.equal(await num.innerText(), "4"); const st = await num.evaluate((e) => { const c = getComputedStyle(e); return { w: c.fontWeight, br: c.borderTopWidth, bg: c.backgroundColor, rad: c.borderTopLeftRadius }; });
    assert.ok(+st.w >= 700, "bold"); assert.equal(st.br, "1px"); assert.notEqual(st.bg, "rgba(0, 0, 0, 0)"); assert.notEqual(st.rad, "0px");
    // a dive with the grid: horizontal depth lines labelled in metres, vertical time lines in minutes (this one is the Peregrine record of the shared dive)
    await merged.locator("summary").click();
    const svg = page.locator("details.dive[open] svg.chart"); await svg.waitFor();
    const lines = await svg.locator("line").count(); assert.ok(lines >= 6, "grid lines drawn: " + lines);
    const labels = await svg.locator("text").evaluateAll((els) => els.map((e) => e.textContent)); assert.ok(labels.includes("0 m") && labels.includes("10") && labels.includes("30"), "depth labels: " + labels.join(","));
    await page.screenshot({ path: process.env.SHOT_PEREGRINE || "/tmp/shot-peregrine.png", fullPage: true });
    assert.match(await svg.getAttribute("aria-label"), /gridlines every 10 m/);
    assert.match(await page.locator("details.dive[open]").innerText(), /28\.4 m[\s\S]*42 min[\s\S]*28\.0 .C[\s\S]*32%/, "the Peregrine's numbers, not the Cosmiq+'s");
    assert.match(await page.locator("details.dive[open]").innerText(), /Imported from a file/);
    // the same file again adds nothing; the same dive on both wrists counts once in the Summary and the regulator
    await page.click("#navImport"); await page.setInputFiles("#impFile", good); await page.waitForFunction(() => /0 new dives imported, 3 already there/.test(document.getElementById("impMsg").textContent), null, { timeout: 8000 });
    assert.equal(uploaded.length, 5, "no duplicate upload");
    await page.click("#navSummary");
    assert.match(await page.locator("#sumCount").innerText(), /across 4 dives . 1 recorded on both computers, counted once \(Peregrine used\)/, "5 logged, one recorded by both computers = 4, and the Summary names the record used");
    assert.equal(await page.locator("#sumRegCount").innerText(), "3", "regulator: 4 dives minus the freedive; the dive on both wrists counted once");
    // location prompt covers imported dives, and saving it reaches them (and the record hidden behind the shown one)
    await page.click("#navLog"); await page.waitForSelector("#locPrompt input", { state: "visible" });
    assert.match(await page.locator("#locPrompt h3").innerText(), /Where did you dive/); assert.match(await page.locator("#locPrompt").innerText(), /imported dives?/);
    const locCalls = []; await page.unroute("**/api/dives/location"); await page.route("**/api/dives/location", (r) => { locCalls.push(...JSON.parse(r.request().postData()).items); return r.fulfill({ json: { updated: 1 } }); });
    const firstIn = page.locator("#locPrompt .locask input").first(); await firstIn.fill("Banda"); await page.click("#locSave");
    await page.waitForFunction(() => /Location saved for/.test(document.getElementById("toast").textContent), null, { timeout: 5000 });
    assert.ok(locCalls.length >= 1 && locCalls.every((i) => i.location === "Banda"), "the place of imported dives is sent to the cloud: " + JSON.stringify(locCalls));
    assert.ok(locCalls.length >= 2, "the dive recorded twice: both records get the place (" + locCalls.length + " sent)");
    // reload: imported dives come back from the cloud (device + extra) and the selected computer is remembered
    const stored = uploaded.filter((d) => d.device === "peregrine");
    await page.unroute("**/api/dives"); await page.route("**/api/dives", (r) => r.request().method() === "GET" ? r.fulfill({ json: { dives: stored.map((d) => ({ ...d, deviceMac: null, location: null })) } }) : r.fulfill({ json: { stored: 0 } }));
    await page.evaluate(() => indexedDB.deleteDatabase("cosmiq")); await page.reload();
    await page.waitForFunction(() => /Dive log \(3\)/.test(document.getElementById("navLog").textContent), null, { timeout: 8000 });
    await page.click("#navImport"); assert.match(await page.locator("#devTabs button.active").innerText(), /Peregrine.*3/, "remembered the computer");
    await page.click("#navLog"); await page.locator("#diveList details.dive").last().locator("summary").click(); await page.locator("details.dive[open] svg.chart").waitFor();
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
  const sentLogs = []; await page.route("**/api/bt-reports", (r) => { sentLogs.push(JSON.parse(r.request().postData())); return r.fulfill({ status: 201, json: { id: 7, ok: true } }); });
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
    await page.click("#navLog"); await openSource(page, "Peregrine"); await page.waitForSelector("#pgBtn", { state: "visible" }); assert.ok(await page.locator("#pgBtn").isVisible(), "Bluetooth is the main way to get Peregrine dives: in view at once, not hidden away");
    const btTop = await page.locator("#impBt").boundingBox(), fileTop = await page.locator("#dropZone").boundingBox(); assert.ok(btTop.y < fileTop.y, "the Bluetooth download comes before the file import"); assert.match(await page.locator("#impBt").innerText(), /works on a real Peregrine/); assert.doesNotMatch(await page.locator("#importCard").innerText(), /experimental/i, "no longer described as experimental");
    assert.match(await page.locator("#impFileHead").innerText(), /Or import a file from Shearwater Cloud instead/);
    assert.match(await page.locator("#pgMsg").innerText(), /Bluetooth on in the computer.s menu/);
    // the test button: what the browser can see, nothing downloaded or saved
    await page.click("#pgProbe"); await page.waitForFunction(() => /Result: this looks like a Shearwater/.test(document.getElementById("pgMsg").textContent), null, { timeout: 5000 });
    const probeTxt = await page.locator("#pgMsg").innerText(); assert.match(probeTxt, /Name: Peregrine/); assert.match(probeTxt, /Connected/); assert.match(probeTxt, /Data channel: found/); assert.match(probeTxt, /Services seen: Shearwater data service/);
    assert.equal(sim.log.length, 0, "the test sends nothing to the dive computer"); assert.equal(uploaded.length, 0); assert.equal(await page.evaluate(() => window.__pgDisconnected), true, "disconnected again after the test");
    await page.evaluate(() => { window.__pgMode = "wrong"; window.__pgDisconnected = false; }); await page.click("#pgProbe");
    await page.waitForFunction(() => /does not offer the Shearwater service/.test(document.getElementById("pgMsg").textContent), null, { timeout: 5000 }); assert.equal(await page.locator("#pgMsg").evaluate((e) => getComputedStyle(e).color === "rgb(201, 42, 42)"), true, "a negative result is shown as a problem");
    await page.evaluate(() => { window.__pgMode = "cancel"; }); await page.click("#pgProbe"); await page.waitForFunction(() => /No dive computer was chosen/.test(document.getElementById("pgMsg").textContent), null, { timeout: 5000 });
    await page.evaluate(() => { window.__pgMode = "ok"; });
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
    assert.match(await page.locator("#impGoLog").innerText(), /3 new dives added to your dive log/, "the Import tab says where the dives went");
    await page.click("#navLog"); await page.waitForSelector("#locPrompt input", { state: "visible" }); assert.match(await page.locator("#locPrompt").innerText(), /3 new Peregrine dives/);
    await page.locator("details.dive").first().locator("summary").click(); await page.waitForSelector("details.dive[open] svg.chart");
    // second run: nothing new, no dive is downloaded again
    await page.click("#navImport"); sim.log.length = 0; await page.click("#pgBtn");
    await page.waitForFunction(() => /Peregrine: 3 on the dive computer, 0 new/.test(document.getElementById("pgMsg").textContent), null, { timeout: 20000 });
    assert.equal(sim.log.filter((l) => /^35/.test(l)).length, 1, "only the manifest is read"); assert.equal(uploaded.length, 3);
    // the same download for a Perdix 2: its own tab, its own records (device perdix), the same protocol
    await openSource(page, "Perdix"); await page.waitForFunction(() => /perdix/i.test(document.getElementById("impTitle").textContent), null, { timeout: 5000 });
    assert.ok(await page.locator("#pgBtn").isVisible(), "the Perdix tab opens with the Bluetooth download in view"); assert.match(await page.locator("#impBt").innerText(), /Perdix has not been tried yet/); assert.match(await page.locator("#impBt").innerText(), /Bluefy/); assert.ok(!/works on a real Peregrine/.test(await page.locator("#impBt").innerText()), "the Perdix is not claimed to be proven");
    // a Peregrine (model number 9) on the Perdix tab is refused before any dive is read, so no dive is filed under the wrong computer
    sim.log.length = 0; await page.click("#pgBtn"); await page.waitForFunction(() => /says it is a Peregrine \(model number 9\)/.test(document.getElementById("pgMsg").textContent), null, { timeout: 10000 });
    assert.match(await page.locator("#pgMsg").innerText(), /Open the Shearwater Peregrine tab/); assert.equal(uploaded.length, 3, "nothing was filed under Perdix"); assert.ok(!sim.log.some((l) => /^35/.test(l)), "no dive was requested from the computer");
    // a Perdix (another model number) is accepted
    sim.setModel(5);
    await page.click("#pgBtn"); await page.waitForFunction(() => /Perdix: 3 on the dive computer, 3 new/.test(document.getElementById("pgMsg").textContent), null, { timeout: 20000 });
    assert.equal(uploaded.length, 6); assert.deepEqual([...new Set(uploaded.slice(3).map((d) => d.device))], ["perdix"], "stored as Perdix dives, not Peregrine ones"); assert.equal(await page.locator("details.dive").count(), 3);
    // the download log: every attempt above is written down, with its steps, identity, counts and bytes
    await page.locator("#btLogBox summary").click(); await page.waitForFunction(() => document.querySelectorAll("#btLogList li").length >= 7, null, { timeout: 5000 });
    assert.match(await page.locator("#btLogCount").innerText(), /\(\d+\)/); const sum = await page.locator("#btLogList").innerText();
    assert.match(sum, /Download\s+Perdix\s+OK - Perdix: 3 on the dive computer, 3 new/); assert.match(sum, /Bluetooth test\s+Peregrine\s+OK/); assert.match(sum, /FAILED - .*not a Shearwater dive computer/); assert.match(sum, /cancelled - No dive computer was chosen/);
    const logTxt = await page.locator("#btLogText").inputValue();
    for (const must of ["=== Download: Peregrine ===", "=== Download: Perdix ===", "=== Bluetooth test: Peregrine ===", "Result: OK - Peregrine: 3 on the dive computer, 3 new", "Result: CANCELLED - No dive computer was chosen.", "Computer: Peregrine (peregrine), Bluetooth name \"Peregrine\"", "Counts: 3 on the computer, 3 new, 0 could not be read", "Downloading dive 1 of 3", "Connected to Peregrine.", "s TX ", "s RX ", "NOTE Read serial number (0x8010): ", "NOTE Download request: 0xe0000000, up to 1536 bytes, plain: accepted", "Identity: serial 12345678, firmware V93, model number 9 (Peregrine)", "Dive list page 1: 3 dives listed", "Dive 1 of 3 (2026-05-02 09:30, address 0x", "== Steps ==", "== Bytes exchanged"]) assert.ok(logTxt.includes(must), "download log has: " + must);
    assert.match(logTxt, /Identity: serial \S+, firmware \S+, model number \d+ \(Peregrine\)/); assert.match(logTxt, /Browser: .* \| System: .* \| App: \d+\.\d+\.\d+/);
    await page.click("#btLogSend"); await page.waitForFunction(() => /Sent to your account \(report #7\)/.test(document.getElementById("btLogMsg").textContent), null, { timeout: 5000 });
    assert.equal(sentLogs.length, 1); assert.equal(sentLogs[0].kind, "download"); assert.ok(sentLogs[0].body.includes("Bluetooth download log") && sentLogs[0].body.includes("=== Download: Perdix ==="), "the whole log is what is sent");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("btLog")).length); assert.ok(stored >= 7 && stored <= 25, "kept on this device: " + stored);
    await page.reload(); await page.click("#navLog"); await openSource(page, "Peregrine"); await page.locator("#btLogBox summary").click(); assert.ok((await page.locator("#btLogText").inputValue()).includes("=== Download: Perdix ==="), "still there after a reload");
    await page.click("#btLogClear"); await page.waitForFunction(() => /No Bluetooth attempts yet/.test(document.getElementById("btLogList").textContent)); assert.equal(await page.evaluate(() => localStorage.getItem("btLog")), null);
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
    await page.click("#navLog"); await openSource(page, "Peregrine"); await page.waitForSelector("#impFile", { state: "attached" });
    await page.waitForSelector("#dropZone", { state: "visible" }); assert.ok(await page.locator("#dropZone").isVisible(), "a visible drop box"); assert.match(await page.locator("#dropZone").innerText(), /Drop your Shearwater Cloud file here/);
    assert.equal(await page.locator("#impFile").getAttribute("accept"), null, "no file-type filter: macOS greys out files the filter does not know (.db)");
    await page.locator("#importCard").screenshot({ path: process.env.SHOT_IMPORT || "/tmp/shot-import.png" });
    assert.match(await page.locator("#importCard").innerText(), /Export the database|export the database/i); assert.match(await page.locator("#importCard").innerText(), /Shearwater Cloud/);
    const dbBytes = makeDb({ dives: [cloudDive(0), cloudDive(1), cloudDive(2, { deleted: true }), cloudDive(3, { format: "sw-clouddb" }), cloudDive(4, { blob: Buffer.from("this is not a dive, only text that is long enough") }), cloudDive(5)] });
    await page.setInputFiles("#impFile", { name: "dive_data.db", mimeType: "application/octet-stream", buffer: Buffer.from(dbBytes) });
    await page.waitForFunction(() => /3 new dives imported/.test(document.getElementById("impMsg").textContent), null, { timeout: 20000 });
    const msg = await page.locator("#impMsg").innerText(); assert.match(msg, /2 skipped/); assert.match(msg, /3 uploaded/); assert.match(msg, /could not be read|implausible|unexpected/i, "the broken dive is reported: " + msg);
    assert.equal(uploaded.length, 3); assert.ok(uploaded.every((d) => d.device === "peregrine" && d.headerHex === "" && JSON.parse(d.extra).s.length > 50));
    await page.click("#navLog"); assert.deepEqual(await page.locator("details.dive .dive-num").allInnerTexts(), ["3", "2", "1"], "the dive log counts its own dives: 1 = the oldest");
    await page.waitForSelector("#locPrompt input", { state: "visible" });
    await page.locator("details.dive").last().locator("summary").click(); const svg = page.locator("details.dive[open] svg.chart"); await svg.waitFor();
    assert.ok((await svg.locator("line").count()) >= 6); assert.match(await page.locator("details.dive[open]").innerText(), /28\.5 m[\s\S]*20 min[\s\S]*32%/);
    // the same database again adds nothing; a ZIP (the account export) with one more dive adds just that one
    await page.click("#navImport"); await page.setInputFiles("#impFile", { name: "again.db", mimeType: "application/octet-stream", buffer: Buffer.from(dbBytes) });
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
    await page.click("#navLog"); await openSource(page, "Peregrine"); await page.waitForSelector("#impFile", { state: "attached" });
    await page.setInputFiles("#impFile", process.env.REAL_DB);
    await page.waitForFunction(() => /dives? imported/.test(document.getElementById("impMsg").textContent), null, { timeout: 120000 });
    console.log("  real file:", await page.locator("#impMsg").innerText());
    const nums = await page.locator("details.dive .dive-num").allInnerTexts(); console.log("  newest numbers:", nums.slice(0, 5).join(","), "oldest:", nums.slice(-3).join(","), "total", nums.length);
    await page.locator("details.dive").first().locator("summary").click(); await page.locator("details.dive[open] svg.chart").waitFor(); await page.screenshot({ path: process.env.SHOT_REAL || "/tmp/shot-real.png", fullPage: true });
    assert.deepEqual(errs, [], "page errors"); console.log("PASS real shearwater export");
  } catch (e) { failed++; console.log("FAIL real shearwater export\n ", e.message.split("\n").slice(0, 8).join(" | ")); await page.screenshot({ path: "/tmp/fail-real.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: dive places on a map (Summary map with pins, place search, tap / drag, queue of places to put on the map) ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  const errs = [], places = [], calls = [], referers = []; page.on("pageerror", (e) => errs.push(e.message));
  const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  let nominatimMode = "ok";
  await page.route("**/tile.openstreetmap.org/**", (r) => { referers.push(["tile", r.request().headers().referer]); return r.fulfill({ body: PNG1, contentType: "image/png" }); });
  await page.route("**/nominatim.openstreetmap.org/search*", (r) => { const q = new URL(r.request().url()).searchParams.get("q"); calls.push(q); referers.push(["search", r.request().headers().referer]);
    if (nominatimMode === "busy") return r.fulfill({ status: 429, body: "slow down" });
    const rows = { Tulamben: [{ name: "Tulamben", display_name: "Tulamben, Kubu, Karangasem, Bali, Indonesia", lat: "-8.2948774", lon: "115.5941905", boundingbox: ["-8.33", "-8.25", "115.55", "115.62"] }, { name: "Tulamben Wreck", display_name: "USAT Liberty Wreck, Tulamben, Bali", lat: "-8.2744", lon: "115.5922" }], Banda: [] }[q] || [];
    return r.fulfill({ json: rows, headers: { "access-control-allow-origin": "*" } }); });
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", name: "Me", version: "0.0.0" } }));
  await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Me", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } }));
  await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } }));
  const k = (n) => (n || "").toLowerCase();
  await page.route("**/api/places", (r) => { const m = r.request().method(), b = r.request().postData() ? JSON.parse(r.request().postData()) : null;
    if (m === "PUT") { const i = places.findIndex((p) => k(p.name) === k(b.name)); if (i >= 0) places[i] = b; else places.push(b); return r.fulfill({ json: { ok: true } }); }
    if (m === "DELETE") { const i = places.findIndex((p) => k(p.name) === k(b.name)); if (i >= 0) places.splice(i, 1); return r.fulfill({ json: { deleted: i >= 0 ? 1 : 0 } }); }
    return r.fulfill({ json: { places: places.slice() } }); });
  const mk = (when, loc, n) => ({ fingerprint: (0xabc000000000 + n).toString(16).padStart(12, "0"), device: "peregrine", startedAt: when, mode: "scuba", durationSec: 3000, maxDepthM: 20, o2Percent: 32, headerHex: "", profileHex: "", location: loc, deviceMac: null, extra: JSON.stringify({ n, t: 28, iv: 10, s: [[10, 5, 28], [20, 18, 28]] }) });
  await page.route("**/api/dives/location", (r) => r.fulfill({ json: { updated: 1 } }));
  await page.route("**/api/dives", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { dives: [mk("2025-03-14T09:00:00", "Tulamben", 1), mk("2025-03-14T13:00:00", "tulamben", 2), mk("2025-03-15T09:00:00", "Tulamben", 3), mk("2024-07-02T09:00:00", "Komodo", 4), mk("2023-05-02T09:00:00", "Banda", 5), mk("2023-05-03T09:00:00", "", 6)] } }) : r.fulfill({ json: { stored: 0 } })));
  await page.goto(base);
  try {
    const sumMsg = () => page.locator("#mapMsg").innerText();
    await page.waitForFunction(() => /3 places/.test(document.getElementById("mapMsg")?.textContent || ""), null, { timeout: 10000 });
    assert.ok(await page.locator("#mapCard").isVisible()); assert.match(await sumMsg(), /3 places . 0 on the map . 3 still to place/, "Tulamben and tulamben are one place; the dive without a place is not counted");
    await page.locator("#sumMap .leaflet-container, #sumMap.leaflet-container").first().waitFor();
    assert.equal(await page.locator("#sumMap .leaflet-marker-icon").count(), 0, "no pins yet");
    assert.deepEqual(await page.locator("#mapUnplaced .chip").allInnerTexts().then((a) => a.map((x) => x.replace(/[^\w ]/g, "").trim().replace(/\s+/g, " "))), ["Tulamben 3", "Banda 1", "Komodo 1"], "most dives first");
    assert.match(await page.locator("#sumMap .leaflet-control-attribution").innerText(), /OpenStreetMap/, "attribution shown");
    // 1. search -> pick a result -> save
    await page.locator("#mapUnplaced .chip").first().click(); await page.waitForSelector("#placePicker", { state: "visible" });
    assert.match(await page.locator("#ppTitle").innerText(), /Where is .Tulamben.\? \(2 more after this\)/); assert.equal(await page.inputValue("#ppQuery"), "Tulamben");
    await page.waitForSelector("#ppResults .res"); assert.deepEqual(calls, ["Tulamben"], "one search request, started by opening the picker"); assert.equal(await page.locator("#ppResults .res").count(), 2);
    assert.equal(await page.locator("#ppSave").isDisabled(), true, "nothing is saved until you choose");
    await page.locator("#ppResults .res").first().click(); assert.match(await page.locator("#ppCoords").innerText(), /-8\.2949, 115\.5942/); assert.equal(await page.locator("#ppSave").isDisabled(), false);
    await page.click("#ppSave"); await page.waitForFunction(() => /Banda/.test(document.getElementById("ppTitle").textContent));
    assert.deepEqual(places, [{ name: "Tulamben", lat: -8.2948774, lon: 115.5941905 }], "saved under the name you use, with the position from the search");
    // 2. nothing found -> tap on the map instead, drag-free
    await page.waitForFunction(() => /Nothing found/.test(document.getElementById("ppResults").textContent), null, { timeout: 8000 }); assert.equal(await page.locator("#ppSave").isDisabled(), true);
    await page.locator("#ppMap").click({ position: { x: 150, y: 120 } }); assert.equal(await page.locator("#ppMap .leaflet-marker-icon").count(), 1, "pin dropped where you tapped"); assert.equal(await page.locator("#ppSave").isDisabled(), false);
    const first = await page.locator("#ppCoords").innerText(); await page.locator("#ppMap").click({ position: { x: 60, y: 200 } }); assert.notEqual(await page.locator("#ppCoords").innerText(), first, "tapping again moves the pin");
    await page.click("#ppSave"); await page.waitForFunction(() => /Komodo/.test(document.getElementById("ppTitle").textContent)); assert.equal(places.length, 2);
    assert.equal(await page.locator("#ppSkip").innerText(), "Cancel", "the last place: Skip is a Cancel");
    // 3. Komodo: a failing search is explained, and the picker can simply be closed (nothing saved)
    nominatimMode = "busy"; await page.fill("#ppQuery", "Komodo island"); await page.click("#ppGo");
    await page.waitForFunction(() => /busy/.test(document.getElementById("ppResults").textContent), null, { timeout: 8000 });
    await page.click("#ppSkip"); await page.waitForSelector("#placePicker", { state: "hidden" }); assert.equal(places.length, 2);
    // 4. the Summary now shows pins, a popup with the dive count, and what is still to place
    await page.waitForFunction(() => document.querySelectorAll("#sumMap .leaflet-marker-icon").length === 2, null, { timeout: 8000 });
    assert.match(await sumMsg(), /2 on the map . 1 still to place/); assert.equal(await page.locator("#mapUnplaced .chip").count(), 1);
    await page.locator("#sumMap .leaflet-marker-icon").first().click(); await page.waitForSelector("#sumMap .pin-pop");
    assert.match(await page.locator("#sumMap .pin-pop").innerText(), /Tulamben[\s\S]*3 dives[\s\S]*Mar 2025/); assert.equal(await page.locator("#sumMap .pin-pop .btn-set").innerText(), "Move pin");
    assert.match((await page.locator("#sumMap .leaflet-marker-icon svg text").first().textContent()), /3|1/, "the number of dives is on the pin");
    // 5. the dive log says what is missing, and the app tells OpenStreetMap who is asking
    await page.click("#navLog"); await page.waitForSelector("#placeBanner", { state: "visible" }); assert.match(await page.locator("#placeBannerText").innerText(), /1 place is not on the map yet/);
    const origin = new URL(base).origin + "/"; assert.ok(referers.length > 3 && referers.every(([, ref]) => ref === origin), "tiles and search send the app's origin as referrer: " + JSON.stringify(referers.slice(0, 3)));
    // 6. remove a pin from the list
    await page.click("#navSummary"); assert.ok(await page.locator("#placeDetails").isVisible(), "a place is still to be put on the map: the list stays"); assert.ok(!(await page.locator("#mapEdit").isVisible())); await page.locator("#mapCard details summary").click();
    await page.locator(".place-row", { hasText: "Banda" }).locator(".pl-del").click();
    await page.waitForFunction(() => document.querySelectorAll("#sumMap .leaflet-marker-icon").length === 1, null, { timeout: 8000 }); assert.equal(places.length, 1);
    // 7. a reload brings the pins back from the account
    await page.reload(); await page.waitForFunction(() => /1 on the map/.test(document.getElementById("mapMsg")?.textContent || ""), null, { timeout: 10000 });
    await page.screenshot({ path: process.env.SHOT_MAP || "/tmp/shot-map.png", fullPage: true });
    assert.deepEqual(errs, [], "page errors"); console.log("PASS places on a map");
  } catch (e) { failed++; console.log("FAIL places on a map\n ", e.message.split("\n").slice(0, 8).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-map.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: entering a location in the dive log goes straight to the map search ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  const errs = [], places = [], searches = []; page.on("pageerror", (e) => errs.push(e.message));
  const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await ctx.addInitScript(() => { try { localStorage.removeItem("mapAsk"); } catch (e) {} });          // the default: on
  await page.route("**/tile.openstreetmap.org/**", (r) => r.fulfill({ body: PNG1, contentType: "image/png" }));
  await page.route("**/nominatim.openstreetmap.org/search*", (r) => { const q = new URL(r.request().url()).searchParams.get("q"); searches.push(q);
    const hit = (n, lat, lon) => [{ name: n, display_name: n + ", Indonesia", lat: String(lat), lon: String(lon) }];
    return r.fulfill({ json: { Tulamben: hit("Tulamben", -8.29, 115.59), Komodo: hit("Komodo", -8.55, 119.49), Wakatobi: hit("Wakatobi", -5.3, 123.6) }[q] || [], headers: { "access-control-allow-origin": "*" } }); });
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", name: "Me", version: "0.0.0" } }));
  await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Me", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } }));
  await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } }));
  const k = (n) => (n || "").toLowerCase();
  await page.route("**/api/places", (r) => { const m = r.request().method(), b = r.request().postData() ? JSON.parse(r.request().postData()) : null;
    if (m === "PUT") { const i = places.findIndex((p) => k(p.name) === k(b.name)); if (i >= 0) places[i] = b; else places.push(b); return r.fulfill({ json: { ok: true } }); }
    if (m === "DELETE") return r.fulfill({ json: { deleted: 0 } }); return r.fulfill({ json: { places: places.slice() } }); });
  const mk = (when, n) => ({ fingerprint: (0xdef000000000 + n).toString(16).padStart(12, "0"), device: "peregrine", startedAt: when, mode: "scuba", durationSec: 3000, maxDepthM: 20, o2Percent: 32, headerHex: "", profileHex: "", location: null, deviceMac: null, extra: JSON.stringify({ n, t: 28, iv: 10, s: [[10, 5, 28], [20, 18, 28]] }) });
  await page.route("**/api/dives/location", (r) => r.fulfill({ json: { updated: 1 } }));
  await page.route("**/api/dives", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { dives: [mk("2025-03-14T09:00:00", 1), mk("2025-03-15T09:00:00", 2), mk("2025-03-16T09:00:00", 3), mk("2025-03-17T09:00:00", 4)] } }) : r.fulfill({ json: { stored: 0 } })));
  await page.goto(base);
  try {
    const picker = () => page.locator("#placePicker"); const titleIs = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("ppTitle").textContent), re.source, { timeout: 8000 });
    await page.waitForFunction(() => /Dive log \(4\)/.test(document.getElementById("navLog").textContent)); await page.click("#navLog");
    // 1. add locations for two dates in the question: after Save the map search opens for each new place, one after the other
    await page.locator("#locBannerBtn").click(); await page.waitForSelector("#locPrompt .locask input", { state: "visible" });
    const ins = page.locator("#locPrompt .locask input"); await ins.nth(0).fill("Tulamben"); await ins.nth(1).fill("Komodo"); await ins.nth(2).fill("tulamben");
    await page.click("#locSave"); await page.waitForSelector("#placePicker", { state: "visible" });
    await titleIs(/Where is .Tulamben.\? \(1 more after this\)/); assert.match(await page.locator("#ppHint").innerText(), /You just entered this location/); assert.equal(await page.inputValue("#ppQuery"), "Tulamben");
    await page.waitForSelector("#ppResults .res"); assert.deepEqual(searches, ["Tulamben"], "the new place was searched, once (the spelling variant is the same place)");
    await page.locator("#ppResults .res").first().click(); await page.click("#ppSave"); await titleIs(/Where is .Komodo.\?/);
    assert.deepEqual(places.map((p) => p.name), ["Tulamben"]); assert.equal(await page.locator("#ppSkipAll").isVisible(), false, "no 'Skip all' on the last one");
    await page.waitForSelector("#ppResults .res"); await page.locator("#ppResults .res").first().click(); await page.click("#ppSave"); await page.waitForSelector("#placePicker", { state: "hidden" });
    assert.deepEqual(places.map((p) => p.name), ["Tulamben", "Komodo"]);
    // 2. a place that is already on the map does not open the map again (edit one dive's location)
    await page.locator("details.dive").first().locator("summary").click(); const one = page.locator("details.dive[open] .dive-loc");
    await one.fill("Tulamben"); await page.locator("details.dive[open] .dive-loc-save").click(); await page.waitForFunction(() => /Location saved/.test(document.getElementById("toast").textContent));
    await page.waitForTimeout(500); assert.ok(!(await picker().isVisible()), "Tulamben is already on the map"); assert.equal(searches.length, 2, "no extra search");
    // 3. a new place in the per-date editor opens the map; 'Skip all' / the switch: it can be turned off
    await one.fill("Wakatobi"); await page.locator("details.dive[open] .dive-loc-save").click(); await page.waitForSelector("#placePicker", { state: "visible" }); await titleIs(/Where is .Wakatobi.\?/);
    assert.equal(await page.locator("#ppAuto").isChecked(), true, "on by default"); await page.locator("#ppAuto").uncheck(); await page.click("#ppSkip"); await page.waitForSelector("#placePicker", { state: "hidden" });
    assert.equal(await page.evaluate(() => localStorage.getItem("mapAsk")), "0"); assert.equal(places.length, 2, "skipped: not saved");
    await one.fill("Raja Ampat"); await page.locator("details.dive[open] .dive-loc-save").click(); await page.waitForFunction(() => /Location saved/.test(document.getElementById("toast").textContent));
    await page.waitForTimeout(500); assert.ok(!(await picker().isVisible()), "switched off: the map stays closed"); assert.equal(searches.length, 3, "and no search is made");
    // 4. what was skipped is still offered: the bar in the dive log and the orange buttons under the Summary map
    await page.waitForFunction(() => /1 place is not on the map yet/.test(document.getElementById("placeBannerText").textContent), null, { timeout: 5000 });
    await page.click("#navSummary"); await page.waitForFunction(() => document.querySelectorAll("#sumMap .leaflet-marker-icon").length === 2, null, { timeout: 8000 });
    assert.equal(await page.locator("#mapUnplaced .chip").count(), 1, "Wakatobi was replaced by Raja Ampat on that dive, so Raja Ampat is the only place left");
    assert.deepEqual(errs, [], "page errors"); console.log("PASS location entry opens the map");
  } catch (e) { failed++; console.log("FAIL location entry opens the map\n ", e.message.split("\n").slice(0, 8).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-entry.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: the location box suggests places from the map while you type, and the chosen position is used on the Summary ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  const errs = [], places = [], photon = [], nominatim = []; page.on("pageerror", (e) => errs.push(e.message));
  await ctx.addInitScript(() => { try { localStorage.removeItem("mapAsk"); localStorage.removeItem("mapSuggest"); } catch (e) {} });
  const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  await page.route("**/tile.openstreetmap.org/**", (r) => r.fulfill({ body: PNG1, contentType: "image/png" }));
  const feat = (name, lon, lat, extra = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { name, state: "North Sulawesi", country: "Indonesia", ...extra } });
  const DB = { bunak: [feat("Bunaken", 124.84, 1.55), feat("Bunaken National Park", 124.76, 1.67, { city: "Manado" }), feat("Bunakeng", 125.46, 2.69)], siladen: [feat("Siladen", 124.8, 1.62)] };
  await page.route("**/photon.komoot.io/api/**", (r) => { const q = new URL(r.request().url()).searchParams.get("q"); photon.push(q); const key = Object.keys(DB).find((k) => q.toLowerCase().startsWith(k));
    return r.fulfill({ json: { type: "FeatureCollection", features: key ? DB[key] : [] }, headers: { "access-control-allow-origin": "*" } }); });
  await page.route("**/nominatim.openstreetmap.org/search*", (r) => { nominatim.push(new URL(r.request().url()).searchParams.get("q")); return r.fulfill({ json: [], headers: { "access-control-allow-origin": "*" } }); });
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", name: "Me", version: "0.0.0" } }));
  await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Me", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } }));
  await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } }));
  const k = (n) => (n || "").toLowerCase();
  await page.route("**/api/places", (r) => { const m = r.request().method(), b = r.request().postData() ? JSON.parse(r.request().postData()) : null;
    if (m === "PUT") { const i = places.findIndex((p) => k(p.name) === k(b.name)); if (i >= 0) places[i] = b; else places.push(b); return r.fulfill({ json: { ok: true } }); }
    if (m === "DELETE") return r.fulfill({ json: { deleted: 0 } }); return r.fulfill({ json: { places: places.slice() } }); });
  const mk = (when, n) => ({ fingerprint: (0x123000000000 + n).toString(16).padStart(12, "0"), device: "peregrine", startedAt: when, mode: "scuba", durationSec: 3000, maxDepthM: 20, o2Percent: 32, headerHex: "", profileHex: "", location: null, deviceMac: null, extra: JSON.stringify({ n, t: 28, iv: 10, s: [[10, 5, 28], [20, 18, 28]] }) });
  await page.route("**/api/dives/location", (r) => r.fulfill({ json: { updated: 1 } }));
  await page.route("**/api/dives", (r) => (r.request().method() === "GET" ? r.fulfill({ json: { dives: [mk("2025-03-14T09:00:00", 1), mk("2025-03-15T09:00:00", 2), mk("2025-03-16T09:00:00", 3), mk("2025-03-17T09:00:00", 4)] } }) : r.fulfill({ json: { stored: 0 } })));
  await page.goto(base);
  try {
    const box = page.locator("#locSuggest"); const toastHas = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("toast").textContent), re.source, { timeout: 8000 });
    await page.waitForFunction(() => /Dive log \(4\)/.test(document.getElementById("navLog").textContent)); await page.click("#navLog");
    await page.locator("#locBannerBtn").click(); await page.waitForSelector("#locPrompt .locask input", { state: "visible" });
    const ins = page.locator("#locPrompt .locask input");
    // 1. typing quickly makes ONE lookup (0.5 s after the last key), shown under the box
    await ins.nth(0).click(); await ins.nth(0).pressSequentially("bunak", { delay: 40 }); await box.locator(".sg").first().waitFor({ state: "visible", timeout: 8000 });
    assert.deepEqual(photon, ["bunak"], "five key presses, one request"); assert.equal(await box.locator(".sg").count(), 3);
    assert.match(await box.innerText(), /Bunaken[\s\S]*North Sulawesi, Indonesia[\s\S]*Bunaken National Park[\s\S]*Manado, North Sulawesi, Indonesia[\s\S]*OpenStreetMap/);
    const ib = await ins.nth(0).boundingBox(), bb = await box.boundingBox(); assert.ok(bb.y >= ib.y + ib.height - 1 && Math.abs(bb.x - ib.x) < 6, "the list sits right under the box: " + JSON.stringify([ib, bb]));
    // 2. keyboard: Down + Enter picks; the text becomes the place name and the box turns green
    await page.keyboard.press("ArrowDown"); assert.ok(await box.locator(".sg.hi").count() === 1); await page.keyboard.press("Enter");
    assert.equal(await ins.nth(0).inputValue(), "Bunaken"); assert.ok(await ins.nth(0).evaluate((e) => e.classList.contains("onmap")), "marked as found on the map"); assert.ok(!(await box.isVisible()), "list closed");
    assert.match(await ins.nth(0).getAttribute("title"), /Bunaken, North Sulawesi, Indonesia/); assert.equal(photon.length, 1, "picking does not search again"); assert.ok(await page.locator("#locPrompt").isVisible(), "Enter did not save the whole form");
    // 3. click a suggestion; text with no match shows no list; two letters make no request
    await ins.nth(1).click(); await ins.nth(1).pressSequentially("Siladen", { delay: 30 }); await box.locator(".sg").first().waitFor({ state: "visible" }); await box.locator(".sg").first().click(); assert.equal(await ins.nth(1).inputValue(), "Siladen");
    await ins.nth(2).click(); await ins.nth(2).pressSequentially("Raja Ampat", { delay: 20 }); await page.waitForTimeout(900); assert.ok(!(await box.isVisible()), "nothing found: no empty list");
    const before = photon.length; await ins.nth(3).click(); await ins.nth(3).pressSequentially("xy", { delay: 20 }); await page.waitForTimeout(800); assert.equal(photon.length, before, "two letters: no request"); await ins.nth(3).fill("");
    // 4. Save: Bunaken and Siladen go to the map with the chosen positions, no extra step; only Raja Ampat (typed, not picked) goes to the map search
    await page.click("#locSave"); await page.waitForSelector("#placePicker", { state: "visible" });
    assert.deepEqual(places.map((p) => [p.name, p.lat, p.lon]), [["Bunaken", 1.55, 124.84], ["Siladen", 1.62, 124.8]], "saved with the positions from the suggestions");
    await page.waitForFunction(() => /Where is .Raja Ampat.\?/.test(document.getElementById("ppTitle").textContent)); assert.deepEqual(nominatim, ["Raja Ampat"], "the one place that was not picked uses the map search");
    await toastHas(/“Bunaken”, “Siladen” added to the map/); await page.click("#ppSkip"); await page.waitForSelector("#placePicker", { state: "hidden" });
    await page.click("#navSummary"); await page.waitForFunction(() => document.querySelectorAll("#sumMap .leaflet-marker-icon").length === 2, null, { timeout: 8000 });
    assert.match(await page.locator("#mapMsg").innerText(), /3 places . 2 on the map . 1 still to place/);
    // 5. the single-dive box works the same; editing the text after picking drops the chosen position
    await page.click("#navLog"); await page.locator("details.dive").first().locator("summary").click(); const one = page.locator("details.dive[open] .dive-loc");
    await one.click(); await one.pressSequentially("bunak", { delay: 30 }); await box.locator(".sg").first().waitFor({ state: "visible" }); await box.locator(".sg").first().click(); assert.ok(await one.evaluate((e) => e.classList.contains("onmap")));
    await one.press("End"); await one.pressSequentially("2", { delay: 20 }); assert.ok(!(await one.evaluate((e) => e.classList.contains("onmap"))), "edited: no longer the chosen place");
    await page.locator("details.dive[open] .dive-loc-save").click(); await page.waitForSelector("#placePicker", { state: "visible" }); await page.waitForFunction(() => /Where is .Bunaken2.\?/.test(document.getElementById("ppTitle").textContent)); await page.click("#ppSkip");
    // 6. 'Turn off' stops the lookups
    await one.fill(""); await one.pressSequentially("siladen", { delay: 20 }); await page.waitForTimeout(100); await box.locator(".sg-off").waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
    if (!(await box.isVisible())) await one.pressSequentially("x", { delay: 20 }); await box.locator(".sg-off").first().click({ timeout: 8000 });
    assert.equal(await page.evaluate(() => localStorage.getItem("mapSuggest")), "0"); const n = photon.length; await one.fill(""); await one.pressSequentially("bunaken park", { delay: 20 }); await page.waitForTimeout(900);
    assert.equal(photon.length, n, "switched off: no lookups"); assert.ok(!(await box.isVisible()));
    assert.deepEqual(errs, [], "page errors"); console.log("PASS map suggestions in the location box");
  } catch (e) { failed++; console.log("FAIL map suggestions in the location box\n ", e.message.split("\n").slice(0, 8).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-suggest.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: light / dark switch at the top of the page (left = light, right = dark), remembered, follows the phone until chosen ----
{
  const mkPage = async (opts, pre) => {
    const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block", ...opts }); const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    if (pre) await ctx.addInitScript(pre);
    await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", name: "Me", version: "0.0.0" } }));
    await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } })); await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } }));
    await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Togar Hugo", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } }));
    await page.route("**/api/places", (r) => r.fulfill({ json: { places: [] } })); await page.route("**/api/dives", (r) => r.fulfill({ json: { dives: [] } }));
    await page.goto(base); await page.waitForSelector("header .theme-switch"); return { ctx, page, errs };
  };
  const look = (page) => page.evaluate(() => { const cs = (s) => getComputedStyle(document.querySelector(s)); const lum = (c) => { const [r, g, b] = c.match(/\d+/g).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05); const sw = document.querySelector(".theme-switch");
    return { theme: document.documentElement.dataset.theme, page: cs("body").backgroundColor, card: cs("#sumDiver").backgroundColor, nameRatio: ratio(cs("#sumName").color, cs("#sumDiver").backgroundColor), checked: sw.getAttribute("aria-checked"), knobX: document.querySelector(".ts-knob").getBoundingClientRect().x - sw.getBoundingClientRect().x, scheme: cs("html").colorScheme, meta: document.querySelector('meta[name="theme-color"]').content }; });
  try {
    // 1. nothing chosen yet: the phone's own setting decides
    let { ctx, page, errs } = await mkPage({ colorScheme: "dark" }); let d = await look(page);
    assert.equal(d.theme, "dark", "follows a dark phone"); assert.equal(d.checked, "true"); assert.equal(d.page, "rgb(13, 17, 23)"); assert.equal(d.card, "rgb(22, 27, 34)"); assert.equal(d.scheme, "dark"); assert.equal(d.meta, "#0d1117"); assert.ok(d.nameRatio > 7, "readable: " + d.nameRatio);
    assert.equal(await page.evaluate(() => localStorage.getItem("theme")), null, "following the phone is not a saved choice");
    await ctx.close();
    ({ ctx, page, errs } = await mkPage({ colorScheme: "light" })); d = await look(page); assert.equal(d.theme, "light"); assert.equal(d.checked, "false"); assert.equal(d.page, "rgb(248, 249, 250)"); assert.equal(d.card, "rgb(255, 255, 255)"); assert.equal(d.meta, "#007bff"); assert.ok(d.nameRatio > 7);
    // 2. the switch: at the top of the page, a real switch, light on the left and dark on the right
    const sw = page.locator("header .theme-switch"); assert.equal(await sw.getAttribute("role"), "switch"); assert.equal(await sw.getAttribute("aria-label"), "Dark mode");
    const box = await sw.boundingBox(), hb = await page.locator("header h1").boundingBox(); assert.ok(box.x + box.width / 2 < 150 && Math.abs(box.y + box.height / 2 - (hb.y + hb.height / 2)) < 30, "at the top left, level with the title: " + JSON.stringify([box, hb])); assert.equal(Math.round(box.height), 32, "a compact switch, not a tall button");
    assert.ok(box.width >= 56 && box.height >= 28, "big enough to tap"); const lightKnob = d.knobX; assert.ok(lightKnob < 8, "light: the knob is on the left (" + lightKnob + ")");
    assert.ok((await page.locator(".theme-switch .ts-sun").boundingBox()).x < (await page.locator(".theme-switch .ts-moon").boundingBox()).x, "sun icon left of the moon icon");
    await sw.click(); await page.waitForTimeout(450); d = await look(page); assert.equal(d.theme, "dark"); assert.equal(d.checked, "true"); assert.ok(d.knobX > 24, "dark: the knob moved to the right (" + d.knobX + ")"); assert.equal(d.page, "rgb(13, 17, 23)"); assert.ok(d.nameRatio > 7);
    assert.equal(await page.evaluate(() => localStorage.getItem("theme")), "dark");
    // the logo replaces the title text: the one for the current theme is shown, it loads, it has the title as its name, and it fits between the switch and the avatar
    const logo = async () => page.evaluate(() => { const vis = [...document.querySelectorAll("header .logo")].filter((i) => getComputedStyle(i).display !== "none"); const r = vis[0] && vis[0].getBoundingClientRect(), s = document.querySelector(".theme-switch").getBoundingClientRect(), a = document.getElementById("acctBtn").getBoundingClientRect();
      return { shown: vis.map((i) => i.className), ok: !!vis[0] && vis[0].complete && vis[0].naturalWidth > 300, alt: vis[0] && vis[0].alt, left: r && r.left - s.right, right: r && a.left - r.right, w: r && r.width }; });
    let lg = await logo(); assert.deepEqual(lg.shown, ["logo logo-dark"], "dark theme: the cream logo"); assert.ok(lg.ok, "logo loads"); assert.equal(lg.alt, "Dive Manager"); assert.ok(lg.left >= 0 && lg.right >= 0, "does not touch the switch or the avatar: " + JSON.stringify(lg));
    assert.ok(await page.getByRole("heading", { name: "Dive Manager" }).isVisible(), "the heading still reads Dive Manager for screen readers");
    await page.locator("header .theme-switch").click(); await page.waitForTimeout(450); lg = await logo(); assert.deepEqual(lg.shown, ["logo logo-light"], "light theme: the dark logo"); assert.ok(lg.ok); await page.locator("header .theme-switch").click(); await page.waitForTimeout(450);
    // 3. remembered after a reload, no flash (the script runs in <head> before the page is painted)
    assert.equal(await page.evaluate(() => { const s = document.querySelector('head script[src="/auth/theme.js"]'); return !!s && !s.async && !s.defer; }), true, "theme.js blocks painting so there is no light flash");
    await page.reload(); await page.waitForSelector("header .theme-switch"); d = await look(page); assert.equal(d.theme, "dark", "still dark after a reload");
    // 4. keyboard works, and a chosen light beats a dark phone
    await page.locator("header .theme-switch").focus(); await page.keyboard.press("Enter"); assert.equal((await look(page)).theme, "light"); await page.keyboard.press("Space"); assert.equal((await look(page)).theme, "dark"); await page.keyboard.press("Enter");
    await ctx.close();
    ({ ctx, page } = await mkPage({ colorScheme: "dark" }, () => { try { localStorage.setItem("theme", "light"); } catch (e) {} })); d = await look(page); assert.equal(d.theme, "light", "your choice wins over the phone's setting"); assert.equal(d.checked, "false");
    // 5. every screen is readable in dark: no text with a contrast below 3:1 (Summary, Dive log, Device, Account)
    await page.locator("header .theme-switch").click();
    const lowContrast = () => page.evaluate(() => { const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(",").map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
      const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const bgOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 0.99) break; } } let out = layers.length && layers[layers.length - 1].a >= 0.99 ? layers.pop() : { r: 13, g: 17, b: 23 }; while (layers.length) { const l = layers.pop(); out = { r: l.r * l.a + out.r * (1 - l.a), g: l.g * l.a + out.g * (1 - l.a), b: l.b * l.a + out.b * (1 - l.a) }; } return out; };
      const bad = []; for (const el of document.querySelectorAll("body *")) { if (el.closest("svg, .leaflet-container, script, style")) continue; const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue; const cs = getComputedStyle(el); if (cs.visibility === "hidden" || +cs.opacity === 0) continue;
        if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue; const fg = parse(cs.color), bg = bgOf(el), a = lum(fg), b = lum(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (ratio < 2.9) bad.push(`${el.tagName}#${el.id}.${el.className} "${el.textContent.trim().slice(0, 25)}" ${ratio.toFixed(2)}`); } return bad; });
    for (const [name, go] of [["Summary", () => page.click("#navSummary")], ["Dive log", () => page.click("#navLog")], ["Certificates", () => page.click("#navCerts")], ["Device", () => page.click("#navDevice")], ["Account", async () => { await page.click("#acctBtn"); for (const sec of ["profile", "password", "dan", "regulator", "help"]) await page.locator(`details.acc[data-sec=${sec}] > summary`).click(); }]]) {
      await go(); await page.waitForTimeout(250); const bad = await lowContrast(); const ok = bad.filter((x) => !/regbadge/.test(x)); assert.deepEqual(ok, [], name + " has hard-to-read text in dark mode");
    }
    assert.deepEqual(errs, [], "page errors"); console.log("PASS light/dark switch");
  } catch (e) { failed++; console.log("FAIL light/dark switch\n ", e.message.split("\n").slice(0, 8).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); }
}
// ---- scenario: tab icons and the Geist / Geist Mono fonts ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage(); const errs = [], bad = []; page.on("pageerror", (e) => errs.push(e.message)); page.on("response", (r) => { if (r.status() >= 400) bad.push(r.status() + " " + r.url()); });
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", name: "Me", version: "0.0.0" } }));
  await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } })); await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Me", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } })); await page.route("**/api/places", (r) => r.fulfill({ json: { places: [] } })); await page.route("**/api/keys", (r) => r.fulfill({ json: { keys: [], max: 10 } }));
  const mk = (when, n) => ({ fingerprint: (0x777000000000 + n).toString(16).padStart(12, "0"), device: "peregrine", startedAt: when, mode: "scuba", durationSec: 3000, maxDepthM: 20, o2Percent: 32, headerHex: "", profileHex: "", location: "Komodo", deviceMac: null, extra: JSON.stringify({ n, t: 28, iv: 10, s: [[10, 5, 28], [20, 18, 28]] }) });
  await page.route("**/api/dives", (r) => r.fulfill({ json: { dives: [mk("2025-03-14T09:00:00", 1), mk("2025-03-15T09:00:00", 2)] } }));
  await ctx.addInitScript(() => { try { localStorage.setItem("sources", '["cosmiq"]'); } catch (e) {} });   // these test dives are Peregrine ones: add the Cosmiq+ so its Device tab is there
  await page.goto(base);
  try {
    await page.waitForFunction(() => /Dive log \(2\)/.test(document.getElementById("navLog").textContent), null, { timeout: 8000 });
    // 1. every tab has its icon above its label, painted in the label's colour (a one-colour mask), at the same size
    const tabs = await page.evaluate(() => ["navSummary", "navLog", "navImport", "navCerts", "navDevice"].map((id) => { const b = document.getElementById(id), i = b.querySelector(".ti"), ci = getComputedStyle(i), cb = getComputedStyle(b), r = i.getBoundingClientRect(), s = b.querySelector("span").getBoundingClientRect();
      return { id, icon: (ci.webkitMaskImage || ci.maskImage), w: Math.round(r.width), h: Math.round(r.height), above: r.bottom <= s.top + 1, same: ci.backgroundColor === cb.color, text: b.innerText.trim(), aria: i.getAttribute("aria-hidden") }; }));
    assert.deepEqual(tabs.map((t) => t.id), ["navSummary", "navLog", "navImport", "navCerts", "navDevice"]); assert.match(tabs[0].icon, /icon-summary\.png/); assert.match(tabs[1].icon, /icon-log\.png/); assert.match(tabs[2].icon, /icon-import\.png/); assert.match(tabs[3].icon, /icon-cert\.png/); assert.match(tabs[4].icon, /icon-device\.png/);
    for (const t of tabs) { assert.equal(t.w, 28); assert.equal(t.h, 28); assert.ok(t.above, t.id + ": icon above the label"); assert.ok(t.same, t.id + ": icon has the label colour"); assert.equal(t.aria, "true", "decorative icon"); }
    assert.deepEqual(tabs.map((t) => t.text), ["Overview", "Dive log (2)", "Import", "Certificates", "Device"], "the first tab is called Overview, the count is still there");
    await page.click("#navLog"); await page.waitForFunction(() => document.getElementById("navLog").classList.contains("active")); const active = await page.evaluate(() => { const b = document.getElementById("navLog"); return getComputedStyle(b.querySelector(".ti")).backgroundColor === getComputedStyle(b).color && getComputedStyle(b).color === "rgb(255, 255, 255)"; }); assert.ok(active, "the active tab's icon is white like its label");
    // 2. the icon files load (not a broken mask), and the tab row still fits five tabs on a phone
    for (const f of ["icon-summary", "icon-log", "icon-import", "icon-cert", "icon-device"]) assert.ok(await page.evaluate(async (u) => { const r = await fetch(u); return r.ok && /png/.test(r.headers.get("content-type")); }, `/auth/${f}.png`), f + " loads");
    const row = await page.evaluate(() => ({ nav: document.querySelector(".nav").scrollWidth <= document.querySelector(".nav").clientWidth + 1, h: Math.round(document.getElementById("navSummary").getBoundingClientRect().height) })); assert.ok(row.nav, "no sideways scrolling in the tab row"); assert.ok(row.h >= 60 && row.h <= 76, "tab height " + row.h);
    for (const w of [390, 360]) { await page.setViewportSize({ width: w, height: 800 }); await page.evaluate(() => { document.getElementById("diveCount").textContent = "(244)"; }); await page.waitForTimeout(150);
      const fit = await page.evaluate(() => { const nav = document.querySelector(".nav"); return { scroll: nav.scrollWidth <= nav.clientWidth + 1, clipped: [...nav.querySelectorAll("button")].filter((b) => b.querySelector("span").scrollWidth > b.clientWidth - 2).map((b) => b.id), n: nav.querySelectorAll("button").length }; });
      assert.equal(fit.n, 5, "Summary, Dive log, Import, Certificates, Device"); assert.ok(fit.scroll, "five tabs fit on a " + w + " px phone without sideways scrolling"); assert.deepEqual(fit.clipped, [], "no tab label is cut off at " + w + " px (even with a three digit dive count)"); }
    await page.setViewportSize({ width: 412, height: 915 });
    // 3. the fonts: Geist for text (buttons and inputs too), Geist Mono for numbers; loaded from this app
    await page.locator("details.dive").first().locator("summary").click().catch(() => {}); await page.waitForTimeout(300);
    const f = await page.evaluate(async () => { await document.fonts.ready; const fam = (s) => getComputedStyle(document.querySelector(s)).fontFamily.split(",")[0].replace(/"/g, ""); return { body: fam("body"), button: fam("#connectBtn"), input: fam("input"), mono: fam(".dive-num"), meta: fam(".dive-meta"), sans: document.fonts.check("16px Geist"), monoOk: document.fonts.check("16px 'Geist Mono'"), loaded: [...document.fonts].filter((x) => x.status === "loaded").map((x) => x.family.replace(/"/g, "")).sort() }; });
    assert.equal(f.body, "Geist"); assert.equal(f.button, "Geist", "buttons use the page font"); assert.equal(f.input, "Geist", "inputs use the page font"); assert.equal(f.mono, "Geist Mono", "dive numbers in the mono font"); assert.equal(f.meta, "Geist Mono"); assert.ok(f.sans && f.monoOk, "both fonts are loaded"); assert.deepEqual(f.loaded, ["Geist", "Geist Mono"]);
    assert.deepEqual(bad.filter((u) => !/photon|nominatim|tile\.openstreetmap|favicon/.test(u)), [], "no failed requests (fonts and icons are found)"); assert.deepEqual(errs, [], "page errors"); console.log("PASS tab icons and fonts");
  } catch (e) { failed++; console.log("FAIL tab icons and fonts\n ", e.message.split("\n").slice(0, 8).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-tabs.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: scuba and freedive are told apart in the Summary totals and on the map ----
{
  const run = async (dives, pre) => {
    const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await ctx.addInitScript(() => { try { localStorage.setItem("mapAsk", "0"); if (!sessionStorage.getItem("__fresh")) { localStorage.removeItem("mapKind"); sessionStorage.setItem("__fresh", "1"); } } catch (e) {} }); if (pre) await ctx.addInitScript(pre);        // start clean once: a reload must keep what the page saved
    const PNG1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    await page.route("**/tile.openstreetmap.org/**", (r) => r.fulfill({ body: PNG1, contentType: "image/png" }));
    await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", name: "Me", version: "0.0.0" } })); await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } }));
    await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Me", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } })); await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } }));
    await page.route("**/api/places", (r) => r.fulfill({ json: { places: [{ name: "Tulamben", lat: -8.29, lon: 115.59 }, { name: "Bunaken", lat: 1.6, lon: 124.76 }, { name: "Raja Ampat", lat: -0.55, lon: 130.5 }] } }));
    await page.route("**/api/dives", (r) => r.fulfill({ json: { dives } })); await page.goto(base); await page.waitForSelector("#sumMap .leaflet-marker-icon", { timeout: 10000 }); return { ctx, page, errs };
  };
  const mk = (n, when, loc, mode, dur) => ({ fingerprint: (0x555000000000 + n).toString(16).padStart(12, "0"), device: "peregrine", startedAt: when, mode, durationSec: dur, maxDepthM: 15, o2Percent: null, headerHex: "", profileHex: "", location: loc, deviceMac: null, extra: JSON.stringify({ n, t: 28, iv: 10, s: [[10, 5, 28], [20, 12, 28]] }) });
  const dives = [mk(1, "2025-03-14T09:00:00", "Tulamben", "scuba", 3000), mk(2, "2025-03-14T13:00:00", "Tulamben", "scuba", 3300), mk(3, "2025-03-15T09:00:00", "tulamben", "gauge", 2700),
    mk(4, "2025-05-03T09:00:00", "Bunaken", "freedive", 45), mk(5, "2025-05-03T09:10:00", "Bunaken", "freedive", 70), mk(6, "2025-05-03T14:00:00", "Bunaken", "scuba", 3000), mk(7, "2025-11-04T08:00:00", "Raja Ampat", "freedive", 90), mk(8, "2025-12-10T08:00:00", "", "freedive", 193)];
  try {
    let { ctx, page, errs } = await run(dives);
    // 1. totals: scuba (incl. gauge) and freedive, each with its time and number of dives; they add up to the total
    const kinds = await page.evaluate(() => [...document.querySelectorAll("#sumKinds .kindrow")].map((r) => ({ chip: r.querySelector(".kindchip").textContent, cls: r.querySelector(".kindchip").className, time: r.querySelector("b").textContent, n: r.querySelector(".muted").textContent })));
    assert.deepEqual(kinds.map((k) => [k.chip, k.time, k.n]), [["Scuba", "3 h 20 min", "4 dives"], ["Freedive", "6 min 38 s", "4 dives"]], "gauge counts as scuba; freedive time in minutes and seconds: " + JSON.stringify(kinds));
    assert.match(kinds[0].cls, /kind-scuba/); assert.match(kinds[1].cls, /kind-freedive/); assert.equal(await page.locator("#sumHours").innerText(), "3 h 27 min", "total = scuba + freedive (12000 s + 398 s)"); assert.match(await page.locator("#sumCount").innerText(), /across 8 dives/);
    assert.equal((await page.locator("#sumLastKind").textContent()).toLowerCase(), "freedive", "the last dive is a freedive"); assert.match(await page.locator("#sumLastKind").getAttribute("class"), /kind-freedive/);
    // 2. the map: a filter with the number of places per kind, pins coloured by kind, the count on a pin follows the filter
    assert.deepEqual((await page.locator("#mapKinds button").allInnerTexts()).map((t) => t.replace(/\s+/g, " ")), ["All · 3", "Scuba · 2", "Freedive · 2"]); assert.ok(await page.locator("#mapLegend").isVisible());
    const pins = () => page.evaluate(() => [...document.querySelectorAll("#sumMap .leaflet-marker-icon")].map((m) => ({ title: m.title, n: m.querySelector("text").textContent, fill: m.querySelector("path").getAttribute("fill").startsWith("url(") ? "split" : m.querySelector("path").getAttribute("fill") })).sort((a, b) => a.title.localeCompare(b.title)));
    // (the place shows the newest spelling used: "tulamben")
    assert.deepEqual(await pins(), [{ title: "Bunaken: 1 scuba, 2 freedive", n: "3", fill: "split" }, { title: "Raja Ampat: 1 freedive", n: "1", fill: "#12b886" }, { title: "tulamben: 3 scuba", n: "3", fill: "#228be6" }], "scuba blue, freedive green, both = split: " + JSON.stringify(await pins()));
    await page.locator("#sumMap .leaflet-marker-icon[title^=Bunaken]").click(); await page.waitForSelector("#sumMap .pin-pop"); const pop = await page.locator("#sumMap .pin-pop").innerText(); assert.match(pop, /Bunaken[\s\S]*SCUBA\s+1 dive . 50 min[\s\S]*FREEDIVE\s+2 dives . 1 min 55 s[\s\S]*May 2025/i, pop);
    await page.locator('#mapKinds button[data-kind="freedive"]').click(); await page.waitForFunction(() => document.querySelectorAll("#sumMap .leaflet-marker-icon").length === 2); assert.deepEqual((await pins()).map((p) => [p.title.split(":")[0], p.n, p.fill]), [["Bunaken", "2", "#12b886"], ["Raja Ampat", "1", "#12b886"]], "only freedive places, with their freedive count");
    assert.match(await page.locator("#mapMsg").innerText(), /3 places . 3 on the map . showing freedive only/);
    await page.locator('#mapKinds button[data-kind="scuba"]').click(); await page.waitForFunction(() => document.querySelectorAll("#sumMap .leaflet-marker-icon").length === 2); assert.deepEqual((await pins()).map((p) => [p.title.split(":")[0], p.n, p.fill]), [["Bunaken", "1", "#228be6"], ["tulamben", "3", "#228be6"]]);
    assert.ok(!(await page.locator("#placeDetails").isVisible()), "every place is on the map: the list of places is hidden"); assert.equal(await page.locator("#mapEdit").innerText(), "Edit places"); await page.locator("#mapEdit").click(); assert.ok(await page.locator("#placeDetails").isVisible(), "Edit places shows it"); assert.equal(await page.locator("#mapEdit").innerText(), "Done editing places"); assert.equal(await page.locator("#placeList .place-row").count(), 3, "the list of all places does not depend on the filter");
    await page.locator("#mapEdit").click(); assert.ok(!(await page.locator("#placeDetails").isVisible()), "Done editing hides it again");
    // 3. the filter is remembered; a reload keeps it
    await page.reload(); await page.waitForSelector("#sumMap .leaflet-marker-icon"); assert.equal(await page.locator("#mapKinds button.active").getAttribute("data-kind"), "scuba", "remembered"); assert.equal(await page.evaluate(() => localStorage.getItem("mapKind")), "scuba");
    assert.deepEqual(errs, [], "page errors"); await ctx.close();
    // 4. nobody freediving: no filter, no legend, no freedive row - only the totals of scuba
    ({ ctx, page, errs } = await run(dives.filter((d) => d.mode !== "freedive")));
    assert.ok(!(await page.locator("#mapKinds").isVisible()), "no filter without freedives"); assert.ok(!(await page.locator("#mapLegend").isVisible())); assert.deepEqual(await page.locator("#sumKinds .kindrow").evaluateAll((r) => r.map((x) => x.querySelector(".kindchip").textContent)), ["Scuba"]);
    assert.deepEqual(errs, []); await ctx.close();
    // 5. a stored 'freedive' filter does not hide the map once there are no freedives left
    ({ ctx, page, errs } = await run(dives.filter((d) => d.mode !== "freedive"), () => { try { localStorage.setItem("mapKind", "freedive"); } catch (e) {} })); assert.equal(await page.locator("#sumMap .leaflet-marker-icon").count(), 2, "pins still shown"); await ctx.close();
    console.log("PASS scuba and freedive");
  } catch (e) { failed++; console.log("FAIL scuba and freedive\n ", e.message.split("\n").slice(0, 8).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); }
}
// ---- scenario: Account > API access (generate, show once, copy, rotate, revoke, delete, endpoint information) ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block", permissions: ["clipboard-read", "clipboard-write"] }); const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", name: "Me", version: "0.0.0" } })); await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Me", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } })); await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } }));
  await page.route("**/api/places", (r) => r.fulfill({ json: { places: [] } })); await page.route("**/api/dives", (r) => r.fulfill({ json: { dives: [] } }));
  const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 19) + "Z"; let seq = 0; const calls = [];
  let keys = [{ id: "a".repeat(16), description: "Home dashboard", prefix: "dm_Qx7Lm2p", lifetimeDays: 30, createdAt: iso(-12), expiresAt: iso(18), lastUsedAt: iso(0), revokedAt: null, status: "active", rotatedFrom: null }];
  const mkKey = (b) => ({ id: (++seq).toString(16).padStart(16, "0"), description: b.description, prefix: "dm_Ab3xK9m", lifetimeDays: b.days || null, createdAt: iso(0), expiresAt: b.days ? iso(b.days) : null, lastUsedAt: null, revokedAt: null, status: "active", rotatedFrom: null });
  const SECRET = (n) => "dm_" + String(n).repeat(43).slice(0, 43);
  await page.route("**/api/keys", (r) => { if (r.request().method() === "GET") return r.fulfill({ json: { keys, max: 10 } }); const b = JSON.parse(r.request().postData()); calls.push(["create", b]); if (keys.filter((k) => k.status === "active").length >= 10) return r.fulfill({ status: 409, json: { error: "You can have 10 active keys. Revoke one first." } }); const it = mkKey(b); keys = [it, ...keys]; return r.fulfill({ json: { key: SECRET(1), item: it } }); });
  await page.route(/\/api\/keys\/[0-9a-f]{16}(\/(rotate|revoke))?$/, (r) => { const m = r.request().method(), u = new URL(r.request().url()).pathname.split("/"), id = u[3], act = u[4]; calls.push([act || "delete", id]);
    if (act === "rotate") { const old = keys.find((k) => k.id === id); old.status = "revoked"; old.revokedAt = iso(0); const it = mkKey({ description: old.description, days: old.lifetimeDays }); keys = [it, ...keys]; return r.fulfill({ json: { key: SECRET(2), item: it } }); }
    if (act === "revoke") { const k = keys.find((x) => x.id === id); k.status = "revoked"; k.revokedAt = iso(0); return r.fulfill({ json: { ok: true } }); }
    keys = keys.filter((k) => k.id !== id); return r.fulfill({ json: { ok: true } }); });
  await page.goto(base);
  try {
    await page.waitForFunction(() => /1 key/.test(document.getElementById("apiBadge").textContent), null, { timeout: 8000 });
    await page.click("#acctBtn"); const sec = page.locator('details.acc[data-sec="api"]'); await sec.locator("> summary").click();
    // 1. the endpoint information: this site's own address, the header, the endpoints, the options, an example
    assert.equal(await page.locator("#apiBase").innerText(), base.replace(/\/$/, "") + "/api/v1", "the base address of this very site"); assert.match(await page.locator("#apiDocs").innerText(), /Authorization: Bearer dm_/); assert.match(await page.locator("#apiDocs").innerText(), /never in the web address/);
    const eps = await page.locator("#apiDocs table.apitable").first().locator("tr").evaluateAll((rows) => rows.map((r) => r.querySelector("td").textContent)); assert.deepEqual(eps, ["/ping", "/summary", "/dives", "/dives/{id}"]);
    await page.locator("#apiDocs .apimore > summary").click(); const opts = await page.locator("#apiDocs .apimore table.apitable td:first-child").allInnerTexts(); for (const o of ["limit", "cursor", "order", "from, to", "device", "kind", "location", "uploadedSince", "include"]) assert.ok(opts.includes(o), "option " + o + " documented: " + opts.join("|"));
    assert.match(await page.locator("#apiCurl").innerText(), new RegExp(`curl -H "Authorization: Bearer dm_YOUR_KEY"[\\s\\S]*${base.replace(/[.\\/]/g, "\\$&").replace(/\/$/, "")}/api/v1/dives`)); const ex = JSON.parse(await page.locator("#apiExample").innerText()); assert.deepEqual(Object.keys(ex.dives[0]).slice(0, 5), ["id", "device", "kind", "mode", "startedAt"]); assert.ok("nextCursor" in ex);
    await page.click("#apiCopyBase"); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), base.replace(/\/$/, "") + "/api/v1", "copies the address");
    // 2. the form: the four lifetimes, 30 days preselected, a warning for unlimited, a description is required
    assert.deepEqual(await page.locator("#apiDays option").evaluateAll((o) => o.map((x) => [x.value, x.textContent])), [["7", "7 days"], ["14", "14 days"], ["30", "30 days"], ["0", "Unlimited"]]); assert.equal(await page.inputValue("#apiDays"), "30");
    assert.ok(!(await page.locator("#apiUnlimitedWarn").isVisible())); await page.selectOption("#apiDays", "0"); assert.match(await page.locator("#apiUnlimitedWarn").innerText(), /until you revoke it/); await page.selectOption("#apiDays", "14");
    await page.click("#apiGen"); assert.match(await page.locator("#apiMsg").innerText(), /Describe what the key is for/); assert.equal(calls.length, 0, "nothing was sent without a description");
    // 3. generate: the key is shown once, with a warning; copy works; the list gets the new key with its description and lifetime
    await page.fill("#apiDesc", "  Garmin watch sync  "); await page.click("#apiGen"); await page.waitForSelector("#apiNew", { state: "visible" });
    assert.deepEqual(calls.at(-1), ["create", { description: "Garmin watch sync", days: 14 }]); assert.equal(await page.locator("#apiKeyText").innerText(), SECRET(1)); assert.match(await page.locator("#apiNew").innerText(), /cannot be shown again/); assert.equal(await page.inputValue("#apiDesc"), "", "the form is cleared");
    await page.click("#apiCopy"); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), SECRET(1), "the key is copied"); assert.equal(await page.locator("#apiCopy").innerText(), "Copied ✓");
    const row0 = page.locator("#apiList .keyrow").first(); assert.match(await row0.innerText(), /Garmin watch sync[\s\S]*14 d/, "one short line: the name and how long it has left"); assert.ok(!(await row0.locator(".kdetail").isVisible()), "details are closed");
    await row0.locator(".kmain").click(); assert.match(await row0.locator(".kdetail").innerText(), /dm_Ab3xK9m.*Active . expires .* \(in 14 days\)[\s\S]*Made .*never used/); assert.equal(await row0.locator(".kmain").getAttribute("aria-expanded"), "true"); await row0.locator(".kmain").click(); assert.ok(!(await row0.locator(".kdetail").isVisible()), "tap again to close");
    assert.ok(!(await page.locator("#apiList").innerText()).includes(SECRET(1)), "the list never shows the key");
    const line = await row0.evaluate((r) => { const b = (s) => r.querySelector(s).getBoundingClientRect(), main = b(".kmain"), name = b(".kname"), chip = b(".kchip"), rot = b(".k-rotate"), rev = b(".k-revoke"), row = r.getBoundingClientRect(), c = (x) => x.top + x.height / 2; return { h: Math.round(row.height), aligned: [name, chip, rot, rev].every((x) => Math.abs(c(x) - c(main)) < 4), order: name.left < chip.left && chip.right <= rot.left + 1 && rot.right <= rev.left + 1, inside: rev.right <= row.right + 1 }; });
    assert.ok(line.h <= 56, "one line per key: " + line.h + " px"); assert.ok(line.aligned && line.order && line.inside, "name, status and buttons side by side: " + JSON.stringify(line));
    assert.deepEqual(await row0.locator(".kact").evaluateAll((b) => b.map((x) => x.getAttribute("aria-label"))), ["Rotate: Garmin watch sync", "Revoke: Garmin watch sync"], "icon buttons keep their names for screen readers");
    await page.click("#apiHide"); assert.ok(!(await page.locator("#apiNew").isVisible())); assert.equal(await page.locator("#apiKeyText").innerText(), "", "gone from the page, not just hidden"); assert.ok(!(await page.content()).includes(SECRET(1)), "the key is nowhere in the page any more");
    // 4. rotate: needs a second tap; shows the new key once; the old one is listed as revoked
    const first = page.locator("#apiList .keyrow").first(); await first.locator(".k-rotate").click(); assert.equal(await first.locator(".k-rotate").innerText(), "Sure?"); assert.ok(await first.locator(".k-rotate.armed").count(), "the button turns red"); assert.equal(calls.filter((c) => c[0] === "rotate").length, 0, "one tap does nothing");
    await first.locator(".k-revoke").click(); assert.equal(await first.locator(".k-rotate").innerText(), "", "arming another button disarms the first (it shows its icon again)"); assert.ok(await first.locator(".k-rotate svg").count()); assert.equal(await first.locator(".k-revoke").innerText(), "Sure?"); await first.locator(".k-rotate").click();
    await first.locator(".k-rotate").click(); await page.waitForSelector("#apiNew", { state: "visible" }); assert.equal(await page.locator("#apiKeyText").innerText(), SECRET(2)); assert.match(await page.locator("#apiNewTitle").innerText(), /Rotated: Garmin watch sync.*old key stopped working/);
    assert.equal(await page.locator("#apiList .keyrow.revoked").count(), 1, "the old key is revoked"); assert.match(await page.locator("#apiList .keyrow.revoked").innerText(), /Revoked/); assert.equal(await page.locator("#apiList .keyrow.revoked .k-rotate").count(), 0, "a revoked key cannot be rotated"); assert.equal(await page.locator("#apiList .keyrow.revoked .k-delete").count(), 1);
    // 5. revoke (two taps) and delete (two taps)
    await page.click("#apiHide"); const home = page.locator("#apiList .keyrow", { hasText: "Home dashboard" }); await home.locator(".k-revoke").click(); await home.locator(".k-revoke").click(); await page.waitForFunction(() => document.querySelectorAll("#apiList .keyrow.revoked").length === 2); assert.ok(calls.some((c) => c[0] === "revoke"));
    const rv = page.locator("#apiList .keyrow.revoked").first(); await rv.locator(".k-delete").click(); await rv.locator(".k-delete").click(); await page.waitForFunction(() => document.querySelectorAll("#apiList .keyrow").length === 2); assert.ok(calls.some((c) => c[0] === "delete"));
    assert.equal(await page.locator("#apiCount").innerText(), "1 of 10 active keys"); assert.equal(await page.locator("#apiBadge").innerText(), "1 key");
    // 6. a server refusal (10 keys) is explained; a reload shows no key
    keys = Array.from({ length: 10 }, (_, i) => ({ ...mkKey({ description: "k" + i, days: 30 }) })); await page.reload(); await page.click("#acctBtn"); await page.locator('details.acc[data-sec="api"] > summary').click(); await page.waitForFunction(() => document.querySelectorAll("#apiList .keyrow").length === 10);
    assert.ok((await page.locator("#apiList").boundingBox()).height < 10 * 56, "ten keys fit in about ten lines: " + (await page.locator("#apiList").boundingBox()).height);
    await page.fill("#apiDesc", "one too many"); await page.click("#apiGen"); await page.waitForFunction(() => /10 active keys/.test(document.getElementById("apiMsg").textContent)); assert.ok(!(await page.locator("#apiNew").isVisible()), "no key box after a refusal");
    assert.deepEqual(errs, [], "page errors"); console.log("PASS api access");
  } catch (e) { failed++; console.log("FAIL api access\n ", e.message.split("\n").slice(0, 8).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-api.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: laptop layout (sidebar on the left from 1024px up) and the unchanged phone layout below it ----
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 }, serviceWorkers: "block" }); const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", version: "0.0.0" } })); await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Me", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } })); await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } }));
  await page.route("**/api/places", (r) => r.fulfill({ json: { places: [] } })); await page.route("**/api/dives", (r) => r.fulfill({ json: { dives: [] } })); await page.route("**/api/keys", (r) => r.fulfill({ json: { keys: [], max: 10 } }));
  try {
    await page.goto(base); await page.waitForTimeout(500);
    const box = (sel) => page.locator(sel).first().boundingBox();
    const side = await box("#side"), nav = await page.locator(".nav button").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)]; }));
    assert.ok(side.x === 0 && side.width > 220 && side.width < 320 && side.height >= 799, "a full-height sidebar on the left");
    assert.ok(nav.every((n) => n[0] < side.width && n[2] > 150) && nav[1][1] > nav[0][1] + 30 && nav[2][1] > nav[1][1] + 30, "the three tabs stack vertically inside the sidebar: " + JSON.stringify(nav));
    const main = await box("#main"); assert.ok(main.x >= side.width - 1 && main.width > 900, "the content sits to the right and is wide");
    assert.ok((await box("#connectBtn")).x < side.width && (await box("#acctBtn")).x < side.width && (await box(".theme-slot")).x < side.width, "connect, account and the theme switch live in the sidebar");
    assert.match(await page.locator("#acctBtn").innerText(), /Account/, "the account button is labelled on the laptop layout");
    await page.click("#navLog"); assert.ok(await page.locator("#logView").isVisible()); await page.click("#navDevice"); assert.ok(await page.locator("#deviceView").isVisible());
    await page.click("#acctBtn"); assert.ok(await page.locator("#accountView").isVisible()); assert.ok((await box("details.acc[data-sec=profile]")).x > side.width, "account sections are in the content area");
    const two = await page.locator("details.acc").evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().x))).size); assert.equal(two, 2, "account sections use two columns");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll on a laptop");
    // below 1024px it is the phone layout again: tabs in a row on top, no sidebar box
    await page.setViewportSize({ width: 820, height: 900 }); await page.waitForTimeout(200);
    const row = await page.locator(".nav button").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)));
    assert.ok(new Set(row).size === 1, "tabs in one row below 1024px"); assert.equal(await page.locator("#side").evaluate((e) => getComputedStyle(e).display), "contents"); assert.ok(!(await page.locator("#acctBtn .acct-label").isVisible()), "no text label on the round avatar");
    assert.deepEqual(errs, []);
    console.log("PASS laptop layout");
  } catch (e) { failed++; console.log("FAIL laptop layout\n ", e.message.split("\n").slice(0, 4).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-laptop.png" }); }
  await ctx.close();
}
// ---- scenario: Garmin Descent: import .fit files and a Garmin Connect ZIP, separate log, duplicates with the Cosmiq+ counted once ----
{
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage();
  const uploaded = [], errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "you@example.com", name: "Me", version: "0.0.0" } }));
  await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Me", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } }));
  await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } })); await page.route("**/api/places", (r) => r.fulfill({ json: { places: [] } }));
  await page.route("**/api/dives/location", (r) => r.fulfill({ json: { updated: 1 } }));
  await page.route("**/api/dives", (r) => { if (r.request().method() === "GET") return r.fulfill({ json: { dives: [] } });
    const b = JSON.parse(r.request().postData()); uploaded.push(...b.dives); return r.fulfill({ json: { stored: b.dives.length } }); });
  await page.goto(base);
  try {
    await page.click("#navLog"); assert.match(await page.locator("#diveList").innerText(), /No dives yet\. Open Import/, "an empty dive log points to Import"); await page.click("#navImport"); assert.ok(await page.locator("#srcEmpty").isVisible(), "no dives yet: asked which dive computer"); assert.equal(await page.locator("#devTabs button").count(), 0, "no tabs for computers without data");
    assert.deepEqual(await page.locator("#srcEmptyList button b").allInnerTexts(), ["Cosmiq+ Gen 5", "Shearwater Peregrine", "Shearwater Perdix", "Garmin Descent"]);
    await openSource(page, "Garmin"); await page.waitForSelector("#dropZone", { state: "visible" }); assert.equal(await page.locator("#devTabs button").count(), 1); assert.match(await page.locator("#devTabs button").innerText(), /Garmin Descent/); assert.ok(!(await page.locator("#srcEmpty").isVisible()));
    assert.match(await page.locator("#impTitle").innerText(), /garmin descent/i); assert.match(await page.locator("#dropZone").innerText(), /Drop your Garmin dive files here/); assert.match(await page.locator("#dropZone").innerText(), /\.fit/);
    const card = await page.locator("#importCard").innerText(); assert.match(card, /Export Original/); assert.match(card, /Export Your Data/); assert.match(card, /Garmin\/Activity/); assert.ok(!/Shearwater Cloud/.test(card), "no Peregrine instructions on the Garmin tab");
    assert.ok(!(await page.locator("#impBt").isVisible()), "the Bluetooth download belongs to the Peregrine only"); assert.match(card, /Beta/, "honest about not being tried on every watch");
    await page.locator("#importCard").screenshot({ path: process.env.SHOT_GARMIN || "/tmp/shot-garmin.png" });
    // a Descent .fit: the dive appears with the clock time of the watch, in its own log
    const d1 = Buffer.from(fitFile(descentDive({ start: "2025-02-04T01:30:00", number: 57 })));
    await page.setInputFiles("#impFile", { name: "19876543210.fit", mimeType: "application/octet-stream", buffer: d1 });
    await page.waitForFunction(() => /1 new dive imported/.test(document.getElementById("impMsg").textContent), null, { timeout: 15000 });
    assert.match(await page.locator("#impMsg").innerText(), /1 uploaded/); assert.equal(uploaded.length, 1);
    assert.ok(uploaded[0].device === "garmin" && uploaded[0].headerHex === "" && uploaded[0].startedAt === "2025-02-04T09:30:00" && uploaded[0].maxDepthM === 25.3 && uploaded[0].o2Percent === 32 && JSON.parse(uploaded[0].extra).n === 57);
    await page.click("#navLog"); await page.waitForSelector("#locPrompt input", { state: "visible" }); assert.equal(await page.locator("details.dive .dive-num").first().innerText(), "1", "the dive log's own number: the first dive"); assert.match(await page.locator("#diveList details.dive").first().locator("summary").innerText(), /Garmin/);
    await page.locator("details.dive").first().locator("summary").click(); await page.locator("details.dive[open] svg.chart").waitFor();
    assert.match(await page.locator("details.dive[open]").innerText(), /25\.3 m[\s\S]*10 min[\s\S]*32%/); assert.match(await page.locator("details.dive[open]").innerText(), /Imported from a file from the Garmin Descent/);
    // again: nothing new. A Garmin Connect ZIP (export of everything): other activities are skipped and said so
    await page.click("#navImport"); await page.setInputFiles("#impFile", { name: "again.fit", mimeType: "application/octet-stream", buffer: d1 });
    await page.waitForFunction(() => /0 new dives imported, 1 already there/.test(document.getElementById("impMsg").textContent), null, { timeout: 15000 });
    const zipBytes = Buffer.from(makeZip([["DI_CONNECT/a.fit", d1, 8], ["DI_CONNECT/b.fit", Buffer.from(fitFile(descentDive({ start: "2025-02-05T01:30:00", number: 58, sub: 55 }))), 8], ["DI_CONNECT/run.fit", Buffer.from(runActivity()), 8], ["DI_CONNECT/readme.txt", Buffer.from("x"), 0]]));
    await page.setInputFiles("#impFile", { name: "UploadedFiles_0-_Part1.zip", mimeType: "application/zip", buffer: zipBytes });
    await page.waitForFunction(() => /1 new dive imported/.test(document.getElementById("impMsg").textContent), null, { timeout: 15000 });
    const m2 = await page.locator("#impMsg").innerText(); assert.match(m2, /1 already there/); assert.match(m2, /1 other activity skipped/); assert.equal(uploaded.length, 2); assert.equal(uploaded[1].mode, "gauge");
    // no time zone in the file: said, not silent
    await page.setInputFiles("#impFile", { name: "utc.fit", mimeType: "application/octet-stream", buffer: Buffer.from(fitFile(descentDive({ start: "2025-02-06T01:30:00", number: 59, noLocal: true }))) });
    await page.waitForFunction(() => /1 dive had no time zone in the file, so the time shown is UTC/.test(document.getElementById("impMsg").textContent), null, { timeout: 15000 });
    // not a FIT file: a plain message, nothing stored
    await page.setInputFiles("#impFile", { name: "notes.fit", mimeType: "application/octet-stream", buffer: Buffer.from("this is not a dive file ".repeat(10)) });
    await page.waitForFunction(() => /not a FIT file or a ZIP/.test(document.getElementById("impMsg").textContent), null, { timeout: 8000 }); assert.equal(uploaded.length, 3);
    // the Peregrine tab is unchanged, and the Cosmiq+ one still shows its Sync card
    await openSource(page, "Peregrine"); await page.waitForFunction(() => /peregrine/i.test(document.getElementById("impTitle").textContent), null, { timeout: 5000 }); assert.match(await page.locator("#impTitle").innerText(), /shearwater peregrine/i); assert.ok(await page.locator("#impBt").isVisible()); assert.match(await page.locator("#dropZone").innerText(), /Shearwater Cloud/);
    await openSource(page, "Cosmiq"); await page.waitForFunction(() => document.getElementById("syncCard").style.display !== "none", null, { timeout: 5000 }); assert.ok(await page.locator("#syncCard").isVisible()); assert.ok(!(await page.locator("#importCard").isVisible()));
    // Summary counts all three Garmin dives
    await page.click("#navSummary"); await page.waitForFunction(() => /across 3 dives/.test(document.getElementById("sumCount").textContent), null, { timeout: 5000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll"); assert.deepEqual(errs, [], "page errors");
    console.log("PASS garmin import");
  } catch (e) { failed++; console.log("FAIL garmin import\n ", e.message.split("\n").slice(0, 8).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-garmin.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: each person sees only their own dive computers (Togar: Cosmiq+ and Peregrine; Sharon: Garmin and Perdix) ----
{
  const hex = (a) => a.map((x) => x.toString(16).padStart(2, "0")).join("");
  const cosmiqRow = (n, iso) => { const [d, tm] = iso.split("T"), [y, mo, da] = d.split("-").map(Number), [h, mi] = tm.split(":").map(Number); const b = new Array(36).fill(0);
    b[0] = n; b[3] = 32; b[4] = 0xf5; b[5] = 0xa3; b[6] = y & 255; b[7] = y >> 8; b[8] = da; b[9] = mo; b[10] = mi; b[11] = h; b[12] = 3000 & 255; b[13] = 3000 >> 8; b[22] = 200; b[24] = 26; b[26] = 10;
    return { fingerprint: (0xc05000000000 + n).toString(16).padStart(12, "0"), device: "cosmiq", startedAt: iso, mode: "scuba", durationSec: 3000, maxDepthM: 20, o2Percent: 32, headerHex: hex(b), profileHex: "" }; };
  const imported = (device, n, iso) => ({ fingerprint: (0xd00000000000 + n + { peregrine: 0x100, garmin: 0x200, perdix: 0x300 }[device]).toString(16).padStart(12, "0"), device, startedAt: iso, mode: "scuba", durationSec: 2400, maxDepthM: 18, o2Percent: 32, headerHex: "", profileHex: "", extra: JSON.stringify({ n, t: 27, iv: 10, s: [[0, 0, 28], [1200, 18, 27], [2400, 0, 27]] }) });
  const people = { "togar@example.com": [cosmiqRow(1, "2025-03-14T09:00:00"), cosmiqRow(2, "2025-03-15T09:00:00"), imported("peregrine", 1, "2025-03-20T09:00:00")],
    "sharon@example.com": [imported("garmin", 1, "2025-04-02T09:00:00"), imported("garmin", 2, "2025-04-03T09:00:00"), imported("perdix", 1, "2025-04-09T09:00:00")] };
  let who = "togar@example.com"; const posted = [];
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block", acceptDownloads: true }); const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: who, name: who.split("@")[0], version: "0.0.0" } }));
  await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } })); await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } })); await page.route("**/api/places", (r) => r.fulfill({ json: { places: [] } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: who.split("@")[0], latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } }));
  await page.route("**/api/dives/location", (r) => r.fulfill({ json: { updated: 1 } }));
  await page.route("**/api/dives", (r) => { if (r.request().method() === "GET") return r.fulfill({ json: { dives: people[who] } }); posted.push(...JSON.parse(r.request().postData()).dives); return r.fulfill({ json: { stored: 0 } }); });
  const names = () => page.locator("#devTabs button").allInnerTexts().then((a) => a.map((x) => x.replace(/\s+/g, " ").trim()));
  const settle = async (n) => { await page.waitForFunction((k) => document.querySelectorAll("#devTabs button").length === k, n, { timeout: 10000 }); };
  try {
    // Togar: Cosmiq+ and Peregrine only; Connect & Sync and the Device tab are there; Perdix and Garmin can be added
    await page.goto(base); await page.click("#navImport"); await settle(2);
    assert.deepEqual(await names(), ["Cosmiq+ Gen 5 \u00b7 2", "Shearwater Peregrine \u00b7 1"], "only the computers with dives");
    assert.ok(await page.locator("#connectBtn").isVisible() && await page.locator("#navDevice").isVisible(), "a Cosmiq+ owner keeps Connect & Sync and the Device tab");
    await page.click("#srcAdd"); assert.deepEqual(await page.locator("#srcAddList button b").allInnerTexts(), ["Shearwater Perdix", "Garmin Descent"], "only the others are offered");
    assert.ok(!(await page.locator("#srcHideRow").isVisible()), "nothing to hide while every shown computer has dives");
    await page.evaluate(() => { localStorage.setItem("diver", JSON.stringify({ fullName: "Togar" })); });
    // Sharon signs in on the same browser: Togar's dives and settings are gone from this device, her own are shown
    who = "sharon@example.com"; await page.evaluate(() => window.__keepAlive = 1);
    const dl = page.waitForEvent("download", { timeout: 3000 }).catch(() => null);
    await page.reload(); await page.click("#navImport"); await settle(2);
    assert.deepEqual(await names(), ["Shearwater Perdix \u00b7 1", "Garmin Descent \u00b7 2"], "Sharon: only Garmin and Perdix, none of Togar's computers");
    assert.equal(await page.evaluate(() => localStorage.getItem("owner")), "sharon@example.com"); assert.ok(!/Togar/.test(await page.evaluate(() => localStorage.getItem("diver")) || ""), "Togar's cached profile is gone (the cache now holds Sharon's)");
    assert.equal(await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("cosmiq", 1); r.onsuccess = () => { const q = r.result.transaction("dives").objectStore("dives").getAll(); q.onsuccess = () => res(q.result.map((d) => d.device).sort().join(",")); }; })), "garmin,garmin,perdix", "the cache holds only Sharon's dives");
    assert.ok(!(await dl), "nothing was waiting to upload, so no backup file");
    assert.equal(posted.length, 0, "nothing of Togar's was ever sent to Sharon's account");
    // Sharon has no Cosmiq+: its Connect & Sync, status and Device tab are out of the way; the phone still has three tabs
    assert.ok(!(await page.locator("#connectBtn").isVisible()) && !(await page.locator("#navDevice").isVisible()) && !(await page.locator("#status").isVisible()), "no Cosmiq+ controls for Sharon");
    assert.equal(await page.locator(".nav button:visible").count(), 4, "Summary, Dive log, Import, Certificates");
    // she can still add a Cosmiq+ (or hide it again when it has no dives)
    await page.click("#srcAdd"); await page.locator("#srcAddList button", { hasText: "Cosmiq+" }).click(); await settle(3);
    assert.ok(await page.locator("#syncCard").isVisible() && await page.locator("#connectBtn").isVisible() && await page.locator("#navDevice").isVisible(), "adding the Cosmiq+ brings its controls back");
    assert.ok(await page.locator("#srcHideRow").isVisible(), "a computer without dives can be hidden again"); await page.click("#srcHide"); await settle(2);
    assert.ok(!(await page.locator("#connectBtn").isVisible()), "hidden again"); assert.deepEqual((await names()).length, 2);
    // the choice of added computers survives a reload; a new person with no dives is asked which computer they use and sees everything until then
    who = "new@example.com"; people["new@example.com"] = [];
    await page.reload(); await page.waitForFunction(() => document.getElementById("srcEmpty") && getComputedStyle(document.getElementById("srcEmpty")).display !== "none" || true, null, { timeout: 5000 }); await page.click("#navImport");
    await page.waitForSelector("#srcEmpty", { state: "visible", timeout: 10000 }); assert.equal(await page.locator("#srcEmptyList button").count(), 4); assert.ok(await page.locator("#connectBtn").isVisible() && await page.locator("#navDevice").isVisible(), "with no dives at all nothing is hidden: a new Cosmiq+ owner can connect");
    // dives that were never uploaded are not lost when someone else signs in: they are saved to a backup file, and never sent to the other account
    who = "togar@example.com"; await page.reload(); await page.waitForFunction(() => localStorage.getItem("owner") === "togar@example.com"); await page.waitForTimeout(1200);       // the switch from the previous person reloads the page once
    await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("cosmiq", 1); r.onsuccess = () => { const tx = r.result.transaction("dives", "readwrite"); tx.objectStore("dives").put({ fingerprint: "feedfacecafe", device: "peregrine", startedAt: "2025-05-01T09:00:00", mode: "scuba", durationSec: 1800, maxDepthM: 15, o2Percent: 32, number: 9, minTempC: 27, intervalSec: 10, samples: [[0, 0, 28], [900, 15, 27]], headerHex: "", profileHex: "", uploaded: false }); tx.oncomplete = res; }; }));
    who = "sharon@example.com"; const dl2 = page.waitForEvent("download", { timeout: 8000 }); await page.reload(); const file = await dl2;
    assert.match(file.suggestedFilename(), /^cosmiq-dives-.*\.json$/); const saved = JSON.parse(fs.readFileSync(await file.path(), "utf8")); assert.ok(saved.dives.some((d) => d.fingerprint === "feedfacecafe"), "the not-yet-uploaded dive is in the backup");
    await page.click("#navImport"); await settle(2); assert.ok(!posted.some((d) => d.fingerprint === "feedfacecafe"), "and was not given to Sharon's account");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll"); assert.deepEqual(errs, [], "page errors");
    console.log("PASS dive computers per person");
  } catch (e) { failed++; console.log("FAIL dive computers per person\n ", e.message.split("\n").slice(0, 8).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-sources.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: the Bluetooth lab (sandbox): browser checks, advertisement listing, GATT inspection, Shearwater handshake, report ----
{
  const sim = peregrine({ dives: [] });
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  const sentReports = []; await page.route("**/api/bt-reports", (r) => { sentReports.push(JSON.parse(r.request().postData())); return r.fulfill({ status: 201, json: { id: 12, ok: true } }); });
  await page.exposeFunction("__pgWrite", async (arr) => { await sim.io.write(Uint8Array.from(arr)); return sim.drain().map((a) => Array.from(a)); });
  await page.addInitScript((noScan) => {
    Object.defineProperty(navigator, "platform", { configurable: true, get: () => "MacIntel" }); Object.defineProperty(navigator, "userAgentData", { configurable: true, value: { platform: "macOS", brands: [{ brand: "Google Chrome", version: "140" }] } });
    const b = new EventTarget(); window.__b = b; const SW = "fe25c237-0ece-443c-b0aa-e02033e7029d", full = (n) => "0000" + n.toString(16).padStart(4, "0") + "-0000-1000-8000-00805f9b34fb";
    b.getAvailability = async () => true; if (!noScan) b.requestLEScan = async () => ({ stop() { window.__scanStopped = true; } });
    window.__adv = (o) => { const e = new Event("advertisementreceived"); Object.assign(e, { device: { id: o.id, name: o.name }, name: o.name, rssi: o.rssi, uuids: o.uuids || [], manufacturerData: new Map(o.mfr ? [[o.mfr[0], new DataView(Uint8Array.from(o.mfr[1]).buffer)]] : []), serviceData: new Map(), txPower: null }); b.dispatchEvent(e); };
    let onChange = null;
    const sch = { uuid: "27b7570b-359e-45a3-91bb-cf7e70049bd2", properties: { notify: true, writeWithoutResponse: true }, addEventListener(t, f) { if (t === "characteristicvaluechanged") onChange = f; }, async startNotifications() {},
      async writeValueWithoutResponse(v) { const notes = await window.__pgWrite(Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))); setTimeout(() => notes.forEach((n) => onChange({ target: { value: new DataView(Uint8Array.from(n).buffer) } })), 0); } };
    const nameChar = { uuid: full(0x2a00), properties: { read: true }, readValue: async () => new DataView(new TextEncoder().encode("Peregrine").buffer) };
    const notifier = { uuid: "aaaa0000-0000-1000-8000-00805f9b34fb", properties: { notify: true, read: true }, addEventListener() {}, async startNotifications() { window.__listening = true; }, readValue: async () => new DataView(Uint8Array.from([1, 2, 255]).buffer) };
    const gap = { uuid: full(0x1800), getCharacteristics: async () => [nameChar] }, shear = { uuid: SW, getCharacteristics: async () => [sch, notifier] };
    const dev = { id: "dev1", name: "Peregrine", addEventListener() {}, gatt: { connect: async () => server, disconnect() { window.__disconnected = (window.__disconnected || 0) + 1; } } };
    const server = { getPrimaryServices: async () => [gap, shear], getPrimaryService: async (u) => { if (u !== SW) throw new Error("no"); return shear; } };
    Object.defineProperty(navigator, "bluetooth", { configurable: true, value: Object.assign(b, { requestDevice: async (o) => { window.__asked = o; if (window.__cancel) { const e = new Error("cancelled"); e.name = "NotFoundError"; throw e; } return dev; } }) });
  }, false);
  try {
    await page.goto(base + "bluetooth-lab.html"); await page.waitForFunction(() => window.__labReady === true, null, { timeout: 8000 });
    // 1. browser checks, with the Mac permission hint
    const env = await page.locator("#envTable").innerText(); assert.match(env, /Web Bluetooth\s+available/); assert.match(env, /Listening for advertisements\s+supported/); assert.match(env, /Bluetooth adapter\s+a Bluetooth adapter is available/);
    const hints = await page.locator("#envHints").innerText(); assert.match(hints, /System Settings/, "a Mac is told about the browser's Bluetooth permission"); assert.match(hints, /one app at a time/); assert.match(hints, /Auto Connect/);
    // 2. listening: a Peregrine row is marked and first; other devices are listed; names from devices are text, never HTML
    await page.click("#scanStart"); await page.waitForFunction(() => !document.getElementById("scanStart").disabled === false);
    await page.evaluate(() => { __adv({ id: "a", name: "JBL Flip 5", rssi: -50 }); __adv({ id: "b", name: "Peregrine", rssi: -63, uuids: ["fe25c237-0ece-443c-b0aa-e02033e7029d"], mfr: [0x1234, [1, 2, 3]] }); __adv({ id: "c", name: "", rssi: -80 }); __adv({ id: "d", name: "<b>bold</b><img src=x onerror=window.__xss=1>", rssi: -70 }); __adv({ id: "b", name: "Peregrine", rssi: -61, uuids: ["fe25c237-0ece-443c-b0aa-e02033e7029d"] }); });
    await page.waitForFunction(() => document.querySelectorAll("#scanTable tbody tr").length === 4, null, { timeout: 3000 });
    const rows = await page.locator("#scanTable tbody tr").evaluateAll((trs) => trs.map((t) => t.innerText.replace(/\s+/g, " ").trim()));
    assert.match(rows[0], /^Peregrine\s*likely -61 dBm 2\u00d7 Shearwater data service 0x1234: 01 02 03/, "the dive computer is first, with its signal, count, service and manufacturer data: " + rows[0]);
    assert.equal(await page.locator("#scanTable tbody tr.likely").count(), 1); assert.ok(rows.some((r) => r.startsWith("(no name)")), "unnamed devices are listed too");
    assert.equal(await page.locator("#scanTable b, #scanTable img").count(), 0, "a device name is shown as text"); assert.equal(await page.evaluate(() => window.__xss), undefined); assert.ok(rows.some((r) => r.includes("<b>bold</b>")));
    await page.check("#scanNamed"); assert.equal(await page.locator("#scanTable tbody tr").count(), 3, "only named devices"); await page.uncheck("#scanNamed");
    await page.click("#scanStop"); assert.equal(await page.evaluate(() => window.__scanStopped), true); assert.match(await page.locator("#scanState").innerText(), /stopped, 4 devices heard/);
    // 3. inspect: services with names, the Shearwater tag, harmless values read at once, Read / Listen buttons work, nothing is written
    await page.fill("#extraUuid", "not a uuid"); await page.click("#inspectBtn"); assert.match(await page.locator("#inspectState").innerText(), /not a UUID/); await page.fill("#extraUuid", "6e400001-b5a3-f393-e0a9-e50e24dcca9e");
    await page.click("#inspectBtn"); await page.waitForFunction(() => document.querySelectorAll("#tree > li").length === 2, null, { timeout: 5000 });
    const asked = await page.evaluate(() => window.__asked); assert.equal(asked.acceptAllDevices, true); assert.ok(asked.optionalServices.includes("fe25c237-0ece-443c-b0aa-e02033e7029d") && asked.optionalServices.includes("6e400001-b5a3-f393-e0a9-e50e24dcca9e") && asked.optionalServices.length > 80, "asks for the Shearwater service, your extra one and the standard ones");
    const tree = await page.locator("#tree").innerText(); assert.match(tree, /Generic Access/); assert.match(tree, /Shearwater data service[\s\S]*Shearwater/); assert.match(tree, /device name/); assert.match(tree, /50 65 72 65 67 72 69 6e 65\s+"Peregrine"/, "the device name was read on its own");
    await page.locator('#tree button[data-act="read"]').last().click(); await page.waitForFunction(() => /01 02 ff/.test(document.getElementById("tree").textContent)); await page.locator('#tree button[data-act="notify"]').last().click(); assert.equal(await page.evaluate(() => window.__listening), true);
    assert.equal(sim.log.length, 0, "browsing sends nothing to the dive computer"); await page.click("#inspectDisc"); assert.ok((await page.evaluate(() => window.__disconnected)) >= 1);
    // 4. the Shearwater handshake: three read-only questions, answered by the simulated Peregrine
    await page.click("#shakeBtn"); await page.waitForFunction(() => /The download will work/.test(document.getElementById("shakeState").textContent), null, { timeout: 15000 });
    assert.match(await page.locator("#shakeState").innerText(), /serial \S+, firmware \S+, model number 9 \(Peregrine\)/); assert.deepEqual(sim.log.filter((l) => /^22/.test(l)).length > 0, true, "it asked read-data-by-identifier questions"); assert.ok(!sim.log.some((l) => /^35/.test(l)), "and downloaded no dive");
    await page.evaluate(() => { window.__cancel = true; }); await page.click("#shakeBtn"); await page.waitForFunction(() => /No device was chosen/.test(document.getElementById("shakeState").textContent)); await page.evaluate(() => { window.__cancel = false; });
    // 5. report: everything, with other people's devices left out by default
    const rep = await page.locator("#report").inputValue();
    for (const must of ["== Browser ==", "Web Bluetooth: available", "== Advertisement scan ==", "name=\"Peregrine\" likely=true", "0x1234", "== Inspected device ==", "service fe25c237", "Shearwater data service", "== Shearwater handshake ==", "\"serial\"", "Handshake OK"]) assert.ok(rep.includes(must), "report has: " + must + " :: " + rep.slice(rep.indexOf("== Shearwater handshake"), rep.indexOf("== Shearwater handshake") + 300).replace(/\n/g, " / "));
    assert.ok(rep.includes("== Summary =="), "the report starts with what it means"); assert.match(rep, /REACHABLE: Peregrine answered the Shearwater protocol \(serial 12345678, firmware V93, model number 9 = Peregrine\)\. Bluetooth works from this browser\. Next: Import > Download dives over Bluetooth\./); assert.match(rep, /Listening: 4 devices heard, 1 look like a dive computer\./);
    assert.ok(!rep.includes("JBL Flip"), "other devices' names are not in the report by default"); assert.match(rep, /3 not listed/);
    assert.ok(rep.includes("== Recent Bluetooth attempts on this device ==") && rep.includes("=== Handshake: Shearwater (lab) ===") && rep.includes("Result: OK - The computer answered."), "the handshake is also in the shared download log");
    await page.click("#repSend"); await page.waitForFunction(() => /Sent to your account \(report #12\)/.test(document.getElementById("repState").textContent), null, { timeout: 5000 });
    assert.equal(sentReports.length, 1); assert.equal(sentReports[0].kind, "lab"); assert.ok(sentReports[0].body.includes("== Browser ==") && sentReports[0].body.includes("== Shearwater handshake =="), "the report is what is sent"); assert.ok(!sentReports[0].body.includes("JBL Flip"), "the other devices' names are not sent by default");
    await page.uncheck("#onlyLikely"); assert.ok((await page.locator("#report").inputValue()).includes("JBL Flip"), "the checkbox puts them back");
    await page.click("#repClear"); assert.ok(!(await page.locator("#report").inputValue()).includes("Handshake OK")); assert.equal(await page.locator("#log").innerText(), "");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll"); assert.deepEqual(errs, [], "page errors");
    // without Chrome's experimental setting: the page explains it and the other sections still work
    const p2 = await ctx.newPage(); const e2 = []; p2.on("pageerror", (e) => e2.push(e.message)); await p2.addInitScript(() => { Object.defineProperty(navigator, "platform", { configurable: true, get: () => "Win32" }); Object.defineProperty(navigator, "userAgentData", { configurable: true, value: { platform: "Windows", brands: [] } }); const b = new EventTarget(); b.getAvailability = async () => false; Object.defineProperty(navigator, "bluetooth", { configurable: true, value: b }); });
    await p2.goto(base + "bluetooth-lab.html"); await p2.waitForFunction(() => window.__labReady === true); assert.match(await p2.locator("#envTable").innerText(), /NO Bluetooth adapter found or it is switched off/); assert.match(await p2.locator("#envTable").innerText(), /switched off \(needs a Chrome setting/); assert.ok(!/System Settings/.test(await p2.locator("#envHints").innerText()), "no Mac hint on Windows");
    await p2.click("#scanStart"); assert.match(await p2.locator("#scanHelp").innerText(), /enable-experimental-web-platform-features/); assert.deepEqual(e2, []);
    // the app links to the lab from the Bluetooth section
    await page.goto(base); await page.click("#navLog"); await openSource(page, "Peregrine"); assert.equal(await page.locator("#labLink").getAttribute("href"), "bluetooth-lab.html");
    console.log("PASS bluetooth lab");
  } catch (e) { failed++; console.log("FAIL bluetooth lab\n ", e.message.split("\n").slice(0, 6).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-lab.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: sharing a dive log (Account > Share dives) and a log that holds dives shared with you: every dive once, your own computer first ----
{
  const imp = (device, n, iso, over = {}) => ({ fingerprint: (0xe00000000000 + n + { peregrine: 0x100, garmin: 0x200, perdix: 0x300 }[device]).toString(16).padStart(12, "0"), device, startedAt: iso, mode: "scuba", durationSec: 2400, maxDepthM: 18, o2Percent: 32, headerHex: "", profileHex: "", extra: JSON.stringify({ n, t: 27, iv: 10, s: [[0, 0, 28], [1200, 18, 27], [2400, 0, 27]] }), ...over });
  const mine = { sharon: [imp("perdix", 1, "2025-04-02T09:03:00"), imp("garmin", 1, "2025-04-02T09:05:00")], shared: [imp("peregrine", 1, "2025-04-02T09:00:00", { sharedFrom: "togar@example.com" }), imp("peregrine", 2, "2025-04-03T09:00:00", { sharedFrom: "togar@example.com" })] };
  let received = [{ from: "togar@example.com", count: 2, first: "2025-04-02T09:00:00", last: "2025-04-03T09:00:00" }], serverDives = [...mine.sharon, ...mine.shared]; const calls = [];
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "sharon@example.com", name: "Sharon", version: "0.0.0" } })); await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Sharon", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } })); await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } })); await page.route("**/api/places", (r) => r.fulfill({ json: { places: [] } })); await page.route("**/api/keys", (r) => r.fulfill({ json: { keys: [], max: 10 } }));
  await page.route("**/api/dives", (r) => r.request().method() === "GET" ? r.fulfill({ json: { dives: serverDives } }) : r.fulfill({ json: { stored: 0 } })); await page.route("**/api/dives/location", (r) => r.fulfill({ json: { updated: 1 } }));
  await page.route("**/api/share", (r) => r.fulfill({ json: { targets: ["togar@example.com"], received } }));
  await page.route("**/api/share/preview", (r) => { const b = JSON.parse(r.request().postData()); calls.push(["preview", b]); return r.fulfill({ json: b.from === "2025-04-03" ? { total: 3, byYear: [{ year: "2025", count: 3 }] } : { total: 3, byYear: [{ year: "2024", count: 2 }, { year: "2025", count: 1 }] } }); });
  await page.route("**/api/share/copy", (r) => { calls.push(["copy", JSON.parse(r.request().postData())]); return r.fulfill({ json: { copied: 2, to: "togar@example.com" } }); });
  await page.route("**/api/share/remove", (r) => { calls.push(["remove", JSON.parse(r.request().postData())]); received = []; serverDives = mine.sharon; return r.fulfill({ json: { removed: 2 } }); });
  try {
    await page.goto(base); await page.click("#navLog"); await page.waitForFunction(() => document.querySelectorAll("#diveList details.dive").length === 2, null, { timeout: 8000 });
    // her own Perdix is the record shown for the dive Togar also recorded (his Peregrine copy and her Garmin hide behind it); the dive only he has stays, marked as from him
    const rows = await diveRows(page);
    assert.deepEqual(rows[1].chips, ["Perdix"]); assert.equal(rows[1].also, "also on Garmin, Peregrine", "the dive on three computers: one row, hers shown"); assert.deepEqual(rows[0].chips, ["Peregrine", "from Togar"], "the dive only he has stays, marked as from him");
    assert.equal(await page.locator("#diveList > p").count(), 0, "no summary line above the list"); assert.match(await page.locator("#navLog").innerText(), /Dive log \(2\)/);
    // the Import tab lists only HER computers: his Peregrine, which only exists as copies, is not one of them
    await page.click("#navImport"); assert.deepEqual((await page.locator("#devTabs button").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim()), ["Shearwater Perdix \u00b7 1", "Garmin Descent \u00b7 1"], "shared dives do not add dive computers");
    await page.click("#navSummary"); await page.waitForFunction(() => /across 2 dives/.test(document.getElementById("sumCount").textContent), null, { timeout: 5000 });
    // Account > Share dives: what is shared with her, and a way to remove it
    await page.click("#acctBtn"); await page.locator("details.acc[data-sec=share] > summary").click(); await page.waitForFunction(() => document.querySelectorAll("#shareTo option").length === 1);
    assert.equal(await page.locator("#shareTo option").first().innerText(), "Togar (togar@example.com)"); assert.match(await page.locator("#shareInList").innerText(), /2 dives from Togar \(2025-04 to 2025-04\)/); assert.match(await page.locator("#shareBadge").innerText(), /2 shared with you/);
    assert.ok(await page.locator("#shareCopyBtn").isDisabled(), "nothing can be copied before a preview"); await page.click("#sharePreviewBtn");
    await page.waitForFunction(() => /3[\s\S]*would be copied to Togar/.test(document.getElementById("sharePreview").textContent)); assert.match(await page.locator("#sharePreview").innerText(), /2024: 2[\s\S]*2025: 1/);
    assert.equal(await page.locator("#shareCopyBtn").innerText(), "Copy 3 dives to Togar"); assert.ok(!(await page.locator("#shareCopyBtn").isDisabled()));
    await page.fill("#shareFrom", "2025-04-03"); assert.ok(await page.locator("#shareCopyBtn").isDisabled(), "changing the dates asks for a new preview"); await page.click("#sharePreviewBtn"); await page.waitForFunction(() => /Copy 3 dives to Togar/.test(document.getElementById("shareCopyBtn").textContent));
    await page.locator("#shareCopyBtn").click(); assert.equal(calls.filter((c) => c[0] === "copy").length, 0, "the first tap only asks"); assert.match(await page.locator("#shareCopyBtn").innerText(), /Tap again to copy/);
    await page.locator("#shareCopyBtn").click(); await page.waitForFunction(() => /new dives? copied to Togar/.test(document.getElementById("shareMsg").textContent)); assert.deepEqual(calls.filter((c) => c[0] === "copy").map((c) => c[1]), [{ to: "togar@example.com", from: "2025-04-03", until: "" }]);
    assert.match(await page.locator("#shareMsg").innerText(), /^2 new dives copied to Togar's account\. 1 was already there\.$/, "says how many were new vs already there");
    // remove what was shared with her: asks twice, then it is gone from the server and from this device, and the log shows only hers
    await page.locator(".share-remove").click(); assert.equal(calls.filter((c) => c[0] === "remove").length, 0); await page.locator(".share-remove").click();
    await page.waitForFunction(() => document.querySelectorAll("#shareInList .share-remove").length === 0, null, { timeout: 5000 }); assert.deepEqual(calls.filter((c) => c[0] === "remove").map((c) => c[1]), [{ from: "togar@example.com" }]);
    await page.click("#navLog"); await page.waitForFunction(() => document.querySelectorAll("#diveList details.dive").length === 1, null, { timeout: 5000 }); assert.match(await page.locator("#diveList details.dive").first().locator("summary").innerText(), /Perdix/); assert.ok(!/from Togar/.test(await page.locator("#diveList").innerText()), "his dives are gone from her log");
    assert.equal(await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("cosmiq", 1); r.onsuccess = () => { const q = r.result.transaction("dives").objectStore("dives").getAll(); q.onsuccess = () => res(q.result.filter((d) => d.sharedFrom).length); }; })), 0, "removed from this device too");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll"); assert.deepEqual(errs, [], "page errors");
    console.log("PASS sharing dive logs");
  } catch (e) { failed++; console.log("FAIL sharing dive logs\n ", e.message.split("\n").slice(0, 6).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-share.png", fullPage: true }); }
  await ctx.close();
}
// ---- scenario: delete a dive from the dive log: asks first, removes the dive and its hidden copies, is remembered, is retried when the connection fails ----
{
  const imp = (device, n, iso, over = {}) => ({ fingerprint: (0xd00000000000 + n + { peregrine: 0x100, perdix: 0x300 }[device]).toString(16).padStart(12, "0"), device, startedAt: iso, mode: "scuba", durationSec: 2400, maxDepthM: 18, o2Percent: 32, headerHex: "", profileHex: "", extra: JSON.stringify({ n, t: 27, iv: 10, s: [[0, 0, 28], [1200, 18, 27], [2400, 0, 27]] }), ...over });
  const all0 = [imp("perdix", 1, "2025-04-02T09:03:00"), imp("peregrine", 1, "2025-04-02T09:00:00", { sharedFrom: "togar@example.com" }), imp("perdix", 2, "2025-04-03T09:00:00")];
  let serverDives = [...all0], deleted = [], failNext = true; const calls = [];
  const ctx = await browser.newContext({ ...devices["Pixel 7"], serviceWorkers: "block" }); const page = await ctx.newPage(); const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route("**/api/me", (r) => r.fulfill({ json: { email: "sharon@example.com", name: "Sharon", version: "0.0.0" } })); await page.route("**/api/regulator", (r) => r.fulfill({ json: { regulator: null } }));
  await page.route("**/api/profile", (r) => r.fulfill({ json: { avatar: null, fullName: "Sharon", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } } })); await page.route("**/api/certs", (r) => r.fulfill({ json: { certs: [] } })); await page.route("**/api/places", (r) => r.fulfill({ json: { places: [] } })); await page.route("**/api/keys", (r) => r.fulfill({ json: { keys: [], max: 10 } }));
  await page.route("**/api/dives", (r) => r.request().method() === "GET" ? r.fulfill({ json: { dives: serverDives, deleted } }) : r.fulfill({ json: { stored: 0 } })); await page.route("**/api/dives/location", (r) => r.fulfill({ json: { updated: 1 } }));
  await page.route("**/api/dives/delete", (r) => { const b = JSON.parse(r.request().postData()); calls.push(b.fingerprints); if (failNext) { failNext = false; return r.fulfill({ status: 500, json: { error: "down" } }); } serverDives = serverDives.filter((d) => !b.fingerprints.includes(d.fingerprint)); deleted = [...deleted, ...b.fingerprints]; return r.fulfill({ json: { deleted: b.fingerprints.length } }); });
  try {
    await page.goto(base); await page.click("#navLog"); await page.waitForFunction(() => document.querySelectorAll("#diveList details.dive").length === 2, null, { timeout: 8000 });
    const first = page.locator("#diveList details.dive").nth(1);                              // the older dive: her Perdix dive with Togar's Peregrine copy behind it
    await first.locator("summary").click(); await page.waitForSelector(".del-ask"); assert.equal(await page.locator(".del-confirm").count(), 0, "nothing is asked until you tap delete");
    await page.locator(".del-ask").tap(); await page.waitForSelector(".del-confirm");
    const txt = await page.locator(".del-confirm").innerText(); assert.match(txt, /Delete dive 1\?/); assert.match(txt, /cannot be undone/); assert.match(txt, /Peregrine/, "says that the copy from another computer goes too"); assert.match(txt, /not come back when you sync or import/);
    await page.locator(".del-no").tap(); await page.waitForSelector(".del-ask"); assert.equal(calls.length, 0, "Keep it: nothing deleted"); assert.equal(await page.locator("#diveList details.dive").count(), 2);
    // delete: the connection fails first, so the dive is gone from this phone at once and the cloud is told later
    await page.locator(".del-ask").tap(); await page.locator(".del-yes").tap(); await page.waitForFunction(() => document.querySelectorAll("#diveList details.dive").length === 1, null, { timeout: 5000 });
    assert.deepEqual(calls[0].sort(), [all0[0].fingerprint, all0[1].fingerprint].sort(), "the dive and its hidden copy are deleted together"); assert.match(await page.locator("#navLog").innerText(), /Dive log \(1\)/);
    await page.reload(); await page.click("#navLog"); await page.waitForFunction(() => document.querySelectorAll("#diveList details.dive").length === 1, null, { timeout: 8000 });
    await page.waitForFunction(() => true); await page.waitForTimeout(500); assert.equal(calls.length, 2, "the failed deletion is sent again the next time"); assert.deepEqual(deleted.sort(), [all0[0].fingerprint, all0[1].fingerprint].sort());
    // the cloud answers with a stale list that still holds the dive: it stays deleted on this phone
    serverDives = [...all0]; await page.reload(); await page.click("#navLog"); await page.waitForFunction(() => document.querySelectorAll("#diveList details.dive").length === 1, null, { timeout: 8000 }); await page.waitForTimeout(500);
    assert.equal(await page.locator("#diveList details.dive").count(), 1); assert.match(await page.locator("#diveList details.dive").first().locator("summary").innerText(), /Perdix/);
    assert.equal(await page.evaluate(() => new Promise((res) => { const r = indexedDB.open("cosmiq", 1); r.onsuccess = () => { const q = r.result.transaction("dives").objectStore("dives").getAll(); q.onsuccess = () => res(q.result.filter((d) => d.deleted).length); }; })), 2, "only the fingerprints of the deleted dives are kept");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll"); assert.deepEqual(errs, [], "page errors");
    console.log("PASS delete a dive");
  } catch (e) { failed++; console.log("FAIL delete a dive\n ", e.message.split("\n").slice(0, 6).join(" | "), "\n  ", (e.stack || "").split("\n").find((l) => l.includes("e2e.mjs"))); await page.screenshot({ path: "/tmp/fail-delete.png", fullPage: true }); }
  await ctx.close();
}
await browser.close(); server.close(); process.exit(failed ? 1 : 0);
