import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
const S = createRequire(import.meta.url)("../public/shearwater.js");

import { compress, pnfDive, peregrine } from "./peregrine-sim.mjs";
const slipEnc = (b) => { const o = []; for (const c of b) { if (c === 0xc0) o.push(0xdb, 0xdc); else if (c === 0xdb) o.push(0xdb, 0xdd); else o.push(c); } o.push(0xc0); return o; };
const T0 = Date.UTC(2026, 4, 2, 9, 30) / 1000, hour = 3600;

test("compression: hand-made vector, and every length round-trips through the simulator's encoder", () => {
  const out = []; assert.equal(S.decompressLre(Uint8Array.from([0xa0, 0x80, 0xc0, 0, 0, 0, 0, 0, 0]), out), true); assert.deepEqual(out, [0x41, 0, 0, 0], "literal 0x41, run of three zeros, end");
  assert.throws(() => S.decompressLre(Uint8Array.from([1, 2, 3]), []), /bad length/);
  const x = Uint8Array.from({ length: 70 }, (_, i) => i); S.decompressXor(x); assert.equal(x[31], 31); assert.equal(x[32], 32 ^ 0); assert.equal(x[40], 40 ^ x[8], "block 2 is XORed with the decoded block 1");
  for (const n of [1, 31, 32, 33, 500, 3000]) for (const kind of ["random", "zeros", "mixed"]) {
    let s = n; const raw = Uint8Array.from({ length: n }, (_, i) => (kind === "zeros" ? 0 : kind === "mixed" ? (i % 7 === 0 ? 0 : (s = (s * 1103515245 + 12345) & 255)) : (s = (s * 1103515245 + 12345) >>> 8 & 255)));
    const dec = []; for (const b of compress(raw)) { assert.equal((b.length * 8) % 9, 0, "blocks are multiples of 9 bytes"); if (S.decompressLre(Uint8Array.from(b), dec)) break; }
    assert.deepEqual(Array.from(S.decompressXor(Uint8Array.from(dec)).slice(0, n)), Array.from(raw), `${kind} ${n}`);
  }
});

test("SLIP framing: 20-byte writes with [frames, index] headers, END/ESC escaped, reader copes with any notification size", async () => {
  const data = Uint8Array.from([1, 0xc0, 2, 0xdb, 3, ...Array(40).fill(0xc0)]);
  const fr = S.slipFrames(data); assert.ok(fr.every((f) => f.length <= 20)); fr.forEach((f, i) => assert.equal(f[1], i)); assert.equal(fr.at(-1).at(-1), 0xc0, "ends with END");
  const flat = fr.flatMap((f) => [...f.slice(2)]); assert.ok(!flat.slice(0, -1).includes(0xc0), "no bare END inside");
  for (const size of [3, 20, 100, 514]) {                                           // a response re-chunked into notifications of any size
    const pk = [...slipEnc(data)], q = []; for (let i = 0; i < pk.length; i += size - 2) q.push(Uint8Array.from([1, q.length, ...pk.slice(i, i + size - 2)]));
    assert.deepEqual(Array.from(await S.slipRead({ read: async () => q.shift() })), Array.from(data), "size " + size);
  }
  const noise = [Uint8Array.from([1, 0, 0xc0, 0xc0, 5, 6, 0xc0])]; assert.deepEqual(Array.from(await S.slipRead({ read: async () => noise.shift() })), [5, 6], "empty packets ignored");
  await assert.rejects(S.slipRead({ read: async () => Uint8Array.from([1, 0, 0xdb, 0xc0]) }), /escaped/);
  await assert.rejects(S.slipRead({ read: async () => Uint8Array.from([1]) }), /invalid packet length/);
});

