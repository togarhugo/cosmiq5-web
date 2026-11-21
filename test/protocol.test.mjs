import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
const P = createRequire(import.meta.url)("../public/dive-protocol.js");

// ---------------------------------------------------------------------------------------------
// A simulated Cosmiq that behaves like the real one observed on a Gen 5:
//  - dive headers carry number, sample count, min temperature and the page where the profile lives
//  - the profile memory is a RING of 256 pages x 512 bytes; each dive uses 2 pages; writes wrap and
//    erase (0xFF) the oldest dive, but READS only work for pages 0-255 (pages >= 256 return 0xFF)
//  - the dive at header index i is the newest when order = "desc" (index 1 = newest), else the oldest
// ---------------------------------------------------------------------------------------------
const RING = 256, PAGE = 512;
const toHex = P.toHex;
function reply(cmd, data) {
  const len = data.length * 2; let sum = cmd + len; for (const b of data) sum += b;
  return "$" + toHex([cmd, (256 - (sum & 255)) & 255, len, ...data]) + "\n";
}
function makeDive(number, page) {
  const n = 100 + ((number * 37) % 140);                               // 100..239 samples, varies per dive
  const atm = 1000, prof = [], temps = [], deps = [];
  for (let i = 0; i < n; i++) {
    const depth = atm + Math.round((800 + (number % 17) * 90) * Math.sin((Math.PI * i) / (n - 1)));
    const temp = 240 + (number % 9) + Math.round(6 * Math.cos((Math.PI * i) / n));
    deps.push(depth); temps.push(temp); prof.push(temp & 255, temp >> 8, depth & 255, depth >> 8);
  }
  const h = new Uint8Array(36), year = 2020 + Math.floor(number / 336);
  const set16 = (o, v) => { h[o] = v & 255; h[o + 1] = (v >> 8) & 255; };
  set16(0, number); h[2] = 2; h[3] = 21 + (number % 5); set16(4, atm | (5 << 13)); set16(6, year);
  h[8] = 1 + (number % 28); h[9] = 1 + (Math.floor(number / 28) % 12); h[10] = number % 60; h[11] = 8;
  set16(12, Math.round((n * 20) / 60)); set16(22, Math.max(...deps) + 30); set16(24, Math.min(...temps)); h[26] = 20;
  set16(28, n); set16(30, page); set16(32, page + 1);
  return { number, page, n, header: h, profile: Uint8Array.from(prof) };
}
function ringDevice({ total = 20, order = "desc", chunk = 20, fwBytes = 1, dropAtProfileRequest = 0 } = {}) {
  const dives = [], mem = new Uint8Array(RING * PAGE).fill(255), rx = [], waiters = [];
  const stats = { headerRequests: 0, profileRequests: [], sent: [] };
  const write = (d) => { const slot = d.page % RING; mem.fill(255, slot * PAGE, slot * PAGE + 2 * PAGE); mem.set(d.profile, slot * PAGE); };
  const dev = {
    dives, stats,
    addDive() { const d = makeDive(dives.length + 1, 2 * dives.length); dives.push(d); write(d); return d; },
    at(i) { return order === "desc" ? dives[dives.length - i] : dives[i - 1]; },
    async send(cmd, data) {
      P.parseFrame("$" + P.buildCommand(cmd, data).slice(1));                // our commands obey the same framing rules
      stats.sent.push(cmd); const n = data[0], push = (line) => { for (let i = 0; i < line.length; i += chunk) rx.push(line.slice(i, i + chunk)); };
      if (cmd === 0x58) push(reply(0x58, new Array(fwBytes).fill(0x42)));
      else if (cmd === 0x5a) push(reply(0x5a, [1, 2, 3, 4, 5, 6]));
      else if (cmd === 0x40) push(reply(0x40, [dives.length]));
      else if (cmd === 0x41) { stats.headerRequests++; push(reply(0x41, [36])); const h = dev.at(n).header; for (let i = 0; i < 36; i += 6) push(reply(0x42, h.slice(i, i + 6))); }
      else if (cmd === 0x43) {
        stats.profileRequests.push(n);
        if (dropAtProfileRequest && stats.profileRequests.length === dropAtProfileRequest) throw new Error("Disconnected");
        const d = dev.at(n), len = d.n * 4;
        const data2 = d.page < RING ? mem.slice(d.page * PAGE, d.page * PAGE + len) : new Uint8Array(len).fill(255);   // device cannot read wrapped pages
        push(reply(0x43, [len >> 8, len & 255])); for (let i = 0; i < len; i += 6) push(reply(0x44, data2.slice(i, i + 6)));
      } else throw new Error("unexpected cmd " + cmd.toString(16));
      while (rx.length && waiters.length) waiters.shift()(rx.shift());
    },
    async recv(cmd, n) {
      const out = [];
      while (out.length < n) {
        let line = ""; while (!line.endsWith("\n")) line += rx.length ? rx.shift() : await new Promise((r) => waiters.push(r));
        const f = P.parseFrame(line); assert.equal(f.cmd, cmd, "reply for wrong command"); out.push(...f.data);
      }
      assert.equal(out.length, n, "reply length"); return Uint8Array.from(out);
    },
  };
  for (let i = 0; i < total; i++) dev.addDive();
  return dev;
}
const fp = (d) => P.fingerprint(d.header);
/** What the device has really kept of dive d, given all dives written so far. */
function expected(dev, d) {
  const slot = d.page % RING, owner = dev.dives.filter((x) => x.page % RING === slot).sort((a, b) => b.page - a.page)[0];
  if (owner !== d) return { status: "overwritten", profile: new Uint8Array(0) };
  const original = dev.dives.find((x) => x.page === slot);                 // the dive whose index returns this slot's bytes
  const have = Math.min(d.n, original.n);                                  // we can only read as many bytes as THAT dive's header says
  return { status: have < d.n ? "truncated" : "ok", profile: d.profile.slice(0, have * 4), missing: d.n - have };
}
const byFp = (recs) => new Map(recs.map((r) => [r.fingerprint, r]));
const hexOf = (u8) => toHex(u8);

