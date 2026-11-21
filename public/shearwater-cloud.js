/* Read dives out of a Shearwater Cloud export (browser global `ShearwaterCloud`, or CommonJS for tests).
 *
 * The Shearwater Cloud app can export its database (a SQLite file, `.db`; the mobile "Export account" file is a ZIP that contains
 * one). Every dive is stored in table `log_data` as a blob: 4 bytes little-endian size, then a gzip stream that unpacks to the same
 * Petrel Native Format records the dive computer itself sends (decoded by Shearwater.parseDive). `dive_details` holds the logbook number.
 * Layout as documented by third-party readers (divejson-py, divelog, Subsurface issue #4788), not by Shearwater.
 * Needs: sqlite-lite.js (SQLiteLite) and shearwater.js (Shearwater); gzip/deflate come from the browser's DecompressionStream. */
(function (root) {
  "use strict";
  const need = (n) => { const m = root[n] || (typeof require !== "undefined" ? require("./" + (n === "SQLiteLite" ? "sqlite-lite" : "shearwater") + ".js") : null); if (!m) throw new Error(n + " is not loaded"); return m; };
  class CloudError extends Error {}
  const MAX_UNPACKED = 8_000_000;                                  // one dive; a 10 h dive at 1 s is ~ 1 MB

  async function inflate(bytes, format, expected, limit) {
    if (typeof DecompressionStream === "undefined") throw new CloudError("This browser cannot unpack the file (no DecompressionStream). Update the browser, or use Chrome / Bluefy.");
    const ds = new DecompressionStream(format), w = ds.writable.getWriter();
    w.write(bytes).catch(() => {}); w.close().catch(() => {});
    const r = ds.readable.getReader(), chunks = []; let total = 0;
    try {
      for (;;) { const { done, value } = await r.read(); if (done) break; total += value.length; if (total > limit) { r.cancel().catch(() => {}); throw new CloudError("A dive unpacks to more than " + limit + " bytes: the file looks damaged."); } chunks.push(value); }
    } catch (e) {
      if (e instanceof CloudError) throw e;
      if (!(expected && total >= expected)) throw new CloudError("Could not unpack a dive (" + (e && e.message || e) + ").");   // junk after the stream is common: fine once everything is out
    }
    const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out;
  }

  /** The database inside a Cloud export: the bytes themselves, or the .db entry of a ZIP. */
  async function databaseBytes(bytes) {
    if (bytes[0] === 0x53 && bytes[1] === 0x51 && bytes[2] === 0x4c && bytes[3] === 0x69) return bytes;                 // "SQLi"
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {                                                                          // "PK": a ZIP
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let e = -1;
      for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
      if (e < 0) throw new CloudError("That ZIP file is damaged (no directory).");
      const count = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const found = [];
      for (let i = 0; i < count; i++) {
        if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new CloudError("That ZIP file is damaged (bad entry).");
        const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true), nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
        const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen)); found.push({ name, method, csize, usize, lho }); p += 46 + nlen + xlen + clen;
      }
      const real = found.filter((f) => !/(^|\/)(__MACOSX|\._)/.test(f.name));                                              // Finder's resource-fork copies are not databases
      const hit = real.find((f) => /(^|\/)dive_data\.db$/i.test(f.name)) || real.find((f) => /\.(db|sqlite3?)$/i.test(f.name));
      if (!hit) throw new CloudError("There is no database in that ZIP file. It contains: " + (found.map((f) => f.name).slice(0, 6).join(", ") || "nothing") + ".");
      if (hit.usize > 400_000_000) throw new CloudError("The database in that ZIP is too large.");
      const lh = hit.lho; if (lh + 30 > bytes.length || dv.getUint32(lh, true) !== 0x04034b50) throw new CloudError("That ZIP file is damaged (bad header).");
      const start = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true), data = bytes.subarray(start, start + hit.csize);
      if (hit.method === 0) return data;
      if (hit.method === 8) return inflate(data, "deflate-raw", hit.usize, 400_000_000);
      throw new CloudError("That ZIP uses an unsupported compression method.");
    }
    throw new CloudError("That is neither a Shearwater Cloud database nor a ZIP of one.");
  }

  /** Blob -> Petrel records: 4-byte little-endian size, then gzip (anything after the gzip stream is ignored). */
  async function unpackBlob(blob) {
    if (!(blob instanceof Uint8Array) || blob.length < 24) throw new CloudError("empty dive data");
    const expected = blob[0] | (blob[1] << 8) | (blob[2] << 16) | ((blob[3] << 24) >>> 0);
    if (expected <= 0 || expected > MAX_UNPACKED) throw new CloudError("implausible dive size " + expected);
    let data;
    if (blob[4] === 0x1f && blob[5] === 0x8b) data = await inflate(blob.subarray(4), "gzip", expected, MAX_UNPACKED);
    else data = blob.subarray(4);                                                                                           // already unpacked
    if (data.length > expected) data = data.subarray(0, expected);
    if (data.length % 32) throw new CloudError("dive data has an unexpected length");
    return data;
  }

  /**
   * @param {Uint8Array} bytes  a .db file or a ZIP containing one
   * @param {function} progress (done, total) after every dive
   * @returns {{dives: object[], total: number, skipped: {format: number, deleted: number}, problems: string[]}}
   *   each dive is Shearwater.parseDive's result plus `number` (the logbook number) and `logId`.
   */
  async function readExport(bytes, progress) {
    const SQL = need("SQLiteLite"), SW = need("Shearwater");
    let db; const raw = await databaseBytes(bytes);
    try { db = SQL.open(raw); } catch (e) { throw new CloudError(e.message); }
    if (!db.tables.includes("log_data")) throw new CloudError("This database has no dive log (no log_data table). Is it a Shearwater Cloud export?");
    const numbers = new Map(), deleted = new Set();
    for (const r of db.rows("dive_details")) if (r.DiveId != null) numbers.set(String(r.DiveId), r.DiveNumber);
    for (const r of db.rows("DeletedLogs")) if (r.DiveID != null) deleted.add(String(r.DiveID));
    const rows = [...db.rows("log_data")], dives = [], problems = [], skipped = { format: 0, deleted: 0 };
    let n = 0;
    for (const r of rows) {
      n++;
      const id = String(r.log_id);
      if (deleted.has(id)) { skipped.deleted++; continue; }
      if (r.format && r.format !== "sw-pnf") { skipped.format++; continue; }
      try {
        const d = SW.parseDive(await unpackBlob(r.data_bytes_1)), num = numbers.get(id);
        const n = Number(num);                                                                                  // Shearwater Cloud stores the number as text ("75")
        d.number = num != null && num !== "" && Number.isInteger(n) && n > 0 ? n : null; d.logId = id; dives.push(d);
      } catch (e) { problems.push(`${r.file_name || id}: ${e.message}`); }
      if (progress) progress(n, rows.length);
    }
    return { dives, total: rows.length, skipped, problems };
  }

  const sniff = (b) => (b[0] === 0x53 && b[1] === 0x51 && b[2] === 0x4c && b[3] === 0x69 ? "db" : b[0] === 0x50 && b[1] === 0x4b ? "zip" : "text");
  const api = { readExport, unpackBlob, databaseBytes, sniff, CloudError };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.ShearwaterCloud = api;
})(typeof self !== "undefined" ? self : this);
