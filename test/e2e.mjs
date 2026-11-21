// Run: node test/e2e.mjs   (needs playwright; starts its own static server)
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const P = req("../public/dive-protocol.js");
const { chromium, devices } = req("playwright");
import assert from "node:assert/strict";

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
  if (window.__wrap) dives.push({ h: hdr(2025, 3, 16, 10, 0, 7, 2, 32, 1013 + 900, 3, 20, 255, 256), p: prof3 });
  const readProfile = (n) => { const d = dives[n - 1]; if (!window.__wrap) return d.p;
    const page = d.h[30] | (d.h[31] << 8), len = (d.h[28] | (d.h[29] << 8)) * 4;
    if (page >= 256) return new Array(len).fill(255);                                  // the device cannot read wrapped pages
    if (page === 0) { const p = prof3.slice(); while (p.length < len) p.push(255); return p.slice(0, len); }   // slot 0 now holds dive #3
    return d.p; };
  let handler = null; const out = [];
  const chunks = (str) => { for (let i = 0; i < str.length; i += 20) out.push(str.slice(i, i + 20)); };
  const flush = () => { while (out.length) { const c = enc.encode(out.shift()); handler && handler({ target: { value: new DataView(c.buffer) } }); } };
  const respond = (line) => {
    const raw = line.trim().slice(1).match(/../g).map((x) => parseInt(x, 16)); const cmd = raw[0], n = raw[3];
    if (cmd === 0x58) chunks(frame(0x58, [0x42]));
    else if (cmd === 0x5a) chunks(frame(0x5a, [1, 2, 3, 4, 5, 6]));
    else if ([0x5f, 0x5b, 0x5c, 0x5d, 0x60].includes(cmd)) chunks(frame(cmd, [0, 0, 5, 20, 1, 14]));
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
      assert.match(await page.locator("details.dive").first().innerText(), /#2/); assert.match(await page.locator("details.dive").last().innerText(), /#1/);
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
    assert.ok(await page.locator("#deviceView").isVisible(), "still on the Device tab");
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
    const row = (n) => page.locator("details.dive", { hasText: `#${n}` });
    assert.match(await row(1).innerText(), /summary only/i, "dive #1: its profile was overwritten by dive #3");
    assert.equal(await row(3).locator(".badge").count(), 0, "dive #3 has its own profile (recovered from the wrapped slot)");
    await row(3).locator("summary").click(); await page.waitForSelector("details.dive[open] svg polyline");
    assert.match(await row(3).innerText(), /#3[\s\S]*dive number/);
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
await browser.close(); server.close(); process.exit(failed ? 1 : 0);
