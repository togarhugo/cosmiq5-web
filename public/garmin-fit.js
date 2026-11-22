/* Read dives out of Garmin FIT files (browser global `GarminFit`, or CommonJS for tests).
 *
 * A Garmin Descent (or any Garmin watch with a dive app) records every dive as an activity in a FIT file (Flexible and Interoperable Data
 * Transfer, https://developer.garmin.com/fit). You get these files from Garmin Connect ("Export Original" on an activity = a ZIP with one
 * .fit; "Export your data" = a big ZIP of ZIPs), or straight off the watch (USB: Garmin/Activity/*.fit). This reads the files themselves:
 * no Garmin account, no login, nothing leaves the browser until the dives are saved like any other dive.
 *
 * Only what a dive log needs is decoded. Field numbers are from the FIT SDK profile (Profile.js, "diveSummary" = message 268, "diveGas" = 259,
 * "session" = 18, "record" = 20, "activity" = 34, "fileId" = 0). Times: FIT counts seconds from 1989-12-31 00:00 UTC; the watch's local clock
 * is `activity.local_timestamp - activity.timestamp` seconds ahead of that, which is what the app stores ("the time on the computer").
 * Everything is bounds-checked: the files come from the outside. */
(function (root) {
  "use strict";
  class FitError extends Error {}
  const EPOCH_MS = Date.UTC(1989, 11, 31, 0, 0, 0);
  const MAX_FIT = 30_000_000, MAX_NESTED_ZIP = 400_000_000, MAX_ZIP_ENTRIES = 50_000, MAX_SAMPLES = 1000;
  const SPORT_DIVING = 53, SUB_GAUGE = 55, SUB_APNEA = 56, SUB_APNEA_HUNT = 57;

  // FIT base types: [size, kind, invalid marker]. kind: u unsigned, i signed, f float, d double, s string, b byte, U/I 64-bit
  const BASE = { 0: [1, "u", 0xff], 1: [1, "i", 0x7f], 2: [1, "u", 0xff], 3: [2, "i", 0x7fff], 4: [2, "u", 0xffff], 5: [4, "i", 0x7fffffff], 6: [4, "u", 0xffffffff],
    7: [1, "s"], 8: [4, "f"], 9: [8, "d"], 10: [1, "u", 0], 11: [2, "u", 0], 12: [4, "u", 0], 13: [1, "b"], 14: [8, "I"], 15: [8, "U"], 16: [8, "U"] };
  const WANTED = new Set([0, 12, 18, 20, 34, 258, 259, 268]);

  function readValue(dv, o, base, size, le) {
    const t = BASE[base]; if (!t) return undefined;
    const [n, kind, inv] = t; if (size < n) return undefined;
    let v;
    switch (kind) {
      case "u": v = n === 1 ? dv.getUint8(o) : n === 2 ? dv.getUint16(o, le) : dv.getUint32(o, le); break;
      case "i": v = n === 1 ? dv.getInt8(o) : n === 2 ? dv.getInt16(o, le) : dv.getInt32(o, le); break;
      case "f": v = dv.getFloat32(o, le); return Number.isFinite(v) ? v : undefined;
      case "d": v = dv.getFloat64(o, le); return Number.isFinite(v) ? v : undefined;
      case "I": v = Number(dv.getBigInt64(o, le)); return Number.isFinite(v) ? v : undefined;
      case "U": v = Number(dv.getBigUint64(o, le)); return Number.isFinite(v) ? v : undefined;
      default: return undefined;                                                    // strings and raw bytes are not needed
    }
    return v === inv ? undefined : v;                                                  // the "no value" marker of that type
  }

  /**
   * One FIT file inside `b` starting at `p0`. Returns {end, msgs, skipped, truncated}: msgs[globalNumber] = [{fieldNumber: value}, ...] for the
   * messages a dive log needs. `skipped` = a file that is not an activity (settings, sleep, ...): not read further.
   */
  function decodeFile(b, p0) {
    if (p0 + 12 > b.length) throw new FitError("That is not a FIT file (too short).");
    const hs = b[p0]; if (hs !== 12 && hs !== 14) throw new FitError("That is not a FIT file (bad header).");
    if (b[p0 + 8] !== 0x2e || b[p0 + 9] !== 0x46 || b[p0 + 10] !== 0x49 || b[p0 + 11] !== 0x54) throw new FitError("That is not a FIT file (no .FIT mark).");
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength), dataSize = dv.getUint32(p0 + 4, true);
    let end = p0 + hs + dataSize, truncated = false;
    if (end > b.length) { end = b.length; truncated = true; }
    const defs = new Array(16).fill(null), msgs = {}; let p = p0 + hs, lastTs = null, skipped = false;
    while (p < end) {
      const h = b[p++]; let lt, def, compressed = -1;
      if (h & 0x80) { lt = (h >> 5) & 3; compressed = h & 0x1f; def = defs[lt]; if (!def) throw new FitError("Damaged FIT file (data before its definition)."); }
      else if (h & 0x40) {                                                              // definition message
        lt = h & 0x0f; const dev = !!(h & 0x20);
        if (p + 5 > end) throw new FitError("Damaged FIT file (cut-off definition).");
        p++; const le = b[p++] === 0, gnum = dv.getUint16(p, le); p += 2; const nf = b[p++], fields = []; let size = 0;
        if (p + nf * 3 > end) throw new FitError("Damaged FIT file (cut-off definition).");
        for (let i = 0; i < nf; i++) { const f = { num: b[p], size: b[p + 1], base: b[p + 2] & 0x1f, off: size }; fields.push(f); size += f.size; p += 3; }
        if (dev) { if (p >= end) throw new FitError("Damaged FIT file (cut-off definition)."); const nd = b[p++]; if (p + nd * 3 > end) throw new FitError("Damaged FIT file (cut-off definition)."); for (let i = 0; i < nd; i++) { size += b[p + 1]; p += 3; } }
        defs[lt] = { gnum, le, fields, size }; continue;
      } else { lt = h & 0x0f; def = defs[lt]; if (!def) throw new FitError("Damaged FIT file (data before its definition)."); }
      if (p + def.size > end) { truncated = true; break; }
      if (WANTED.has(def.gnum)) {
        const m = {};
        for (const f of def.fields) {
          if (f.size === 0) continue;
          const v = readValue(dv, p + f.off, f.base, f.size, def.le);                  // an array keeps its first element: nothing a dive log needs is an array
          if (v !== undefined) m[f.num] = v;
        }
        if (compressed >= 0 && lastTs != null) {                                         // compressed timestamp header: 5 bits of time on top of the last full timestamp
          const base = lastTs - (lastTs & 0x1f); m[253] = compressed >= (lastTs & 0x1f) ? base + compressed : base + compressed + 32;
        }
        if (m[253] != null) lastTs = m[253];
        (msgs[def.gnum] || (msgs[def.gnum] = [])).push(m);
        if (def.gnum === 0 && m[0] != null && m[0] !== 4) { skipped = true; p += def.size; break; }   // file_id.type 4 = activity; anything else is not a dive
      } else if (compressed < 0) {
        for (const f of def.fields) if (f.num === 253 && f.size === 4) { const v = readValue(dv, p + f.off, f.base, f.size, def.le); if (v !== undefined) lastTs = v; }
      }
      p += def.size;
    }
    return { end: Math.min(b.length, end + 2), msgs, skipped, truncated };
  }

  const pad = (n) => String(n).padStart(2, "0");
  /** FIT seconds + zone offset seconds -> "2025-02-04T09:30:00" (the clock time shown on the watch). */
  function clock(ts, offsetSec) {
    const d = new Date(EPOCH_MS + (ts + offsetSec) * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  function thin(samples) {
    if (samples.length <= MAX_SAMPLES) return samples;
    const stride = Math.ceil(samples.length / MAX_SAMPLES), out = []; let deepest = 0;
    samples.forEach((s, i) => { if (s[1] > samples[deepest][1]) deepest = i; });
    samples.forEach((s, i) => { if (i % stride === 0 || i === deepest || i === samples.length - 1) out.push(s); });
    return out;
  }
  const scaled = (v, k) => (v == null ? undefined : v / k);

  /** The dives of one decoded file (one per diving session). */
  function divesOf(file) {
    const m = file.msgs, sessions = (m[18] || []).filter((s) => s[5] === SPORT_DIVING), records = m[20] || [], act = (m[34] || [])[0];
    let offset = null;                                                                  // watch clock minus UTC, in seconds
    if (act && act[5] != null && act[253] != null) { const o = act[5] - act[253]; if (Math.abs(o) <= 15 * 3600 && o % 60 === 0) offset = o; }
    const gases = (m[259] || []).filter((g) => g[1] != null && g[2] !== 0).sort((a, b) => (a[254] || 0) - (b[254] || 0));
    const dives = []; let utc = 0;
    sessions.forEach((s, si) => {
      const start = s[2] != null ? s[2] : (records.length ? records[0][253] : null); if (start == null) return;
      const summary = (m[268] || [])[si] || (m[268] || [])[0] || {};
      let elapsed = scaled(s[7], 1000); if (elapsed == null) elapsed = scaled(summary[11], 1000);
      const inside = records.filter((r) => r[253] != null && r[253] >= start && (elapsed == null || r[253] <= start + elapsed + 60));
      const raw = [];
      for (const r of inside) { const dpt = scaled(r[92], 1000); if (dpt == null || dpt < -5 || dpt > 400) continue; raw.push([Math.round(r[253] - start), Math.max(0, +dpt.toFixed(2)), r[13] == null ? null : r[13]]); }
      if (elapsed == null && inside.length) elapsed = inside[inside.length - 1][253] - start;
      const maxDepth = scaled(s[141], 1000) ?? scaled(summary[3], 1000) ?? raw.reduce((x, y) => Math.max(x, y[1]), 0);
      if (elapsed == null || elapsed < 1 || !(maxDepth > 0.1 || raw.length)) return;
      const temps = raw.map((x) => x[2]).filter((x) => x != null), minTemp = s[150] != null ? s[150] : temps.length ? Math.min(...temps) : null;
      const sub = s[6], mode = sub === SUB_GAUGE ? "gauge" : sub === SUB_APNEA || sub === SUB_APNEA_HUNT ? "freedive" : "scuba";
      const deltas = []; for (let i = 1; i < raw.length; i++) deltas.push(raw[i][0] - raw[i - 1][0]);
      const number = summary[10] != null ? summary[10] : s[156] != null ? s[156] : null;
      if (offset == null) utc++;
      dives.push({ startedAt: clock(start, offset == null ? 0 : offset), mode, durationSec: Math.round(elapsed), maxDepthM: +maxDepth.toFixed(2),
        o2Percent: mode === "scuba" && gases.length ? gases[0][1] : null, number: number != null && Number.isInteger(number) && number > 0 ? number : null,
        minTempC: minTemp, intervalSec: median(deltas) || 1, samples: thin(raw) });
    });
    return { dives, utc };
  }

  // ---------- ZIP (a Garmin Connect export: a ZIP of .fit files, or of ZIPs) ----------
  async function inflateRaw(bytes, expected, limit) {
    if (typeof DecompressionStream === "undefined") throw new FitError("This browser cannot unpack ZIP files (no DecompressionStream). Update the browser, or use Chrome / Bluefy.");
    const ds = new DecompressionStream("deflate-raw"), w = ds.writable.getWriter();
    w.write(bytes).catch(() => {}); w.close().catch(() => {});
    const r = ds.readable.getReader(), chunks = []; let total = 0;
    for (;;) { const { done, value } = await r.read(); if (done) break; total += value.length; if (total > limit) { r.cancel().catch(() => {}); throw new FitError("A file inside the ZIP is larger than expected."); } chunks.push(value); }
    const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out;
  }
  function zipEntries(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let e = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new FitError("That ZIP file is damaged (no directory).");
    const count = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = [];
    if (count > MAX_ZIP_ENTRIES) throw new FitError("That ZIP has too many files.");
    for (let i = 0; i < count; i++) {
      if (p + 46 > bytes.length || dv.getUint32(p, true) !== 0x02014b50) throw new FitError("That ZIP file is damaged (bad entry).");
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true), nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      if (p + 46 + nlen > bytes.length) throw new FitError("That ZIP file is damaged (bad name).");
      out.push({ name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen)), method, csize, usize, lho }); p += 46 + nlen + xlen + clen;
    }
    return { entries: out, dv };
  }
  async function zipData(bytes, dv, en, limit) {
    const lh = en.lho; if (lh + 30 > bytes.length || dv.getUint32(lh, true) !== 0x04034b50) throw new FitError("That ZIP file is damaged (bad header).");
    const start = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
    if (start + en.csize > bytes.length) throw new FitError("That ZIP file is damaged (cut off).");
    const data = bytes.subarray(start, start + en.csize);
    if (en.method === 0) return data;
    if (en.method === 8) return inflateRaw(data, en.usize, limit);
    throw new FitError("That ZIP uses an unsupported compression method.");
  }

  /** The kind of a file, from its content: "fit", "zip" or "other". */
  function sniff(bytes) {
    if (bytes.length >= 12 && bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54) return "fit";
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) return "zip";
    return "other";
  }

  /**
   * Dives in a .fit file (chained FIT files are all read), or in a ZIP of them (ZIPs inside ZIPs, up to 3 levels).
   * @returns {Promise<{dives: object[], files: number, notDive: number, utcFallback: number, problems: string[]}>}
   */
  async function read(bytes, opts, state, depth) {
    opts = opts || {}; depth = depth || 0;
    const st = state || { dives: [], files: 0, notDive: 0, utcFallback: 0, problems: [] };
    const kind = sniff(bytes);
    if (kind === "fit") {
      if (bytes.length > MAX_FIT) throw new FitError("That FIT file is larger than " + Math.round(MAX_FIT / 1e6) + " MB.");
      for (let p = 0; p < bytes.length && sniff(bytes.subarray(p)) === "fit";) {
        const f = decodeFile(bytes, p); st.files++;
        if (f.skipped) st.notDive++;
        else { const { dives, utc } = divesOf(f); if (!dives.length) st.notDive++; else { st.dives.push(...dives); st.utcFallback += utc; } }
        if (f.end <= p) break; p = f.end;
      }
    } else if (kind === "zip") {
      if (depth > 3) throw new FitError("ZIP files inside ZIP files go too deep.");
      const { entries, dv } = zipEntries(bytes), real = entries.filter((e) => !/(^|\\|\/)(__MACOSX|\._)/.test(e.name) && !/[\\/]$/.test(e.name));
      const wanted = real.filter((e) => /\.(fit|zip)$/i.test(e.name));
      let n = 0;
      for (const en of wanted) {
        n++; if (opts.onProgress) opts.onProgress(n, wanted.length);
        try {
          const zip = /\.zip$/i.test(en.name);
          const data = await zipData(bytes, dv, en, zip ? MAX_NESTED_ZIP : MAX_FIT);
          await read(data, opts, st, depth + 1);
        } catch (e) { if (st.problems.length < 5) st.problems.push(`${en.name.split(/[\\/]/).pop()}: ${e.message}`); else st.problems.length === 5 && st.problems.push("and more files could not be read"); }
      }
      if (!wanted.length && depth === 0) throw new FitError("There is no .fit file in that ZIP. It contains: " + (real.map((e) => e.name).slice(0, 6).join(", ") || "nothing") + ".");
    } else throw new FitError("That is not a FIT file or a ZIP of FIT files.");
    return st;
  }

  const api = { read, sniff, decodeFile, divesOf, FitError, MAX_SAMPLES };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.GarminFit = api;
})(typeof self !== "undefined" ? self : this);