// ---------------------------------------------------------------------------------------------
test("checksum framing matches known-good commands", () => {
  assert.equal(P.buildCommand(0x5f, [0]), "#5f9f0200\n"); assert.equal(P.buildCommand(0x5d, [0]), "#5da10200\n");
  assert.equal(P.buildSetTime(new Date(2025, 0, 2, 3, 4, 5)), "#20a00c250102030405\n");
});
test("parseFrame rejects corrupt frames", () => {
  assert.throws(() => P.parseFrame(reply(0x40, [3]).replace("03", "04"))); assert.throws(() => P.parseFrame("#40be0203\n"));
});

test("header fields are decoded: number, sample count, min temperature, pages, flags", () => {
  const d = makeDive(42, 82), p = P.parseDive(d.header, d.profile);
  assert.equal(p.number, 42); assert.equal(p.sampleCount, d.n); assert.equal(p.pageStart, 82); assert.equal(p.pageEnd, 83); assert.equal(p.atmFlags, 5);
  assert.equal(p.minTempC, Math.min(...Array.from({ length: d.n }, (_, i) => d.profile[i * 4] | (d.profile[i * 4 + 1] << 8))) / 10);
  assert.equal(p.samples.length, d.n); assert.equal(p.mode, "scuba"); assert.equal(p.sampleIntervalSec, 20);
});

test("profileCheck: complete, truncated, empty, mismatch; header min-temp may sit slightly below the sampled minimum", () => {
  const d = makeDive(10, 18);
  assert.equal(P.profileCheck(d.header, d.profile).status, "ok");
  const cut = d.profile.slice(0, 4 * 50); const t = P.profileCheck(d.header, cut);
  assert.equal(t.status, "truncated"); assert.equal(t.missing, d.n - 50);
  assert.equal(P.profileCheck(d.header, new Uint8Array(d.n * 4).fill(255)).status, "empty");
  assert.equal(P.profileCheck(d.header, new Uint8Array(0)).status, "none");
  const other = makeDive(11, 20); assert.equal(P.profileCheck(d.header, other.profile).status, "mismatch", "a different dive's bytes");
  const tail = d.profile.slice(); tail.fill(255, 4 * 60); assert.equal(P.profileCheck(d.header, tail).status, "mismatch", "holes in the middle of what was read are not a clean truncation");
  const h2 = d.header.slice(); h2[24] -= 2; assert.equal(P.profileCheck(h2, d.profile).status, "ok", "0.2 C below the sampled minimum is fine");
  h2[24] -= 20; assert.equal(P.profileCheck(h2, d.profile).status, "mismatch", "2.2 C off is not");
});

