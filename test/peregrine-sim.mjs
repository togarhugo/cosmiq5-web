// A simulated Peregrine, written from the protocol description in libdivecomputer's shearwater_common.c (shared by the unit and browser tests).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const S = createRequire(import.meta.url)("../public/shearwater.js");
const END = 0xc0, ESC = 0xdb;
const slipEnc = (b) => { const o = []; for (const c of b) { if (c === END) o.push(ESC, 0xdc); else if (c === ESC) o.push(ESC, 0xdd); else o.push(c); } o.push(END); return o; };
/** 9-bit run-length encoder + XOR, in blocks the way the device sends them (a block is a multiple of 9 bytes). */
export function compress(raw) {
  const x = Uint8Array.from(raw); for (let i = x.length - 1; i >= 32; i--) x[i] ^= raw[i - 32];
  const vals = []; for (let i = 0; i < x.length;) { if (x[i] === 0) { let n = 0; while (i < x.length && x[i] === 0 && n < 255) { n++; i++; } vals.push(n); } else vals.push(0x100 | x[i++]); }
  vals.push(0); while (vals.length % 8) vals.push(0);
  const bytes = []; let acc = 0, bits = 0; for (const v of vals) { acc = (acc << 9) | v; bits += 9; while (bits >= 8) { bytes.push((acc >> (bits - 8)) & 255); bits -= 8; acc &= (1 << bits) - 1; } }
  const blocks = []; for (let i = 0; i < bytes.length; i += 252) blocks.push(bytes.slice(i, i + 252)); return blocks;
}
export function pnfDive({ ticks, units = 0, maxDepth10 = 285, duration = 2700, samples = [[10, 8, 28], [60, 285, 27]], interval = 10, mode = 1, logversion = 13, freedive = false }) {
  const rec = (type, fill = () => {}) => { const r = new Uint8Array(32); r[0] = type; fill(r); return r; }, out = [];
  out.push(rec(0x10, (r) => { r[8] = units; r[12] = ticks >>> 24; r[13] = (ticks >> 16) & 255; r[14] = (ticks >> 8) & 255; r[15] = ticks & 255; r[20] = 32; }));
  out.push(rec(0x11, (r) => { r[16] = 0x03; r[17] = 0xf5; }));
  out.push(rec(0x14, (r) => { r[1] = mode; r[16] = logversion; }));
  out.push(rec(0x15, (r) => { r[23] = (interval * 1000) >> 8; r[24] = (interval * 1000) & 255; }));
  for (const [, d10, tc] of samples) out.push(rec(freedive ? 0x02 : 0x01, (r) => { r[1] = d10 >> 8; r[2] = d10 & 255; r[8] = 32; r[12] = 0x10; r[14] = tc < 0 ? 256 + tc : tc; }));
  out.push(rec(0x20, (r) => { r[4] = maxDepth10 >> 8; r[5] = maxDepth10 & 255; r[6] = duration >> 16; r[7] = (duration >> 8) & 255; r[8] = duration & 255; }));
  out.push(rec(0xff, (r) => { r[2] = 0x12; r[3] = 0x34; r[4] = 0x56; r[5] = 0x78; r[13] = 9; }));
  const all = new Uint8Array(out.length * 32); out.forEach((r, i) => all.set(r, i * 32)); return all;
}
export function peregrine({ dives, chunk = 20, base = 0x80000000, hooks = {}, omit = [] }) {
  // memory: manifest (newest first) + each dive blob at base + address
  const manifest = new Uint8Array(0x600).fill(0), blobs = new Map(); let addr = 0x1000;
  dives.slice().reverse().forEach((d, i) => { const o = i * 32; manifest[o] = 0xa5; manifest[o + 1] = 0xc4; new DataView(manifest.buffer).setUint32(o + 4, d.ticks); new DataView(manifest.buffer).setUint32(o + 20, addr); blobs.set(base + addr, d.blob); addr += 0x10000; });
  const log = []; let inbox = [], outbox = [], session = null;
  const ids = { 0x8010: [...Buffer.from("12345678")], 0x8011: [...Buffer.from("V93")], 0x8060: [9], 0x8021: [0, base >>> 24, (base >> 16) & 255, (base >> 8) & 255, base & 255, 0, 0, 0, 0] };
  for (const k of omit) delete ids[k];
  const respond = (payload) => { const pk = [1, 0xff, payload.length + 1, 0, ...payload], b = slipEnc(pk), nframes = Math.ceil(b.length / chunk);
    for (let i = 0, k = 0; i < b.length; i += chunk - 2, k++) outbox.push(Uint8Array.from([nframes, k, ...b.slice(i, i + chunk - 2)])); };
  const handle = (req) => {
    log.push(Buffer.from(req).toString("hex"));
    if (hooks.beforeRequest) hooks.beforeRequest(req, respond);
    if (req[0] === 0x22) { const id = (req[1] << 8) | req[2]; return ids[id] ? respond([0x62, req[1], req[2], ...ids[id]]) : respond([0x7f, 0x22, 0x31]); }
    if (req[0] === 0x35) { const a = new DataView(req.buffer, req.byteOffset).getUint32(3), comp = req[1] === 0x10, data = a === 0xe0000000 ? manifest : blobs.get(a);
      if (!data) return respond([0x7f, 0x35, 0x31]); session = { blocks: comp ? compress(data) : Array.from({ length: Math.ceil(data.length / 250) }, (_, i) => Array.from(data.slice(i * 250, i * 250 + 250))), n: 0 }; return respond([0x75, 0x10, 0x00, 0xfe]); }
    if (req[0] === 0x36) { const blk = session.blocks[session.n++]; return blk ? respond([0x76, req[1], ...blk]) : respond([0x7f, 0x36, 0x31]); }
    if (req[0] === 0x37) { session = null; return respond([0x77, 0x00]); }
    if (req[0] === 0x2e) { log.push("shutdown"); return; }
  };
  const io = {
    async write(f) { assert.ok(f.length <= 20, "BLE writes are at most 20 bytes"); assert.equal(f[1], inbox.length, "frame index counts up"); inbox.push(...f.slice(2)); if (f.at(-1) === END) {
      const pk = []; let esc = false; for (const c of inbox) { if (c === END) break; if (c === ESC) { esc = true; continue; } pk.push(esc ? (c === 0xdc ? END : ESC) : c); esc = false; }
      inbox = []; assert.deepEqual(pk.slice(0, 2), [0xff, 1]); assert.equal(pk[2], pk.length - 3, "length byte = payload + 1"); assert.equal(pk[3], 0); handle(Uint8Array.from(pk.slice(4))); } },
    async read() { const n = outbox.shift(); if (!n) throw new S.ProtocolError("timeout waiting for the dive computer"); return n; },
  };
  const drain = () => outbox.splice(0, outbox.length);
  return { io, log, wrote: log, drain };
}
