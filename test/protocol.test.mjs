import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
const P = createRequire(import.meta.url)("../public/dive-protocol.js");

// ---- simulated device -----------------------------------------------------
function reply(cmd, data) {
  const len = data.length * 2;
  let sum = cmd + len; for (const b of data) sum += b;
  return "$" + P.toHex([cmd, (256 - (sum & 255)) & 255, len, ...data]) + "\n";
}
function makeHeader({ mode, o2, atm, y, mo, d, h, mi, dur, maxRaw, interval }) {
  const b = new Uint8Array(36);
  b[2] = mode; b[3] = o2; b[4] = atm & 255; b[5] = atm >> 8;
  b[6] = y & 255; b[7] = y >> 8; b[8] = d; b[9] = mo; b[10] = mi; b[11] = h;
  b[12] = dur & 255; b[13] = dur >> 8; b[22] = maxRaw & 255; b[23] = maxRaw >> 8; b[26] = interval;
  return b;
}
const sample = (tempTenths, depthRaw) => [tempTenths & 255, tempTenths >> 8, depthRaw & 255, depthRaw >> 8];
const dives = [
  { h: makeHeader({ mode: 2, o2: 32, atm: 1013, y: 2025, mo: 3, d: 14, h: 9, mi: 30, dur: 42, maxRaw: 1013 + 2000, interval: 10 }),
    p: [...sample(285, 1013), ...sample(281, 1013 + 1000), ...[255,255,255,255], ...sample(270, 1013 + 2000)] },
  { h: makeHeader({ mode: 4, o2: 0, atm: 1013, y: 2025, mo: 3, d: 15, h: 8, mi: 5, dur: 95, maxRaw: 1013 + 1500, interval: 2 }),
    p: [...sample(260, 1013 + 1500)] },
];

function simulatedDevice(chunk = 20) {
  const rx = []; let waiters = [];
  const log = [];
  const push = (line) => { for (let i = 0; i < line.length; i += chunk) rx.push(line.slice(i, i + chunk)); };
  let buf = "";
  const pump = () => { while (rx.length && waiters.length) waiters.shift()(rx.shift()); };
  return {
    log,
    async send(cmd, data) {
      const line = P.buildCommand(cmd, data);
      P.parseFrame("$" + line.slice(1)); // our commands must satisfy the same framing rules
      log.push(cmd);
      const n = data[0];
      if (cmd === 0x58) push(reply(0x58, [0x42]));
      else if (cmd === 0x5a) push(reply(0x5a, [1,2,3,4,5,6]));
      else if (cmd === 0x40) push(reply(0x40, [dives.length]));
      else if (cmd === 0x41) { push(reply(0x41, [36])); const h = dives[n-1].h; for (let i=0;i<36;i+=6) push(reply(0x42, h.slice(i,i+6))); }
      else if (cmd === 0x43) { const p = dives[n-1].p; push(reply(0x43, [p.length >> 8, p.length & 255])); for (let i=0;i<p.length;i+=6) push(reply(0x44, p.slice(i,i+6))); }
      else throw new Error("unexpected cmd " + cmd.toString(16));
      pump();
    },
    // reassemble BLE chunks into lines, as the app does
    async recv(cmd, n) {
      const out = [];
      while (out.length < n) {
        let line = "";
        while (!line.endsWith("\n")) { line += rx.length ? rx.shift() : await new Promise((r) => waiters.push(r)); }
        const f = P.parseFrame(line);
        assert.equal(f.cmd, cmd, "reply for wrong command");
        out.push(...f.data);
      }
      assert.equal(out.length, n);
      return Uint8Array.from(out);
    },
  };
}

test("checksum framing matches known-good commands", () => {
  assert.equal(P.buildCommand(0x5f, [0]), "#5f9f0200\n");
  assert.equal(P.buildCommand(0x5d, [0]), "#5da10200\n");
  assert.equal(P.buildSetTime(new Date(2025, 0, 2, 3, 4, 5)), "#20a00c250102030405\n");
});
test("parseFrame rejects corrupt frames", () => {
  assert.throws(() => P.parseFrame(reply(0x40, [3]).replace("03", "04")));
  assert.throws(() => P.parseFrame("#40be0203\n"));
});
test("readDives downloads and parses everything", async () => {
  const dev = simulatedDevice();
  const res = await P.readDives(dev, new Set());
  assert.equal(res.count, 2); assert.equal(res.firmware, 2); assert.equal(res.mac, "010203040506");
  const d0 = P.parseDive(P.fromHex(res.dives[0].headerHex), P.fromHex(res.dives[0].profileHex));
  assert.equal(d0.startedAt, "2025-03-14T09:30:00"); assert.equal(d0.mode, "scuba");
  assert.equal(d0.durationSec, 42 * 60); assert.equal(d0.o2Percent, 32);
  assert.ok(Math.abs(d0.maxDepthM - 19.897) < 0.01, "max depth " + d0.maxDepthM); // 2000 mbar of seawater (1025 kg/m3)
  assert.equal(d0.samples.length, 3);      // the all-0xFF sample is skipped
  assert.equal(d0.samples[2].t, 30); assert.ok(Math.abs(d0.samples[0].tempC - 28.5) < 1e-9);
  const d1 = P.parseDive(P.fromHex(res.dives[1].headerHex), P.fromHex(res.dives[1].profileHex));
  assert.equal(d1.mode, "freedive"); assert.equal(d1.durationSec, 95); assert.equal(d1.o2Percent, null);
});
test("known fingerprints skip profile download", async () => {
  const dev = simulatedDevice();
  const first = await P.readDives(dev, new Set());
  const dev2 = simulatedDevice();
  const res = await P.readDives(dev2, new Set([first.dives[0].fingerprint]));
  assert.equal(res.skipped, 1); assert.equal(res.dives.length, 1);
  assert.equal(dev2.log.filter((c) => c === 0x43).length, 1);
});
test("works with tiny BLE chunks (5 bytes)", async () => {
  const res = await P.readDives(simulatedDevice(5), new Set());
  assert.equal(res.dives.length, 2);
});