for (const order of ["desc", "asc"]) {
  test(`wrapped device, index 1 = ${order === "desc" ? "newest" : "oldest"}: every dive is downloaded with the profile it really has`, async () => {
    const dev = ringDevice({ total: 135, order });                          // 135 dives: #129-#135 wrapped over #1-#7
    const res = await P.readDives(dev, new Set());
    assert.equal(res.dives.length, 135); const recs = byFp(res.dives);
    const counts = {};
    for (const d of dev.dives) {
      const r = recs.get(fp(d)), want = expected(dev, d); counts[want.status] = (counts[want.status] || 0) + 1;
      assert.equal(r.profileStatus, want.status, `dive #${d.number} status`);
      assert.equal(r.profileHex, hexOf(want.profile), `dive #${d.number} profile bytes`);
      if (want.status === "truncated") assert.equal(r.missing, want.missing);
    }
    assert.equal(counts.overwritten, 7, "dives #1-#7 lost their profiles to the wrap");
    assert.ok(counts.ok > 120 && (counts.truncated || 0) <= 7, JSON.stringify(counts));
  });
}

test("download only NEW dives: a few headers and one profile per new dive, not the whole log again", async () => {
  const dev = ringDevice({ total: 135 });
  const first = await P.readDives(dev, new Set()); const known = new Set(first.dives.map((r) => r.fingerprint));
  assert.ok(first.headersRead >= 135 && dev.stats.profileRequests.length >= 128, "first sync reads everything");
  // nothing new: no profile downloads, only the two end headers + the first comparison
  dev.stats.profileRequests.length = 0; dev.stats.headerRequests = 0;
  const none = await P.readDives(dev, known);
  assert.equal(none.dives.length, 0); assert.equal(dev.stats.profileRequests.length, 0); assert.ok(dev.stats.headerRequests <= 2, "headers read: " + dev.stats.headerRequests);
  assert.equal(none.skipped, 135);
  // three new dives, stored at wrapped pages 270/272/274 -> slots 14/16/18 (owned by dives #8, #9, #10)
  const added = [dev.addDive(), dev.addDive(), dev.addDive()];
  dev.stats.profileRequests.length = 0; dev.stats.headerRequests = 0;
  const events = []; const res = await P.readDives(dev, known, null, async (r) => events.push(r.fingerprint));
  assert.equal(res.dives.length, 3); assert.equal(dev.stats.profileRequests.length, 3, "exactly one profile read per new dive");
  assert.ok(dev.stats.headerRequests < 25, "headers read: " + dev.stats.headerRequests + " (not 138)");
  assert.deepEqual(events, added.map(fp), "downloaded oldest first");
  for (const d of added) {
    const r = byFp(res.dives).get(fp(d)), want = expected(dev, d);
    assert.equal(r.profileStatus, want.status); assert.equal(r.profileHex, hexOf(want.profile), `new dive #${d.number}`);
  }
});

test("gaps are found: a dive that was never saved in the middle of the log is picked up (automatic full scan)", async () => {
  const dev = ringDevice({ total: 60 });
  const all = await P.readDives(dev, new Set());
  const missing = all.dives.find((r) => P.parseDive(P.fromHex(r.headerHex), new Uint8Array(0)).number === 30);
  const known = new Set(all.dives.map((r) => r.fingerprint)); known.delete(missing.fingerprint);
  const res = await P.readDives(dev, known);
  assert.deepEqual(res.dives.map((r) => r.fingerprint), [missing.fingerprint]);
  assert.equal(res.dives[0].profileStatus, "ok");
});

test("opts.full re-checks every header", async () => {
  const dev = ringDevice({ total: 40 }); const all = await P.readDives(dev, new Set());
  const known = new Set(all.dives.map((r) => r.fingerprint)); dev.stats.headerRequests = 0;
  const res = await P.readDives(dev, known, null, null, { full: true });
  assert.equal(res.dives.length, 0); assert.equal(dev.stats.headerRequests, 40);
});

