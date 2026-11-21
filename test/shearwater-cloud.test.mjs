import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import { pnfDive } from "./peregrine-sim.mjs";
import { T0, blobOf, bigDive, makeDb, dive, zip } from "./cloud-fixture.mjs";
const req = createRequire(import.meta.url);
const Cloud = req("../public/shearwater-cloud.js"), SQL = req("../public/sqlite-lite.js");


test("SQLiteLite: reads rows from a real database, including interior pages, overflow pages and an integer-primary-key alias", () => {
  const bytes = makeDb({ dives: Array.from({ length: 60 }, (_, i) => dive(i)) });                       // blobs of several KB on 4 KB pages -> overflow chains, 60 rows -> interior pages
  const db = SQL.open(bytes); assert.deepEqual(db.tables.sort(), ["DeletedLogs", "dive_details", "log_data", "misc"]);
  const rows = [...db.rows("log_data")]; assert.equal(rows.length, 60); assert.ok(rows.some((r) => r.data_bytes_1.length > 4096), "some blobs need overflow pages");
  assert.equal(rows[0].format, "sw-pnf"); assert.equal(rows[0].format_version, 0); assert.equal(rows[0].data_bytes_2, null);
  assert.deepEqual([...db.rows("misc")], [{ id: 1, name: "hello" }], "INTEGER PRIMARY KEY comes from the rowid");
  assert.deepEqual([...db.rows("nope")], []);
  assert.equal([...db.rows("dive_details")][3].Location, "Banda", "quoted column name");
  for (const ps of [512, 1024, 8192, 65536]) assert.equal([...SQL.open(makeDb({ dives: Array.from({ length: 12 }, (_, i) => dive(i)), pageSize: ps })).rows("log_data")].length, 12, "page size " + ps);
});

test("SQLiteLite: refuses what is not a usable database, and survives damaged files", () => {
  assert.throws(() => SQL.open(new Uint8Array(1000)), /not a SQLite/); assert.throws(() => SQL.open(new Uint8Array(10)), /too small/); assert.throws(() => SQL.open(Uint8Array.from(Buffer.from("<?xml version='1.0'?>".padEnd(2000, " ")))), /not a SQLite/);
  const good = makeDb({ dives: Array.from({ length: 30 }, (_, i) => dive(i)) });
  assert.throws(() => [...SQL.open(good.slice(0, good.length >> 1)).rows("log_data")], Error, "truncated");
  let s = 99; const rnd2 = () => (s = (s * 1103515245 + 12345) & 0x7fffffff); const t0 = Date.now(); let threw = 0;
  for (let k = 0; k < 400; k++) {                                                                       // random damage: always ends, only ever with an Error
    const m = good.slice(); for (let j = 0; j < 1 + (k % 8); j++) m[512 + (rnd2() % (m.length - 512))] = rnd2() & 255;
    try { const db = SQL.open(m); for (const t of db.tables) for (const r of db.rows(t)) void r; } catch (e) { assert.ok(e instanceof Error, "an Error, not garbage"); threw++; }
  }
  assert.ok(Date.now() - t0 < 20000, "no runaway loops"); assert.ok(threw > 0, "some damage was detected");
});

