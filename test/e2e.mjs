// Run: node test/e2e.mjs   (needs playwright; starts its own static server)
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const P = req("../public/dive-protocol.js");
const { chromium, devices } = req("playwright");
import assert from "node:assert/strict";

const root = path.resolve("public");
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
  const hdr = (y, mo, d, h, mi, dur, mode, o2, maxRaw) => { const b = new Array(36).fill(0);
    b[2] = mode; b[3] = o2; b[4] = 0xf5; b[5] = 0x03; b[6] = y & 255; b[7] = y >> 8; b[8] = d; b[9] = mo; b[10] = mi; b[11] = h;
    b[12] = dur & 255; b[13] = dur >> 8; b[22] = maxRaw & 255; b[23] = maxRaw >> 8; b[26] = 10; return b; };
  const smp = (t, d) => [t & 255, t >> 8, d & 255, d >> 8];
  const prof = []; for (let i = 0; i < 40; i++) { const depth = 1013 + Math.round(1800 * Math.sin((i / 39) * Math.PI)); prof.push(...smp(270 + i % 5, depth)); }
  const dives = [{ h: hdr(2025, 3, 14, 9, 30, 42, 2, 32, 1013 + 1800), p: prof }, { h: hdr(2025, 3, 15, 8, 5, 1, 4, 0, 1013 + 1500), p: smp(260, 1013 + 1500) }];
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
    else if (cmd === 0x43) { const p = dives[n - 1].p; chunks(frame(0x43, [p.length >> 8, p.length & 255])); for (let i = 0; i < p.length; i += 6) chunks(frame(0x44, p.slice(i, i + 6))); }
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
      await page.click("#navLog");
      assert.equal(await page.locator("details.dive").count(), 2);
      await page.locator("details.dive").last().locator("summary").click();
      await page.waitForSelector("details.dive[open] svg polyline");
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
await browser.close(); server.close(); process.exit(failed ? 1 : 0);
