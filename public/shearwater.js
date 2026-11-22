/* Shearwater (Peregrine) dive log download over Bluetooth LE (browser global `Shearwater`, or CommonJS for tests).
 *
 * A port of the protocol in libdivecomputer's shearwater_common.c / shearwater_petrel.c and the Petrel Native Format (PNF)
 * decoding of shearwater_predator_parser.c (C) 2013 Jef Driesen, LGPL-2.1+. Only the "V1" protocol (Peregrine, Perdix, Teric,
 * Tern ...) is implemented, not the Perdix 3 variant. Download only: nothing is ever written to the dive computer.
 *
 * Layers (each pure and testable without a device):
 *   SLIP framing over 20-byte BLE writes -> request/response packets (FF 01 len 00 ...) -> RDBI / upload-download commands
 *   -> manifest of dives -> compressed dive blob (9-bit run-length + XOR) -> PNF records -> {start, depth, duration, samples}.
 * `io` is anything with  write(Uint8Array): Promise  and  read(): Promise<Uint8Array>  (one BLE notification per call).
 */
(function (root) {
  "use strict";
  const SERVICE_UUID = "fe25c237-0ece-443c-b0aa-e02033e7029d";           // Perdix / Teric / Peregrine / Tern
  const END = 0xc0, ESC = 0xdb, ESC_END = 0xdc, ESC_ESC = 0xdd;
  const BLE_CHUNK = 20, MAX_PACKET = 254;                                  // V1: 8-bit length field
  const ID = { SERIAL: 0x8010, FIRMWARE: 0x8011, LOGUPLOAD: 0x8021, MODEL: 0x8060 };
  const MANIFEST_ADDR = 0xe0000000, MANIFEST_SIZE = 0x600, RECORD_SIZE = 0x20, DIVE_SIZE = 0xffffff;
  const FEET = 0.3048;
  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  class ProtocolError extends Error {}
  const fmtT = (iso) => iso.slice(0, 16).replace("T", " ");
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  /** Model numbers a dive computer reports. Only what has been seen on a real computer is listed: 9 = Peregrine (a real Peregrine answered 9). */
  const MODEL_NAMES = { 9: "Peregrine" };
  const modelName = (n) => MODEL_NAMES[n] || "";
  const RDBI_NAMES = { 0x8010: "serial number", 0x8011: "firmware", 0x8021: "log layout", 0x8060: "model number" };
  const asText = (b) => { const t = new TextDecoder().decode(b).replace(/\0+$/, ""); return /^[\x20-\x7e]+$/.test(t) ? JSON.stringify(t) : hex(b); };
  /** One request/response pair in words, for the Bluetooth download log (null = not worth a line, like the many data blocks). */
  function describeExchange(req, r, ms) {
    const t = ms.toFixed(0) + " ms";
    if (req[0] === 0x22) { const id = (req[1] << 8) | req[2], name = RDBI_NAMES[id] || "identifier 0x" + id.toString(16); return r[0] === 0x62 ? `Read ${name} (0x${id.toString(16)}): ${asText(r.slice(3))} (${t})` : `Read ${name} (0x${id.toString(16)}): refused, answer ${hex(r.slice(0, 3))} (${t})`; }
    if (req[0] === 0x35) { const addr = ((req[3] << 24) | (req[4] << 16) | (req[5] << 8) | req[6]) >>> 0, size = (req[7] << 16) | (req[8] << 8) | req[9]; return `Download request: 0x${addr.toString(16)}, up to ${size} bytes, ${req[1] === 0x10 ? "compressed" : "plain"}: ${r[0] === 0x75 ? "accepted" : "refused " + hex(r.slice(0, 3))} (${t})`; }
    return null;
  }

  // ---------- SLIP over BLE ----------
  /** Bytes -> the BLE writes to send: every write is 20 bytes at most, starting with [number of frames, frame index]. */
  function slipFrames(data) {
    const body = [];
    for (const c of data) { if (c === END) body.push(ESC, ESC_END); else if (c === ESC) body.push(ESC, ESC_ESC); else body.push(c); }
    body.push(END);
    const nframes = Math.ceil(body.length / BLE_CHUNK);                      // sized like libdivecomputer (the 2 header bytes are not counted)
    const per = BLE_CHUNK - 2, out = [];
    for (let i = 0, k = 0; i < body.length; i += per, k++) out.push(Uint8Array.from([nframes, k, ...body.slice(i, i + per)]));
    return out;
  }
  /** Reads notifications (each: 2 header bytes + SLIP data) until a complete packet ended with END arrives. */
  async function slipRead(io) {
    const out = []; let escaped = false;
    for (;;) {
      const n = await io.read();
      if (n.length < 2) throw new ProtocolError("invalid packet length " + n.length);
      for (let i = 2; i < n.length; i++) {
        let c = n[i];
        if (c === END || c === ESC) {
          if (escaped) throw new ProtocolError("SLIP frame escaped a special character");
          if (c === END) { if (out.length) return Uint8Array.from(out); } else escaped = true;      // empty packets (line noise probes) are ignored
          continue;
        }
        if (escaped) { if (c === ESC_END) c = END; else if (c === ESC_ESC) c = ESC; escaped = false; }
        out.push(c);
      }
    }
  }

  // ---------- request / response ----------
  /** One request, one response. Returns the response payload. `expect` false = send only (used for the final shutdown). */
  async function transfer(io, payload, expect) {
    if (payload.length > MAX_PACKET) throw new ProtocolError("request too long");
    const pkt = new Uint8Array(4 + payload.length); pkt[0] = 0xff; pkt[1] = 0x01; pkt[2] = payload.length + 1; pkt[3] = 0x00; pkt.set(payload, 4);
    const t0 = now();
    for (const f of slipFrames(pkt)) await io.write(f);
    if (expect === false) return null;
    const r = await slipRead(io);
    if (r.length < 4 || r[0] !== 0x01 || r[1] !== 0xff || r[3] !== 0x00) throw new ProtocolError("invalid packet header " + hex(r.slice(0, 6)));
    const len = r[2] - 1;
    if (len < 0 || len + 4 !== r.length) throw new ProtocolError("invalid packet length");
    if (io.note) { const d = describeExchange(payload, r.slice(4), now() - t0); if (d) io.note(d); }
    return r.slice(4);
  }
  /** Read a data identifier (serial number, firmware, model ...). */
  async function rdbi(io, id) {
    const req = Uint8Array.from([0x22, id >> 8, id & 255]), r = await transfer(io, req);
    if (r.length === 3 && r[0] === 0x7f && r[1] === 0x22) throw new ProtocolError("the dive computer refused the request (code " + r[2].toString(16) + ")");
    if (r.length < 3 || r[0] !== 0x62 || r[1] !== req[1] || r[2] !== req[2]) throw new ProtocolError("unexpected response " + hex(r.slice(0, 6)));
    return r.slice(3);
  }

  // ---------- compression ----------
  /** 9-bit run-length stream: bit 8 set = literal byte; otherwise a run of that many zero bytes; 0 = end of stream. */
  function decompressLre(data, out) {
    if ((data.length * 8) % 9 !== 0) throw new ProtocolError("compressed block has a bad length");
    const nbits = data.length * 8;
    for (let off = 0; off + 9 <= nbits; off += 9) {
      const byte = off >> 3, bit = off & 7, value = (((data[byte] << 8) | (data[byte + 1] || 0)) >> (16 - (bit + 9))) & 0x1ff;
      if (value & 0x100) out.push(value & 0xff);
      else if (value === 0) return true;
      else for (let i = 0; i < value; i++) out.push(0);
    }
    return false;
  }
  /** Each 32-byte block was XORed with the one before it. */
  function decompressXor(a) { for (let i = 32; i < a.length; i++) a[i] ^= a[i - 32]; return a; }

  /** Download `size` bytes (at most) from `address`; with `compression` the data is 9-bit RLE + XOR coded. */
  async function download(io, address, size, compression, onBytes) {
    const init = Uint8Array.from([0x35, compression ? 0x10 : 0x00, 0x34, address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255]);
    const r = await transfer(io, init);
    if (r.length < 2 || r[0] !== 0x75) throw new ProtocolError("unexpected response to the download request " + hex(r.slice(0, 6)));
    const len = (r[1] & 0xf0) >> 4;
    if (r.length < len + 2 || len > 4) throw new ProtocolError("unexpected download response");
    let max = 0; for (let i = 0; i < len; i++) max = max * 256 + r[2 + i];
    if (max > MAX_PACKET) throw new ProtocolError("unexpected maximum packet length " + max);
    const out = []; let done = false, got = 0, block = 1; const tDl = now();
    while (got < size && !done) {
      const b = await transfer(io, Uint8Array.from([0x36, block & 255]));
      if (b.length < 2 || b[0] !== 0x76 || b[1] !== (block & 255)) throw new ProtocolError("unexpected block " + block);
      const chunk = b.subarray(2);
      if (got + chunk.length > size) throw new ProtocolError("unexpected block size");
      if (compression) { if (decompressLre(chunk, out)) done = true; } else for (const x of chunk) out.push(x);
      got += chunk.length; block++;
      if (onBytes) onBytes(got);
    }
    const bytes = Uint8Array.from(out); if (compression) decompressXor(bytes);
    if (io.note) { const ms = now() - tDl; io.note(`Data: ${block - 1} blocks, ${got} bytes received${compression ? " (compressed)" : ""} -> ${bytes.length} bytes, ${(ms / 1000).toFixed(2)} s`); }
    const q = await transfer(io, Uint8Array.from([0x37]));
    if (q.length !== 2 || q[0] !== 0x77 || q[1] !== 0x00) throw new ProtocolError("unexpected response to the end of download");
    return bytes;
  }

  // ---------- manifest ----------
  const ticksToStart = (t) => new Date(t * 1000).toISOString().slice(0, 16) + ":00";   // the clock time the dive computer shows (no time zone)
  /** The list of dives: [{ticks, startedAt, address}] newest first. 0xA5C4 = dive, 0x5A23 = deleted. */
  function parseManifest(buf) {
    const out = []; let count = 0;
    for (let off = 0; off + RECORD_SIZE <= buf.length; off += RECORD_SIZE) {
      const h = u16(buf, off);
      if (h === 0x5a23) { count++; continue; }
      if (h !== 0xa5c4) break;
      count++; const ticks = u32(buf, off + 4);
      out.push({ ticks, startedAt: ticksToStart(ticks), address: u32(buf, off + 20) });
    }
    return { dives: out, full: count === MANIFEST_SIZE / RECORD_SIZE };
  }

  // ---------- Petrel Native Format dive ----------
  const T = { SAMPLE: 0x01, FREEDIVE: 0x02, OPEN0: 0x10, OPEN1: 0x11, OPEN4: 0x14, OPEN5: 0x15, CLOSE0: 0x20, FINAL: 0xff };
  const M_GAUGE = 2, M_PPO2 = 3, M_FREEDIVE = 7;
  /**
   * Decode one dive blob. Throws ProtocolError when it is not PNF (the older "predator-like" layout is not supported) or has no
   * opening/closing record. Returns the same fields the UDDF importer produces.
   */
  function parseDive(data) {
    if (data.length < 2 * RECORD_SIZE) throw new ProtocolError("dive data too short (" + data.length + " bytes)");
    if (u16(data, 0) === 0xffff) throw new ProtocolError("this dive uses the older log layout, which is not supported");
    const rec = {}; const samples = []; let freedive = false, firstO2 = null;
    for (let off = 0; off + RECORD_SIZE <= data.length; off += RECORD_SIZE) {
      let zero = true; for (let i = 0; i < RECORD_SIZE; i++) if (data[off + i]) { zero = false; break; }
      if (zero) continue;
      const type = data[off];
      if (type === T.SAMPLE) {
        samples.push(off);
        if (firstO2 == null && (data[off + 8] || data[off + 9])) firstO2 = data[off + 8];
      } else if (type === T.FREEDIVE) freedive = true;
      else if (type >= T.OPEN0 && type <= 0x19) rec["o" + (type - T.OPEN0)] = off;
      else if (type >= T.CLOSE0 && type <= 0x29) rec["c" + (type - T.CLOSE0)] = off;
      else if (type === T.FINAL) rec.final = off;
    }
    for (const k of ["o0", "o4", "c0"]) if (rec[k] == null) throw new ProtocolError(`record ${k} missing: the dive data is incomplete`);
    const imperial = data[rec.o0 + 8] === 1, ticks = u32(data, rec.o0 + 12), logversion = data[rec.o4 + 16];
    const toM = (v10) => (imperial ? v10 * FEET : v10) / 10;
    const mode = freedive ? M_FREEDIVE : logversion >= 8 ? data[rec.o4 + 1] : 1;
    let interval = 10;
    if (logversion >= 9 && rec.o5 != null) { const ms = u16(data, rec.o5 + 23); if (ms >= 1000 && ms <= 60000) interval = ms / 1000; }
    const out = []; let t = 0, minTemp = null;
    for (const off of samples) {
      t += interval;
      let temp = (data[off + 14] << 24) >> 24;                                    // signed byte
      if (temp < 0) { temp += 102; if (temp > 0) temp = 0; }                      // libdivecomputer's fix for negative values
      if (imperial) temp = (temp - 32) * (5 / 9);
      if (minTemp == null || temp < minTemp) minTemp = temp;
      out.push([Math.round(t), +toM(u16(data, off + 1)).toFixed(2), +temp.toFixed(1)]);
    }
    const maxDepth = toM(u16(data, rec.c0 + 4)), duration = u24(data, rec.c0 + 6);
    if (!(duration > 0) || maxDepth < 0 || maxDepth > 400) throw new ProtocolError("implausible dive summary: " + maxDepth + " m, " + duration + " s");
    return {
      ticks, startedAt: ticksToStart(ticks), mode: mode === M_GAUGE || mode === M_PPO2 ? "gauge" : mode === M_FREEDIVE ? "freedive" : "scuba",
      durationSec: duration, maxDepthM: +maxDepth.toFixed(2), o2Percent: mode === M_FREEDIVE || mode === M_GAUGE ? null : firstO2 || null,
      minTempC: minTemp == null ? null : +minTemp.toFixed(1), intervalSec: interval, samples: out, logVersion: logversion,
      serial: rec.final != null ? hex(data.slice(rec.final + 2, rec.final + 6)) : null, model: rec.final != null ? data[rec.final + 13] : null,
    };
  }

  // ---------- whole sync ----------
  /**
   * Download the dives that are not known yet, oldest first, one at a time (each is handed to onDive as soon as it is decoded).
   * opts: { known: (startedAt) => boolean, onProgress(msg, fraction), onDive(dive), onProblem(msg), cancelled(): boolean }
   * Returns {serial, firmware, model, total, fresh, failed}.
   */
  async function readDives(io, opts) {
    const say = (m, f) => opts.onProgress && opts.onProgress(m, f), note = (m) => { if (opts.log) opts.log(m); }, stop = () => { if (opts.cancelled && opts.cancelled()) throw new ProtocolError("Cancelled by you."); };
    say("Reading the dive computer…", 0.02);
    const serial = new TextDecoder().decode(await rdbi(io, ID.SERIAL)), fw = new TextDecoder().decode(await rdbi(io, ID.FIRMWARE)).trim();
    const model = (await rdbi(io, ID.MODEL))[0], lu = await rdbi(io, ID.LOGUPLOAD);
    note(`Identity: serial ${serial}, firmware ${fw}, model number ${model}${modelName(model) ? " (" + modelName(model) + ")" : " (not in the list of known models)"}`);
    if (opts.identity) await opts.identity({ serial, firmware: fw, model, modelName: modelName(model) });
    if (lu.length < 5) throw new ProtocolError("unexpected log layout answer");
    let base = u32(lu, 1);
    if (base === 0xdd000000 || base === 0xc0000000 || base === 0x90000000) base = 0xc0000000; else if (base !== 0x80000000) throw new ProtocolError("unknown logbook format " + base.toString(16));
    note(`Log layout: answer ${hex(lu)}, base address 0x${base.toString(16)}`);
    stop(); say("Reading the list of dives…", 0.05);
    const all = []; let firstTicks = null;
    for (let page = 0; page < 20; page++) {                                         // like libdivecomputer: ask again while the manifest page was full
      const m = parseManifest(await download(io, MANIFEST_ADDR, MANIFEST_SIZE, 0));
      if (page && m.dives.length && m.dives[0].ticks === firstTicks) break;           // the same page again: nothing more to read
      if (!page && m.dives.length) firstTicks = m.dives[0].ticks;
      all.push(...m.dives); note(`Dive list page ${page + 1}: ${m.dives.length} dive${m.dives.length === 1 ? "" : "s"} listed${m.full ? " (page full, asking for more)" : ""}`); if (!m.full) break;
    }
    const fresh = all.filter((d) => !opts.known(d.startedAt)).reverse();             // oldest first: a stopped sync loses nothing
    note(`${all.length} dive${all.length === 1 ? "" : "s"} on the computer, ${fresh.length} not downloaded yet${all.length ? ` (${fmtT(all[all.length - 1].startedAt)} to ${fmtT(all[0].startedAt)})` : ""}`);
    let failed = 0;
    for (let i = 0; i < fresh.length; i++) {
      stop(); const d = fresh[i];
      say(`Downloading dive ${i + 1} of ${fresh.length} (${fmtT(d.startedAt)})`, 0.1 + 0.88 * (i / fresh.length));
      try {
        const tDive = now(), raw = await download(io, base + d.address, DIVE_SIZE, 1, () => {}), dive = parseDive(raw);
        note(`Dive ${i + 1} of ${fresh.length} (${fmtT(d.startedAt)}, address 0x${d.address.toString(16)}): ${raw.length} bytes, ${dive.samples.length} depth samples, ${dive.durationSec} s long, max ${dive.maxDepthM} m, log version ${dive.logVersion}, ${((now() - tDive) / 1000).toFixed(1)} s`);
        if (dive.ticks !== d.ticks) throw new ProtocolError("the dive downloaded does not match the list");
        await opts.onDive(dive);
      } catch (e) { if (!(e instanceof ProtocolError)) throw e; if (/Cancelled/.test(e.message)) throw e; failed++; note(`Dive ${i + 1} of ${fresh.length} (${fmtT(d.startedAt)}): FAILED: ${e.message}`); if (opts.onProblem) opts.onProblem(`${d.startedAt}: ${e.message}`); }
    }
    try { await transfer(io, Uint8Array.from([0x2e, 0x90, 0x20, 0x00]), false); } catch (e) { /* the device closes the session: nothing to wait for */ }
    say(`Done: ${all.length} on the dive computer, ${fresh.length - failed} new` + (failed ? `, ${failed} could not be read` : ""), 1);
    return { serial, firmware: fw, model, total: all.length, fresh: fresh.length - failed, failed };
  }

  // ---------- Web Bluetooth (browser only: Chrome on Android, Bluefy on iPhone) ----------
  /**
   * Let the user pick the dive computer, connect, find the serial characteristic (the one that can notify and be written)
   * and wrap it as `io`. Returns {io, name, close()}. `trace(line)` receives every request/response in hex for the diagnostics.
   */
  async function connect(trace) {
    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (!nav || !nav.bluetooth) throw new Error("This browser cannot use Bluetooth. On iPhone open Dive Manager in Bluefy, on Android use Chrome.");
    const dev = await nav.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SERVICE_UUID] });
    const server = await dev.gatt.connect();
    let svc;
    try { svc = await server.getPrimaryService(SERVICE_UUID); } catch (e) { try { dev.gatt.disconnect(); } catch (e2) {} throw new Error("\u201c" + (dev.name || "That device") + "\u201d is not a Shearwater dive computer. Choose your dive computer in the list."); }
    const chars = await svc.getCharacteristics();
    const ch = chars.find((c) => c.properties.notify && (c.properties.writeWithoutResponse || c.properties.write));
    if (!ch) { try { dev.gatt.disconnect(); } catch (e) {} throw new Error("The Shearwater Bluetooth service has no usable data channel."); }
    const queue = [], waiters = []; let closed = null;
    const fail = (err) => { closed = err; while (waiters.length) waiters.shift().reject(err); };
    ch.addEventListener("characteristicvaluechanged", (e) => {
      const v = e.target.value, bytes = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
      if (trace) trace("RX " + hex(bytes)); const w = waiters.shift(); if (w) w.resolve(bytes); else queue.push(bytes);
    });
    dev.addEventListener("gattserverdisconnected", () => fail(new ProtocolError("The dive computer disconnected. Keep it close and Bluetooth on, then try again.")));
    await ch.startNotifications();
    await new Promise((r) => setTimeout(r, 300)); queue.length = 0;                       // let things settle, drop anything stale (like libdivecomputer)
    const noResp = ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse;
    const io = {
      note(text) { if (trace) trace("NOTE " + text); },
      async write(bytes) { if (closed) throw closed; if (trace) trace("TX " + hex(bytes)); if (noResp) await ch.writeValueWithoutResponse(bytes); else await ch.writeValue(bytes); },
      read() {
        if (queue.length) return Promise.resolve(queue.shift()); if (closed) return Promise.reject(closed);
        return new Promise((resolve, reject) => { const w = { resolve: (b) => { clearTimeout(t); resolve(b); }, reject: (e) => { clearTimeout(t); reject(e); } };
          const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); reject(new ProtocolError("The dive computer did not answer (timeout). Is Bluetooth switched on in its menu?")); }, 8000); waiters.push(w); });
      },
    };
    return { io, name: dev.name || "Shearwater", close() { try { dev.gatt.disconnect(); } catch (e) {} } };
  }

  /** Who is on the other end: serial, firmware and model number. Three read-only requests, the same ones every download starts with. */
  async function identify(io) {
    const text = (b) => new TextDecoder().decode(b).replace(/\0+$/, "").trim();
    const serial = text(await rdbi(io, ID.SERIAL)), firmware = text(await rdbi(io, ID.FIRMWARE)), model = (await rdbi(io, ID.MODEL))[0];
    return { serial, firmware, model, modelName: modelName(model) };
  }

  /**
   * A test that shows what the browser can see, without downloading anything: pick the computer, connect, and report which services it
   * offers and whether the Shearwater data channel is there. Returns a short text (also fine to paste to someone helping).
   */
  async function probe(trace) {
    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (!nav || !nav.bluetooth) throw new Error("This browser cannot use Bluetooth. On iPhone open Dive Manager in Bluefy, on Android use Chrome.");
    const named = { device_information: "device information", battery_service: "battery", generic_access: "generic access" };
    const dev = await nav.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [SERVICE_UUID, ...Object.keys(named)] });
    const lines = ["Name: " + (dev.name || "(none)"), "Connecting\u2026"]; if (trace) trace("PROBE name=" + (dev.name || "") + " id=" + (dev.id || ""));
    let server; try { server = await dev.gatt.connect(); } catch (e) { throw new Error("Found \u201c" + (dev.name || "the device") + "\u201d but could not connect (" + (e && e.message || e) + "). Is another app (Shearwater Cloud, Subsurface) connected to it? Only one can be at a time."); }
    lines.pop(); lines.push("Connected.");
    const seen = [];
    for (const u of [SERVICE_UUID, ...Object.keys(named)]) { try { const svc = await server.getPrimaryService(u); seen.push(u === SERVICE_UUID ? "Shearwater data service" : named[u]); if (u === SERVICE_UUID) { const chars = await svc.getCharacteristics(); const ch = chars.find((c) => c.properties && c.properties.notify && (c.properties.writeWithoutResponse || c.properties.write)); lines.push("Data channel: " + (ch ? "found" : "NOT found") + " (" + chars.length + " characteristics)"); } } catch (e) { /* not offered, or not allowed */ } }
    try { dev.gatt.disconnect(); } catch (e) {}
    lines.push("Services seen: " + (seen.length ? seen.join(", ") : "none"));
    const ok = seen.includes("Shearwater data service");
    lines.push(ok ? "Result: this looks like a Shearwater dive computer the app can talk to. Use \u201cDownload dives over Bluetooth\u201d." : "Result: Bluetooth works, but this device does not offer the Shearwater service. Is it the right device, with Bluetooth switched on in its menu?");
    return { ok, text: lines.join(" \u00b7 ") };
  }

  const api = { connect, probe, identify, modelName, describeExchange, SERVICE_UUID, ProtocolError, slipFrames, slipRead, transfer, rdbi, download, decompressLre, decompressXor, parseManifest, parseDive, readDives, ticksToStart };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Shearwater = api;
})(typeof self !== "undefined" ? self : this);