test("legacy data: profiles downloaded the old way (by each dive's own index) are re-attributed to the right dives", async () => {
  const dev = ringDevice({ total: 135 });
  // exactly what the first app version stored: whatever the device returned under each dive's own index
  const legacy = [];
  for (const d of dev.dives) {
    const i = dev.dives.length - dev.dives.indexOf(d);
    await dev.send(0x43, [i]); const len = P.fromHex("00")[0] || 0; void len;
    const n = (await dev.recv(0x43, 2)); const bytes = (n[0] << 8) | n[1]; const blob = await dev.recv(0x44, bytes);
    legacy.push({ fingerprint: fp(d), headerHex: hexOf(d.header), profileHex: hexOf(blob) });
  }
  const res = P.reconcileProfiles(legacy);
  for (const d of dev.dives) {
    const r = res[fp(d)], want = expected(dev, d);
    assert.equal(r.status, want.status, `dive #${d.number}`);
    assert.equal(r.profileHex, hexOf(want.profile), `dive #${d.number} bytes`);
  }
  const recovered = dev.dives.filter((d) => d.page >= RING);
  assert.equal(recovered.length, 7);
  for (const d of recovered) assert.equal(res[fp(d)].from, fp(dev.dives.find((x) => x.page === d.page % RING)), "recovered from the dive that physically owns the slot");
  assert.equal(P.reconcileProfiles([...legacy].reverse())[fp(dev.dives[0])].status, "overwritten", "order of records does not matter");
});

test("reconcile never moves a profile that already fits its own dive", async () => {
  const dev = ringDevice({ total: 30 }); const recs = [];
  for (const d of dev.dives) recs.push({ fingerprint: fp(d), headerHex: hexOf(d.header), profileHex: hexOf(d.profile) });
  const res = P.reconcileProfiles(recs);
  for (const d of dev.dives) { assert.equal(res[fp(d)].status, "ok"); assert.equal(res[fp(d)].from, fp(d)); assert.equal(res[fp(d)].profileHex, hexOf(d.profile)); }
});

test("onDive is awaited after EACH dive, before the next profile is requested (save-as-you-go)", async () => {
  const dev = ringDevice({ total: 3 }); const events = [];
  const origSend = dev.send.bind(dev); dev.send = async (c, d) => { if (c === 0x43) events.push("request " + d[0]); return origSend(c, d); };
  await P.readDives(dev, new Set(), null, async (raw) => { events.push("saved #" + P.parseDive(P.fromHex(raw.headerHex), new Uint8Array(0)).number); });
  assert.deepEqual(events, ["request 3", "saved #1", "request 2", "saved #2", "request 1", "saved #3"], "oldest first, one at a time");
});

test("a dropped connection loses only the dive in flight; a re-run continues with the rest", async () => {
  const saved = new Map(); const onDive = async (raw) => { saved.set(raw.fingerprint, raw); };
  await assert.rejects(() => P.readDives(ringDevice({ total: 20, dropAtProfileRequest: 8 }), new Set(), null, onDive), /Disconnected/);
  assert.equal(saved.size, 7, "the 7 oldest dives were already saved when the link dropped");
  const dev = ringDevice({ total: 20 });
  const res = await P.readDives(dev, new Set(saved.keys()), null, onDive);
  assert.equal(res.dives.length, 13); assert.equal(saved.size, 20); assert.equal(dev.stats.profileRequests.length, 13, "only the missing dives were downloaded");
});

test("firmware / MAC are best-effort: an unexpected reply does not abort the dive download", async () => {
  const msgs = []; const res = await P.readDives(ringDevice({ total: 5, fwBytes: 3 }), new Set(), (m) => msgs.push(m));
  assert.equal(res.dives.length, 5); assert.equal(res.firmware, null); assert.ok(msgs.some((m) => /Firmware version not available/.test(m)));
});

test("works with tiny BLE chunks (5 bytes) and an empty device", async () => {
  assert.equal((await P.readDives(ringDevice({ total: 6, chunk: 5 }), new Set())).dives.length, 6);
  assert.equal((await P.readDives(ringDevice({ total: 0 }), new Set())).dives.length, 0);
});