test("parseDive: reads start, depth, duration, temperature, gas, mode and samples from Petrel Native Format records", () => {
  const d = S.parseDive(pnfDive({ ticks: T0, maxDepth10: 285, duration: 2700, samples: [[0, 0, 29], [0, 120, 28], [0, 285, 27], [0, 40, -2]] }));
  assert.equal(d.startedAt, "2026-05-02T09:30:00"); assert.equal(d.maxDepthM, 28.5); assert.equal(d.durationSec, 2700); assert.equal(d.o2Percent, 32); assert.equal(d.mode, "scuba");
  assert.deepEqual(d.samples, [[10, 0, 29], [20, 12, 28], [30, 28.5, 27], [40, 4, 0]]); assert.equal(d.minTempC, 0, "a negative raw value is corrected like libdivecomputer"); assert.equal(d.intervalSec, 10); assert.equal(d.model, 9); assert.equal(d.serial, "12345678");
  assert.equal(S.parseDive(pnfDive({ ticks: T0, interval: 5 })).samples[1][0], 10, "sample interval from the header");
  assert.equal(S.parseDive(pnfDive({ ticks: T0, mode: 2 })).mode, "gauge"); assert.equal(S.parseDive(pnfDive({ ticks: T0, freedive: true })).mode, "freedive");
  const imp = S.parseDive(pnfDive({ ticks: T0, units: 1, maxDepth10: 1000, samples: [[0, 1000, 77]] })); assert.ok(Math.abs(imp.maxDepthM - 30.48) < 0.01, "feet -> metres"); assert.ok(Math.abs(imp.samples[0][2] - 25) < 0.1, "Fahrenheit -> Celsius");
  assert.throws(() => S.parseDive(new Uint8Array(40)), /too short/); assert.throws(() => S.parseDive(new Uint8Array(200).fill(0xff)), /older log layout/);
  const missing = pnfDive({ ticks: T0 }).slice(0, 32 * 5); assert.throws(() => S.parseDive(missing), /record c0 missing/);
  assert.throws(() => S.parseDive(pnfDive({ ticks: T0, duration: 0 })), /implausible/);
});

test("readDives: downloads only dives that are not known, oldest first, whole conversation checked against the simulated device", async () => {
  const dives = [0, 1, 2].map((i) => ({ ticks: T0 + i * 4 * hour, blob: pnfDive({ ticks: T0 + i * 4 * hour, maxDepth10: 200 + i * 50, samples: [[0, 100, 28], [0, 200 + i * 50, 27]] }) }));
  for (const chunk of [20, 64, 514]) {
    const dev = peregrine({ dives, chunk }), got = [], progress = [];
    const res = await S.readDives(dev.io, { known: (s) => s === "2026-05-02T09:30:00", onProgress: (m, f) => progress.push([m, f]), onDive: async (d) => got.push(d) });
    assert.deepEqual(got.map((d) => d.startedAt), ["2026-05-02T13:30:00", "2026-05-02T17:30:00"], "oldest first, the known one skipped");
    assert.deepEqual(got.map((d) => d.maxDepthM), [25, 30]); assert.equal(res.total, 3); assert.equal(res.fresh, 2); assert.equal(res.failed, 0); assert.equal(res.serial, "12345678"); assert.equal(res.model, 9);
    assert.ok(progress.every(([, f], i) => i === 0 || f >= progress[i - 1][1]), "progress never goes backwards"); assert.equal(progress.at(-1)[1], 1);
    assert.equal(dev.log.at(-1), "shutdown", "session closed like libdivecomputer does");
    assert.ok(dev.log.every((l) => !/^2e/.test(l) || l === "2e902000"), "the only write is the end-of-session message");
  }
  const none = await S.readDives(peregrine({ dives, chunk: 20 }).io, { known: () => true, onDive: async () => assert.fail("nothing to download") }); assert.equal(none.fresh, 0);
  const empty = await S.readDives(peregrine({ dives: [] }).io, { known: () => false, onDive: async () => assert.fail() }); assert.equal(empty.total, 0);
});

test("readDives: a dive that cannot be read is reported and skipped; cancel stops; unsupported layouts and refusals give clear errors", async () => {
  const good = { ticks: T0, blob: pnfDive({ ticks: T0 }) }, bad = { ticks: T0 + 4 * hour, blob: pnfDive({ ticks: T0 + 4 * hour }).slice(0, 32 * 4) }, later = { ticks: T0 + 8 * hour, blob: pnfDive({ ticks: T0 + 8 * hour }) };
  const problems = [], got = [];
  const r = await S.readDives(peregrine({ dives: [good, bad, later] }).io, { known: () => false, onDive: async (d) => got.push(d.startedAt), onProblem: (m) => problems.push(m) });
  assert.equal(r.failed, 1); assert.equal(r.fresh, 2); assert.equal(got.length, 2); assert.match(problems[0], /2026-05-02T13:30:00: record c0 missing/);
  const mismatch = { ticks: T0, blob: pnfDive({ ticks: T0 + 60 }) }; const m = await S.readDives(peregrine({ dives: [mismatch] }).io, { known: () => false, onDive: async () => {}, onProblem: (x) => problems.push(x) }); assert.equal(m.failed, 1);
  let n = 0; await assert.rejects(S.readDives(peregrine({ dives: [good, later] }).io, { known: () => false, cancelled: () => n++ > 1, onDive: async () => {} }), /Cancelled by you/);
  await assert.rejects(S.readDives(peregrine({ dives: [good], base: 0x12345678 }).io, { known: () => false, onDive: async () => {} }), /unknown logbook format 12345678/);
  await assert.rejects(S.readDives({ write: async () => {}, read: async () => Uint8Array.from([1, 0, 2, 0xff, 5, 0, 1, 2, 3, 0xc0]) }, { known: () => false, onDive: async () => {} }), /invalid packet header/);
  await assert.rejects(S.readDives(peregrine({ dives: [good], omit: [0x8060] }).io, { known: () => false, onDive: async () => {} }), /refused the request \(code 31\)/);
  await assert.rejects(S.readDives({ write: async () => {}, read: async () => { throw new S.ProtocolError("timeout waiting for the dive computer"); } }, { known: () => false, onDive: async () => {} }), /timeout/);
});

