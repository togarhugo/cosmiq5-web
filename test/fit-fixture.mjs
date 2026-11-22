// A tiny FIT file writer for the Garmin tests: header, definition + data messages, compressed timestamps, big-endian, chained files.
// Written from the FIT protocol description, independently of public/garmin-fit.js (so the decoder is tested against the format, not against itself).
const BT = { enum: [0, 1], sint8: [1, 1], uint8: [2, 1], sint16: [3, 2], uint16: [4, 2], sint32: [5, 4], uint32: [6, 4], string: [7, 1], uint8z: [10, 1], uint32z: [12, 4] };
export const FIT_EPOCH = Date.UTC(1989, 11, 31) / 1000;
export const fitTime = (iso) => Date.parse(iso + "Z") / 1000 - FIT_EPOCH;            // "2025-02-04T01:30:00" (read as UTC) -> FIT seconds
const crc16 = (b) => { const T = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400]; let c = 0; for (const x of b) { let t = T[c & 15]; c = (c >> 4) & 0x0fff; c = c ^ t ^ T[x & 15]; t = T[c & 15]; c = (c >> 4) & 0x0fff; c = c ^ t ^ T[(x >> 4) & 15]; } return c; };
/**
 * messages: [{ num, fields: [{ n, t: "uint32", v }], local?: 0-15, compressedTs?: 0-31 }]. A definition is written whenever a message's layout changes.
 * opts: { be: big-endian definitions, dev: add a developer field to every definition, header: 12 | 14 }
 */
export function fitFile(messages, opts = {}) {
  const le = !opts.be, body = [], defs = new Map();
  const put = (n, size, v, little) => { const a = []; for (let i = 0; i < size; i++) a.push(Number((BigInt(v) >> BigInt(8 * (little ? i : size - 1 - i))) & 0xffn)); return a; };
  for (const m of messages) {
    const lt = m.local || 0, sig = m.num + ":" + m.fields.map((f) => f.n + f.t).join(",") + (opts.dev ? "D" : "");
    if (defs.get(lt) !== sig) {
      defs.set(lt, sig);
      body.push((opts.dev ? 0x60 : 0x40) | lt, 0, le ? 0 : 1, ...put(0, 2, m.num, le), m.fields.length);
      for (const f of m.fields) body.push(f.n, f.t === "string" ? f.v.length + 1 : BT[f.t][1], BT[f.t][0] | (f.t === "uint8z" || f.t === "uint32z" ? 0x80 : 0));
      if (opts.dev) body.push(1, 0, 4, 0);                                       // one developer field (number 0, 4 bytes, developer index 0)
    }
    if (m.compressedTs != null) body.push(0x80 | (lt << 5) | m.compressedTs); else body.push(lt);
    for (const f of m.fields) {
      if (f.t === "string") { for (const ch of f.v) body.push(ch.charCodeAt(0)); body.push(0); continue; }
      const size = BT[f.t][1], signed = f.t.startsWith("sint"); let v = f.v;
      if (v === null) v = signed ? (1 << (size * 8 - 1)) - 1 : size === 4 ? 0xffffffff : (1 << (size * 8)) - 1;      // the "no value" marker
      if (signed && v < 0) v += 2 ** (size * 8);
      body.push(...put(0, size, v, le));
    }
    if (opts.dev) body.push(1, 2, 3, 4);
  }
  const hs = opts.header || 14, head = [hs, 0x20, 0x62, 0x08, ...put(0, 4, body.length, true), 0x2e, 0x46, 0x49, 0x54]; if (hs === 14) head.push(0, 0);
  const all = [...head, ...body], c = crc16(body);
  return Uint8Array.from([...all, c & 255, c >> 8]);
}
const f = (n, t, v) => ({ n, t, v });
/**
 * A Descent-like dive activity: file_id (activity), sport, dive settings, gases, records (1 per second), dive summary, session, activity.
 * o = { start: "2025-02-04T01:30:00" (UTC), tzSec: 28800, secs: 600, maxDepth: 25.3, temps: [28, 26], sub: 54, gases: [[0, 32]], number: 57, noLocal: false }
 */
export function descentDive(o = {}) {
  const start = fitTime(o.start || "2025-02-04T01:30:00"), secs = o.secs || 600, maxD = o.maxDepth || 25.3, sub = o.sub == null ? 54 : o.sub;
  const [t0, t1] = o.temps || [28, 26], msgs = [];
  msgs.push({ num: 0, fields: [f(0, "enum", 4), f(1, "uint16", 1), f(2, "uint16", 3258), f(3, "uint32z", 1234567), f(4, "uint32", start)] });
  msgs.push({ num: 12, fields: [f(0, "enum", 53), f(1, "enum", sub)] });
  msgs.push({ num: 258, fields: [f(2, "uint8", 40), f(3, "uint8", 85), f(4, "enum", 1)] });
  for (const [i, ox] of (o.gases || [[0, 32]])) msgs.push({ num: 259, fields: [f(254, "uint16", i), f(0, "uint8", 0), f(1, "uint8", ox), f(2, "enum", 1), f(3, "enum", 0)] });
  for (let t = 0; t <= secs; t++) {
    const x = t / secs, depth = Math.sin(Math.PI * Math.min(1, x)) * maxD;                     // down and back up
    msgs.push({ num: 20, local: 1, fields: [f(253, "uint32", start + t), f(13, "sint8", Math.round(t0 + (t1 - t0) * x)), f(92, "uint32", Math.round(depth * 1000))] });
  }
  msgs.push({ num: 268, fields: [f(253, "uint32", start + secs), f(2, "uint32", Math.round(maxD * 400)), f(3, "uint32", Math.round(maxD * 1000)), f(10, "uint32", o.number == null ? 57 : o.number), f(11, "uint32", (secs - 40) * 1000)] });
  msgs.push({ num: 18, fields: [f(253, "uint32", start + secs), f(2, "uint32", start), f(5, "enum", 53), f(6, "enum", sub), f(7, "uint32", secs * 1000), f(8, "uint32", secs * 1000), f(140, "uint32", Math.round(maxD * 400)), f(141, "uint32", Math.round(maxD * 1000)), f(150, "sint8", Math.min(t0, t1))] });
  msgs.push({ num: 34, fields: o.noLocal ? [f(253, "uint32", start + secs), f(1, "uint16", 1)] : [f(253, "uint32", start + secs), f(5, "uint32", start + secs + (o.tzSec == null ? 28800 : o.tzSec)), f(1, "uint16", 1)] });
  return msgs;
}
/** A non-dive activity (a run) and a non-activity file (monitoring). */
export const runActivity = (start = "2025-02-04T01:30:00") => fitFile([
  { num: 0, fields: [f(0, "enum", 4), f(1, "uint16", 1), f(4, "uint32", fitTime(start))] }, { num: 12, fields: [f(0, "enum", 1), f(1, "enum", 0)] },
  ...Array.from({ length: 30 }, (_, i) => ({ num: 20, local: 1, fields: [f(253, "uint32", fitTime(start) + i), f(3, "uint8", 140)] })),
  { num: 18, fields: [f(253, "uint32", fitTime(start) + 30), f(2, "uint32", fitTime(start)), f(5, "enum", 1), f(7, "uint32", 30000)] }]);
export const monitoringFile = () => fitFile([{ num: 0, fields: [f(0, "enum", 32), f(1, "uint16", 1)] }, { num: 55, fields: [f(253, "uint32", 1000), f(3, "uint32", 5)] }]);
export { f as field };
