import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import { fitFile, descentDive, runActivity, monitoringFile, field as f, fitTime } from "./fit-fixture.mjs";
import { zip } from "./cloud-fixture.mjs";
const G = createRequire(import.meta.url)("../public/garmin-fit.js");
const U = createRequire(import.meta.url)("../public/dive-utils.js");

test("a Descent dive: clock time, duration, depth, gas, number, temperature and profile", async () => {
  const r = await G.read(fitFile(descentDive()));
  assert.equal(r.dives.length, 1); assert.equal(r.notDive, 0); assert.equal(r.files, 1); assert.deepEqual(r.problems, []); assert.equal(r.utcFallback, 0);
  const d = r.dives[0];
  assert.equal(d.startedAt, "2025-02-04T09:30:00", "01:30 UTC + the watch's +8 h = the clock time on the wrist");
  assert.equal(d.durationSec, 600); assert.equal(d.maxDepthM, 25.3); assert.equal(d.o2Percent, 32); assert.equal(d.number, 57); assert.equal(d.mode, "scuba");
  assert.equal(d.minTempC, 26); assert.equal(d.intervalSec, 1);
  assert.equal(d.samples.length, 601); assert.deepEqual(d.samples[0], [0, 0, 28]); assert.equal(d.samples[300][1], 25.3, "deepest point halfway"); assert.equal(d.samples.at(-1)[2], 26);
});

test("modes: gauge, apnea (freedive), and a diver without a gas gets no oxygen figure", async () => {
  assert.equal((await G.read(fitFile(descentDive({ sub: 55 })))).dives[0].mode, "gauge");
  const free = (await G.read(fitFile(descentDive({ sub: 56, secs: 90, maxDepth: 12 })))).dives[0]; assert.equal(free.mode, "freedive"); assert.equal(free.o2Percent, null);
  assert.equal((await G.read(fitFile(descentDive({ sub: 57, secs: 90 })))).dives[0].mode, "freedive", "apnea hunting too");
  assert.equal((await G.read(fitFile(descentDive({ gases: [] })))).dives[0].o2Percent, null);
  assert.equal((await G.read(fitFile(descentDive({ gases: [[1, 50], [0, 21]] })))).dives[0].o2Percent, 21, "the lowest gas number is the main gas");
});

test("time zones: the watch clock comes from the activity's local time; without it the UTC time is used and counted", async () => {
  assert.equal((await G.read(fitFile(descentDive({ tzSec: -5 * 3600 })))).dives[0].startedAt, "2025-02-03T20:30:00");
  assert.equal((await G.read(fitFile(descentDive({ tzSec: 19800 })))).dives[0].startedAt, "2025-02-04T07:00:00", "+5:30");
  const r = await G.read(fitFile(descentDive({ noLocal: true }))); assert.equal(r.dives[0].startedAt, "2025-02-04T01:30:00"); assert.equal(r.utcFallback, 1);
  const odd = await G.read(fitFile(descentDive({ tzSec: 40 * 3600 }))); assert.equal(odd.dives[0].startedAt, "2025-02-04T01:30:00", "an impossible offset is not trusted"); assert.equal(odd.utcFallback, 1);
});

test("not a dive: a run, a monitoring file; they are counted, not imported", async () => {
  const r = await G.read(runActivity()); assert.deepEqual([r.dives.length, r.notDive, r.files], [0, 1, 1]);
  const m = await G.read(monitoringFile()); assert.deepEqual([m.dives.length, m.notDive], [0, 1]);
});

test("the format's corners: big-endian definitions, compressed timestamps, developer fields, a 12 byte header, invalid markers", async () => {
  const base = (await G.read(fitFile(descentDive()))).dives[0];
  assert.deepEqual((await G.read(fitFile(descentDive(), { be: true }))).dives[0], base, "big-endian = same dive");
  assert.deepEqual((await G.read(fitFile(descentDive(), { dev: true }))).dives[0], base, "developer fields are skipped over");
  assert.deepEqual((await G.read(fitFile(descentDive(), { header: 12 }))).dives[0], base, "old 12 byte header");
  // records with compressed timestamp headers (5-bit time offsets, rolling over every 32 s)
  const msgs = descentDive({ secs: 100 }).filter((m) => m.num !== 20), start = fitTime("2025-02-04T01:30:00");
  const at = msgs.findIndex((m) => m.num === 268);
  msgs.splice(at, 0, { num: 20, local: 1, fields: [f(253, "uint32", start), f(13, "sint8", 28), f(92, "uint32", 0)] });
  for (let t = 1; t <= 100; t++) msgs.splice(at + t, 0, { num: 20, local: 2, compressedTs: (start + t) & 31, fields: [f(13, "sint8", 27), f(92, "uint32", t * 100)] });
  const c = (await G.read(fitFile(msgs))).dives[0]; assert.equal(c.samples.length, 101); assert.deepEqual(c.samples.map((s) => s[0]), Array.from({ length: 101 }, (_, i) => i), "time keeps counting across the 32 s rollovers"); assert.equal(c.samples[100][1], 10);
  // a no-value marker (0xFFFFFFFF depth) is ignored, not read as 4294967 m
  const inv = descentDive({ secs: 60 }); inv.find((m) => m.num === 20 && m.fields[0].v === fitTime("2025-02-04T01:30:00") + 5).fields[2].v = null;
  const r = (await G.read(fitFile(inv))).dives[0]; assert.equal(r.samples.length, 60, "the invalid sample is dropped"); assert.ok(r.maxDepthM < 30);
});