test("download log: every stage of a download is described in words with timings, and the model can stop it before any dive is read", async () => {
  const dives = [0, 1].map((i) => ({ ticks: T0 + i * 4 * hour, blob: pnfDive({ ticks: T0 + i * 4 * hour, maxDepth10: 200, samples: [[0, 100, 28], [0, 200, 27]] }) }));
  const dev = peregrine({ dives }), notes = [], events = []; dev.io.note = (t) => notes.push(t);
  const res = await S.readDives(dev.io, { known: () => false, log: (m) => events.push(m), identity: async (id) => events.push("IDENTITY " + JSON.stringify(id)), onDive: async () => {} });
  assert.equal(res.fresh, 2);
  assert.ok(events.includes('IDENTITY {"serial":"12345678","firmware":"' + res.firmware + '","model":9,"modelName":"Peregrine"}'), "the identity hook gets the model name (9 = Peregrine, as a real Peregrine answered)");
  const text = events.join("\n");
  for (const must of ["Identity: serial 12345678, firmware", "model number 9 (Peregrine)", "Log layout: answer", "base address 0x80000000", "Dive list page 1: 2 dives listed", "2 dives on the computer, 2 not downloaded yet (2026-05-02 09:30 to 2026-05-02 13:30)", "Dive 1 of 2 (2026-05-02 09:30, address 0x", "depth samples", "log version 13"]) assert.ok(text.includes(must), "log has: " + must + "\n" + text);
  const n = notes.join("\n"); assert.match(n, /Read serial number \(0x8010\): "12345678" \(\d+ ms\)/); assert.match(n, /Read firmware \(0x8011\): "/); assert.match(n, /Read model number \(0x8060\): /); assert.match(n, /Download request: 0xe0000000, up to 1536 bytes, plain: accepted \(\d+ ms\)/, "the dive list request"); assert.match(n, /Data: 7 blocks, 1536 bytes received -> 1536 bytes, \d+\.\d+ s/); assert.match(n, /Download request: 0x80011000, up to 16777215 bytes, compressed: accepted/, "a dive"); assert.match(n, /Data: \d+ blocks, \d+ bytes received \(compressed\) -> \d+ bytes/);
  // the hook can refuse (wrong computer for the chosen tab): nothing is downloaded
  let asked = 0; const dev2 = peregrine({ dives }), got = [];
  await assert.rejects(S.readDives(dev2.io, { known: () => false, identity: async () => { throw new Error("wrong computer"); }, onDive: async (d) => got.push(d) }), /wrong computer/); assert.equal(got.length, 0); assert.ok(!dev2.log.some((l) => /^35/.test(l)), "no download request was made");
  // a failing dive is named in the log with the reason
  const bad = { ticks: T0, blob: pnfDive({ ticks: T0 + 60 }) }, ev3 = []; await S.readDives(peregrine({ dives: [bad] }).io, { known: () => false, log: (m) => ev3.push(m), onDive: async () => {}, onProblem: () => {} }); assert.ok(ev3.some((m) => /Dive 1 of 1 \(2026-05-02 09:30\): FAILED: the dive downloaded does not match the list/.test(m)), ev3.join("\n"));
  // describeExchange: words for requests, nothing for data blocks; a refusal is explained
  assert.equal(S.describeExchange(Uint8Array.from([0x36, 1]), Uint8Array.from([0x76, 1]), 5), null);
  assert.match(S.describeExchange(Uint8Array.from([0x22, 0x80, 0x60]), Uint8Array.from([0x7f, 0x22, 0x31]), 12), /Read model number \(0x8060\): refused, answer 7f2231 \(12 ms\)/);
  assert.equal(S.modelName(9), "Peregrine"); assert.equal(S.modelName(42), "", "an unknown number is not guessed");
});
