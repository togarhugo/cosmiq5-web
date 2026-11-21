// Fixtures shared by the Shearwater Cloud tests: a Shearwater-Cloud-shaped SQLite file written by real SQLite, and a ZIP writer.
import zlib from "node:zlib"; import { DatabaseSync } from "node:sqlite"; import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { pnfDive } from "./peregrine-sim.mjs";
export const T0 = Date.UTC(2026, 4, 2, 9, 30) / 1000;
export const blobOf = (raw, pad = 0) => { const gz = zlib.gzipSync(raw), head = Buffer.alloc(4); head.writeUInt32LE(raw.length); return Buffer.concat([head, gz, Buffer.alloc(pad)]); };
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
export const bigDive = (ticks, n, maxd = 285) => {
  const d = pnfDive({ ticks, maxDepth10: maxd, duration: n * 10, samples: Array.from({ length: n }, () => [0, Math.floor(rnd() * maxd), Math.floor(10 + rnd() * 20)]) });
  for (let off = 0; off + 32 <= d.length; off += 32) if (d[off] === 0x01) for (const i of [3, 4, 5, 6, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) d[off + i] = Math.floor(rnd() * 256);   // fields the importer ignores: real data is not compressible to nothing
  return d;
};
/** A Shearwater-Cloud-shaped database written by real SQLite. */
export function makeDb({ dives, pageSize = 4096, extra }) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "swc-")), "dive_data.db"), db = new DatabaseSync(file);
  db.exec(`PRAGMA page_size=${pageSize}; CREATE TABLE log_data (log_id TEXT PRIMARY KEY, file_name TEXT, format TEXT, format_version INTEGER, data_bytes_1 BLOB, data_bytes_2 BLOB);
    CREATE TABLE dive_details (DiveId TEXT, DiveNumber TEXT, DiveDate TEXT, Site TEXT, "Location" TEXT); CREATE TABLE DeletedLogs (DiveID TEXT);
    CREATE TABLE misc (id INTEGER PRIMARY KEY, name TEXT);`);
  const a = db.prepare("INSERT INTO log_data VALUES (?,?,?,?,?,?)"), b = db.prepare("INSERT INTO dive_details VALUES (?,?,?,?,?)");
  for (const d of dives) { a.run(d.id, d.file || `Peregrine[12345678]#${d.number} x.swlogzp`, d.format || "sw-pnf", 0, d.blob, null); b.run(d.id, d.number, "2026-05-02", "House reef", "Banda"); if (d.deleted) db.prepare("INSERT INTO DeletedLogs VALUES (?)").run(d.id); }
  db.prepare("INSERT INTO misc (name) VALUES (?)").run("hello"); extra && extra(db); db.close(); return new Uint8Array(fs.readFileSync(file));
}
export const dive = (i, o = {}) => ({ id: "7234317600" + String(1000000000 + i), number: 100 + i, blob: blobOf(bigDive(T0 + i * 4 * 3600, 120 + (i % 5) * 150), 0), ...o });
/** A minimal ZIP writer. */
export function zip(entries) {
  const parts = [], central = []; let off = 0;
  for (const [name, data, method] of entries) {
    const comp = method === 8 ? zlib.deflateRawSync(data) : data, nm = Buffer.from(name), lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    parts.push(lh, nm, comp); central.push(ch, nm); off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}