test("chained FIT files in one file and a ZIP of FIT files (nested ZIPs, Finder junk, other activities)", async () => {
  const a = fitFile(descentDive({ start: "2025-02-04T01:30:00", number: 57 })), b = fitFile(descentDive({ start: "2025-02-04T05:30:00", number: 58 }));
  const chained = new Uint8Array([...a, ...b]); const c = await G.read(chained); assert.equal(c.dives.length, 2); assert.equal(c.files, 2);
  const inner = zip([["x/2025-02-05.fit", fitFile(descentDive({ start: "2025-02-05T01:30:00", number: 59 })), 8], ["x/run.fit", runActivity(), 8], ["x/readme.txt", new TextEncoder().encode("hi"), 0]]);
  const outer = zip([["Export/a.fit", a, 8], ["Export/b.FIT", b, 0], ["Export/UploadedFiles_0-_Part1.zip", inner, 0], ["__MACOSX/._a.fit", new Uint8Array([1, 2, 3]), 0], ["Export/", new Uint8Array(0), 0]]);
  const r = await G.read(outer, { onProgress: () => {} });
  assert.equal(r.dives.length, 3, "a.fit and b.FIT at the top plus the dive inside the ZIP inside the ZIP");
  assert.equal(r.notDive, 1, "the run in the inner ZIP is counted, not imported"); assert.equal(r.files, 4); assert.deepEqual(r.problems, [], "Finder junk and the folder entry are ignored quietly");
  assert.deepEqual(r.dives.map((d) => d.number).sort(), [57, 58, 59]);
});

test("a ZIP without .fit files, junk, truncated and damaged files: clear errors, nothing crashes", async () => {
  await assert.rejects(() => G.read(zip([["notes.txt", new TextEncoder().encode("x"), 0]])), /no \.fit file in that ZIP/);
  await assert.rejects(() => G.read(new Uint8Array(100).fill(7)), /not a FIT file or a ZIP/);
  await assert.rejects(() => G.read(new Uint8Array([14, 0x20, 0, 0, 1, 0, 0, 0, 0x2e, 0x46, 0x49])), /not a FIT file|too short/);
  const good = fitFile(descentDive({ secs: 120 }));
  const cut = await G.read(good.subarray(0, Math.floor(good.length * 0.6))); assert.ok(cut.dives.length === 0 || cut.dives[0].durationSec > 0, "a file cut off mid-way does not throw");
  await assert.rejects(() => G.read(zip([["a.fit", good, 8]]).subarray(0, 60)), /ZIP file is damaged/);
});

test("fuzz: flipping random bytes never throws anything but a FitError and stays fast", async () => {
  const good = fitFile(descentDive({ secs: 200 })); let seed = 99; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const t0 = Date.now(); let ok = 0, rejected = 0;
  for (let i = 0; i < 400; i++) {
    const b = good.slice(); for (let k = 0; k < 1 + Math.floor(rnd() * 6); k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    try { await G.read(b); ok++; } catch (e) { assert.ok(e instanceof G.FitError, "unexpected " + e); rejected++; }
  }
  assert.ok(ok + rejected === 400 && Date.now() - t0 < 8000, "400 damaged files in " + (Date.now() - t0) + " ms");
});

test("long dives are thinned to 1000 samples keeping the deepest point", async () => {
  const r = (await G.read(fitFile(descentDive({ secs: 5400, maxDepth: 31.7 })))).dives[0];
  assert.ok(r.samples.length <= G.MAX_SAMPLES + 2); assert.equal(Math.max(...r.samples.map((s) => s[1])), 31.7); assert.equal(r.durationSec, 5400);
});

test("Garmin dives sit in the list of dive computers, ranked after the Cosmiq+ and the Peregrine for duplicates", () => {
  assert.deepEqual(U.DEVICES.map((d) => d.id), ["cosmiq", "peregrine", "garmin"]);
  const dive = (device, startedAt, fingerprint) => ({ fingerprint, device, startedAt, durationSec: 1800, maxDepthM: 20 });
  const recs = [dive("garmin", "2025-03-01T09:02:00", "g1"), dive("cosmiq", "2025-03-01T09:00:00", "c1"), dive("peregrine", "2025-03-01T09:01:00", "p1")];
  assert.deepEqual([...U.duplicateMap(recs)].sort(), [["g1", "c1"], ["p1", "c1"]], "one dive on three wrists counts once, the Cosmiq+ record");
  assert.deepEqual(U.uniqueDives(recs).map((r) => r.fingerprint), ["c1"]);
});
