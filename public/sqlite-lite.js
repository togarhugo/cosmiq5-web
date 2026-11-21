/* A small, read-only SQLite file reader (browser global `SQLiteLite`, or CommonJS for tests).
 * Just enough to read tables out of an exported database (used for the Shearwater Cloud export): the file header, the b-tree of
 * table pages (leaf and interior), overflow pages for large values (dive blobs), and column names from the CREATE TABLE text.
 * No SQL, no indexes, no WAL, no UTF-16. Every offset is bounds-checked and every page is visited at most once, because the
 * file comes from the outside. See https://www.sqlite.org/fileformat2.html */
(function (root) {
  "use strict";
  class SqliteError extends Error {}
  const MAGIC = "SQLite format 3\0";
  const MAX_ROWS = 200000;

  function open(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 512) throw new SqliteError("That is not a SQLite database (too small).");
    for (let i = 0; i < 16; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) throw new SqliteError("That is not a SQLite database.");
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pageSize = dv.getUint16(16); if (pageSize === 1) pageSize = 65536;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1))) throw new SqliteError("Unsupported database page size.");
    const reserved = bytes[20], U = pageSize - reserved, npages = Math.floor(bytes.length / pageSize);
    if (dv.getUint32(56) > 1) throw new SqliteError("This database is not UTF-8 encoded, which is not supported.");
    if (bytes[18] === 2 && bytes[19] === 2) { /* WAL mode: the main file alone may miss the newest rows; exported copies are normally checkpointed */ }
    const varint = (o) => { let v = 0; for (let i = 0; i < 9; i++) { if (o + i >= bytes.length) throw new SqliteError("Database is truncated."); const b = bytes[o + i]; if (i === 8) return { v: v * 256 + b, n: 9 }; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return { v, n: i + 1 }; } return { v, n: 9 }; };
    const pageAt = (n) => { if (n < 1 || n > npages) throw new SqliteError("Database page " + n + " is out of range."); return (n - 1) * pageSize; };

    /** Payload of a table-leaf cell, following the overflow chain. */
    function payload(cell, P) {
      const X = U - 35, M = Math.floor(((U - 12) * 32) / 255) - 23;
      if (P <= X) { if (cell + P > bytes.length) throw new SqliteError("Database is truncated."); return bytes.subarray(cell, cell + P); }
      const K = M + ((P - M) % (U - 4)), local = K <= X ? K : M, out = new Uint8Array(P);
      out.set(bytes.subarray(cell, cell + local), 0);
      let got = local, next = dv.getUint32(cell + local), guard = 0;
      while (got < P) {
        if (!next || ++guard > 1_000_000) throw new SqliteError("Database overflow chain is broken.");
        const o = pageAt(next), take = Math.min(U - 4, P - got);
        out.set(bytes.subarray(o + 4, o + 4 + take), got); got += take; next = dv.getUint32(o);
      }
      return out;
    }
    function decode(p) {
      let o = 0; const hs = readVar(p, o); o += hs.n; const end = hs.v, types = [];
      if (end > p.length) throw new SqliteError("Bad record header.");
      while (o < end) { const t = readVar(p, o); o += t.n; types.push(t.v); }
      let d = end; const vals = [], pv = new DataView(p.buffer, p.byteOffset, p.byteLength);
      for (const t of types) {
        let v = null;
        if (t === 0) v = null; else if (t === 8) v = 0; else if (t === 9) v = 1;
        else if (t >= 1 && t <= 6) { const n = [0, 1, 2, 3, 4, 6, 8][t]; if (d + n > p.length) throw new SqliteError("Bad record."); let x = 0n; for (let i = 0; i < n; i++) x = (x << 8n) | BigInt(p[d + i]); const bits = BigInt(n * 8); if (x >= 1n << (bits - 1n)) x -= 1n << bits; v = Number(x); d += n; }
        else if (t === 7) { if (d + 8 > p.length) throw new SqliteError("Bad record."); v = pv.getFloat64(d); d += 8; }
        else if (t >= 12) { const n = t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2; if (d + n > p.length) throw new SqliteError("Bad record."); const s = p.subarray(d, d + n); v = t % 2 === 0 ? s : new TextDecoder().decode(s); d += n; }
        else throw new SqliteError("Unknown column type " + t);
        vals.push(v);
      }
      return vals;
    }
    function readVar(p, o) { let v = 0; for (let i = 0; i < 9; i++) { if (o + i >= p.length) throw new SqliteError("Bad record."); const b = p[o + i]; if (i === 8) return { v: v * 256 + b, n: 9 }; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return { v, n: i + 1 }; } return { v, n: 9 }; }

    /** Every row of the table whose root page is `rootPage`, in rowid order: {rowid, values}. */
    function* walk(rootPage) {
      const seen = new Set(); let rows = 0;
      function* page(n) {
        if (seen.has(n)) throw new SqliteError("Database page loop."); seen.add(n);
        const base = pageAt(n), h = n === 1 ? base + 100 : base, type = bytes[h], ncell = dv.getUint16(h + 3);
        if (type === 0x0d) {
          for (let i = 0; i < ncell; i++) {
            const cell = base + dv.getUint16(h + 8 + i * 2); if (cell < base || cell >= base + pageSize) throw new SqliteError("Bad cell pointer.");
            const P = varint(cell), R = varint(cell + P.n);
            if (++rows > MAX_ROWS) throw new SqliteError("Table is too large.");
            yield { rowid: R.v, values: decode(payload(cell + P.n + R.n, P.v)) };
          }
        } else if (type === 0x05) {
          for (let i = 0; i < ncell; i++) { const cell = base + dv.getUint16(h + 12 + i * 2); if (cell < base || cell + 4 > base + pageSize) throw new SqliteError("Bad cell pointer."); yield* page(dv.getUint32(cell)); }
          yield* page(dv.getUint32(h + 8));
        } else throw new SqliteError("Unexpected page type " + type + " (this is not a table).");
      }
      yield* page(rootPage);
    }

    function columnsOf(sql) {
      const a = sql.indexOf("("), b = sql.lastIndexOf(")"); if (a < 0 || b < a) return [];
      const parts = []; let depth = 0, cur = "", q = null;
      for (const ch of sql.slice(a + 1, b)) {
        if (q) { cur += ch; if (ch === q) q = null; continue; }
        if (ch === '"' || ch === "'" || ch === "`") { q = ch; cur += ch; continue; }
        if (ch === "(") depth++; if (ch === ")") depth--;
        if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
      }
      parts.push(cur);
      return parts.map((s) => s.trim()).filter((s) => s && !/^(primary|unique|foreign|check|constraint)\b/i.test(s)).map((s) => {
        const m = /^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|(\S+))/.exec(s); return { name: m[1] || m[2] || m[3] || m[4], rowidAlias: /\binteger\s+primary\s+key\b/i.test(s) };
      });
    }

    const tables = new Map();
    for (const r of walk(1)) { const [type, name, , rootpage, sql] = r.values; if (type === "table" && typeof name === "string" && typeof sql === "string") tables.set(name, { root: rootpage, columns: columnsOf(sql) }); }
    return {
      tables: [...tables.keys()],
      /** Rows of a table as objects keyed by column name. Returns [] when the table does not exist. */
      *rows(name) {
        const t = tables.get(name); if (!t) return;
        for (const r of walk(t.root)) { const o = {}; t.columns.forEach((c, i) => { o[c.name] = c.rowidAlias ? r.rowid : r.values[i] === undefined ? null : r.values[i]; }); yield o; }
      },
    };
  }

  const api = { open, SqliteError };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SQLiteLite = api;
})(typeof self !== "undefined" ? self : this);