test("readExport: decodes every dive of a Cloud database, uses the logbook number, skips deleted / other formats, reports broken dives", async () => {
  const dives = [dive(0), dive(1), dive(2, { deleted: true }), dive(3, { format: "sw-clouddb" }), dive(4, { blob: Buffer.from("garbage that is not a dive at all, long enough") }), dive(5, { blob: blobOf(bigDive(T0 + 99 * 3600, 200), 831) }), dive(6)];
  const r = await Cloud.readExport(makeDb({ dives }), () => {});
  assert.equal(r.total, 7); assert.equal(r.dives.length, 4, "0, 1, 5 (with trailing padding) and 6"); assert.deepEqual(r.skipped, { format: 1, deleted: 1 }); assert.equal(r.problems.length, 1); assert.match(r.problems[0], /implausible dive size|unexpected/);
  assert.deepEqual(r.dives.map((d) => d.number), [100, 101, 105, 106], "logbook number from dive_details"); assert.equal(r.dives[0].startedAt, "2026-05-02T09:30:00"); assert.equal(r.dives[0].maxDepthM, 28.5);
  assert.equal(r.dives[0].samples.length, 120); assert.equal(r.dives[1].samples.length, 270); assert.equal(r.dives[0].model, 9); assert.equal(r.dives[0].mode, "scuba"); assert.ok(r.dives.every((d) => /^\d+$/.test(d.logId)));
  let calls = 0; await Cloud.readExport(makeDb({ dives: [dive(0), dive(1)] }), (d, t) => { calls++; assert.equal(t, 2); }); assert.equal(calls, 2, "progress per dive");
  const none = await Cloud.readExport(makeDb({ dives: [] })); assert.equal(none.dives.length, 0);
  assert.equal((await Cloud.readExport(makeDb({ dives: [{ ...dive(0), number: 0 }] }))).dives[0].number, null, "no usable logbook number -> null (the app numbers them in order)");
});

test("ZIP: the account export is a ZIP that contains the database (deflated or stored); other contents are ignored", async () => {
  const db = Buffer.from(makeDb({ dives: [dive(0), dive(1)] }));
  for (const method of [8, 0]) {
    const z = zip([["SyncReport.txt", Buffer.from("ok"), 8], ["__MACOSX/dive_data.db", Buffer.from("junk"), 0], ["dive_data.db", db, method]]);
    const r = await Cloud.readExport(z); assert.equal(r.dives.length, 2, "method " + method);
  }
  assert.equal((await Cloud.readExport(zip([["export/other.sqlite", db, 8]]))).dives.length, 2, "any .db / .sqlite entry");
  await assert.rejects(Cloud.readExport(zip([["readme.txt", Buffer.from("hi"), 8]])), /no database in that ZIP.*readme\.txt/);
  await assert.rejects(Cloud.readExport(zip([["dive_data.db", Buffer.from("not sqlite"), 8]])), /not a SQLite|too small/);
  await assert.rejects(Cloud.readExport(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])), /damaged/);
  await assert.rejects(Cloud.readExport(Uint8Array.from(Buffer.from("<uddf/>"))), /neither a Shearwater Cloud database nor a ZIP/);
  await assert.rejects(Cloud.readExport(makeDb({ dives: [], extra: (d) => d.exec("DROP TABLE log_data") })), /no dive log/);
  assert.equal(Cloud.sniff(db), "db"); assert.equal(Cloud.sniff(zip([])), "zip"); assert.equal(Cloud.sniff(Buffer.from("<?xml")), "text");
});

test("unpackBlob: size prefix, gzip with junk after it, already-unpacked bodies, and a lying size", async () => {
  const raw = pnfDive({ ticks: T0 }); assert.deepEqual(Array.from(await Cloud.unpackBlob(blobOf(raw, 8196))), Array.from(raw));
  const plain = Buffer.concat([Buffer.from([raw.length & 255, raw.length >> 8, 0, 0]), raw]); assert.deepEqual(Array.from(await Cloud.unpackBlob(plain)), Array.from(raw), "not gzipped");
  const bomb = Buffer.alloc(4); bomb.writeUInt32LE(100); await assert.rejects(Cloud.unpackBlob(Buffer.concat([bomb, zlib.gzipSync(Buffer.alloc(50_000_000))])), /more than|unexpected length|implausible/);
  const huge = Buffer.alloc(4); huge.writeUInt32LE(0x7fffffff); await assert.rejects(Cloud.unpackBlob(Buffer.concat([huge, zlib.gzipSync(raw)])), /implausible dive size/);
  await assert.rejects(Cloud.unpackBlob(new Uint8Array(5)), /empty dive data/);
});
