/*
 * Cosmiq dive-log protocol + parser (browser global `CosmiqDive`, or CommonJS).
 *
 * Wire format (ASCII, newline-terminated):  '#' | cmd | csum | len | data... | '\n'
 * every field hex-encoded; replies start with '$'. `len` is the number of HEX
 * CHARACTERS of data (2 * data bytes). The sum of all raw bytes is 0 mod 256.
 *
 * Dive commands (all READ-ONLY):
 *   0x40 dive count          0x41 dive header request (-> 1 byte len = 36)
 *   0x42 header data stream  0x43 profile request     (-> 2 bytes length, BE)
 *   0x44 profile data stream 0x58 firmware            0x5A MAC address
 *
 * Reimplemented from the protocol description published by the libdivecomputer
 * project (deepblu_cosmiq driver, LGPL-2.1+, (C) Linus Torvalds, Jef Driesen).
 */
(function (root) {
  "use strict";

  const SZ_HEADER = 36;
  const CMD = { SET_TIME: 0x20, COUNT: 0x40, HEADER: 0x41, HEADER_DATA: 0x42,
                PROFILE: 0x43, PROFILE_DATA: 0x44, FW: 0x58, MAC: 0x5a };
  const MODES = { 2: "scuba", 3: "gauge", 4: "freedive" };
  const GRAVITY = 9.80665;

  const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  function fromHex(s) {
    if (s.length % 2 || /[^0-9a-fA-F]/.test(s)) throw new Error("bad hex");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  /** Build a command line, e.g. buildCommand(0x40,[0]) -> "#40be0200\n"-style string. */
  function buildCommand(cmd, data) {
    data = data || [];
    const len = data.length * 2;
    let sum = cmd + len;
    for (const b of data) sum += b;
    const csum = (256 - (sum & 0xff)) & 0xff;
    return "#" + toHex([cmd, csum, len, ...data]) + "\n";
  }

  /** Parse one reply line ("$....\n"). Throws on any framing / checksum error. */
  function parseFrame(line) {
    line = line.trim();
    if (line[0] !== "$") throw new Error("not a reply frame");
    const raw = fromHex(line.slice(1));
    if (raw.length < 3) throw new Error("frame too short");
    if (raw[2] !== (raw.length - 3) * 2) throw new Error("bad length field");
    let sum = 0;
    for (const b of raw) sum += b;
    if ((sum & 0xff) !== 0) throw new Error("bad checksum");
    return { cmd: raw[0], data: raw.slice(3) };
  }

  const u16le = (d, o) => d[o] | (d[o + 1] << 8);
  const u16be = (d, o) => (d[o] << 8) | d[o + 1];
  const pad = (n, w = 2) => String(n).padStart(w, "0");

  /** The 6 header bytes (date/time) used to recognise a dive we already have. */
  function fingerprint(header) { return toHex(header.slice(6, 12)); }

  /**
   * Parse header(36) + profile bytes. density = kg/m3 (device assumes salt water).
   * Depth = (rawPressure_mbar - atmospheric_mbar) * 100 Pa / (density * g).
   */
  function parseDive(header, profile, density) {
    if (header.length < SZ_HEADER) throw new Error("header too short");
    density = density || 1025;
    const mode = header[2];
    const atm = u16le(header, 4) & 0x1fff;
    const toDepth = (raw) => ((raw - atm) * 100) / (density * GRAVITY);
    const year = u16le(header, 6), day = header[8], month = header[9];
    const minute = header[10], hour = header[11];
    const durRaw = u16le(header, 12);
    const interval = header[26] || 1;
    const dive = {
      fingerprint: fingerprint(header),
      mode: MODES[mode] || "unknown(" + mode + ")",
      startedAt: `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`, // device-local, no tz
      durationSec: mode === 4 ? durRaw : durRaw * 60,
      maxDepthM: toDepth(u16le(header, 22)),
      o2Percent: mode === 2 ? header[3] : null,
      atmosphericMbar: atm,
      sampleIntervalSec: interval,
      samples: [],
    };
    let t = 0;
    for (let o = 0; o + 4 <= profile.length; o += 4) {
      if (profile[o] === 255 && profile[o + 1] === 255 && profile[o + 2] === 255 && profile[o + 3] === 255) continue;
      t += interval;
      dive.samples.push({ t, depthM: toDepth(u16le(profile, o + 2)), tempC: u16le(profile, o) / 10 });
    }
    return dive;
  }

  /**
   * Download dives through a transport:
   *   transport.request(cmd, dataBytes, {expect:[[cmd,nBytes]...]})  -- see app code
   * Kept transport-agnostic so it can be tested against a simulated device.
   *   io.send(cmdByte, dataArray)          -> sends a command
   *   io.recv(cmdByte, nBytes)             -> resolves Uint8Array(nBytes) (accumulates frames)
   * `known` is a Set of fingerprints already stored; their profiles are skipped.
   */
  async function readDives(io, known, onProgress) {
    const say = (m, p) => onProgress && onProgress(m, p);
    await io.send(CMD.FW, [0]);       const fw = (await io.recv(CMD.FW, 1))[0];
    await io.send(CMD.MAC, [0]);      const mac = toHex(await io.recv(CMD.MAC, 6));
    await io.send(CMD.COUNT, [0]);    const count = (await io.recv(CMD.COUNT, 1))[0];
    say(`Device reports ${count} dive(s)`, 0);
    const result = { firmware: fw & 0x3f, mac, count, dives: [], skipped: 0 };
    const headers = [];
    for (let i = 1; i <= count; i++) {
      await io.send(CMD.HEADER, [i]);
      const len = (await io.recv(CMD.HEADER, 1))[0];
      if (len !== SZ_HEADER) throw new Error(`unexpected header length ${len} for dive ${i}`);
      headers.push(await io.recv(CMD.HEADER_DATA, SZ_HEADER));
      say(`Read header ${i}/${count}`, (i / count) * 0.2);
    }
    for (let i = 1; i <= count; i++) {
      const header = headers[i - 1];
      const fp = fingerprint(header);
      if (known && known.has(fp)) { result.skipped++; continue; }
      await io.send(CMD.PROFILE, [i]);
      const len = u16be(await io.recv(CMD.PROFILE, 2), 0);
      const profile = len ? await io.recv(CMD.PROFILE_DATA, len) : new Uint8Array(0);
      result.dives.push({ index: i, fingerprint: fp, headerHex: toHex(header), profileHex: toHex(profile) });
      say(`Read dive ${i}/${count} (${len} bytes)`, 0.2 + (i / count) * 0.8);
    }
    return result;
  }

  /** Command that sets the device clock to `d` (decimal-as-hex YYMMDDHHMMSS). */
  function buildSetTime(d) {
    d = d || new Date();
    const f = [d.getFullYear() % 100, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
    return buildCommand(CMD.SET_TIME, f.map((n) => parseInt(pad(n), 16)));
  }

  const api = { SZ_HEADER, CMD, buildCommand, parseFrame, parseDive, readDives,
                fingerprint, buildSetTime, toHex, fromHex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CosmiqDive = api;
})(typeof self !== "undefined" ? self : this);
