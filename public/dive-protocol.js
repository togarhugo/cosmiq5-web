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
      number: u16le(header, 0),                      // the device's own dive number (1 = first dive ever logged)
      minTempC: u16le(header, 24) / 10,              // true minimum water temperature
      sampleCount: u16le(header, 28),                // number of 4-byte profile samples
      pageStart: u16le(header, 30), pageEnd: u16le(header, 32),   // where the profile lives in the device's profile memory
      atmFlags: u16le(header, 4) >> 13,              // top 3 bits of the pressure word (meaning unknown; 5 or 6 so far)
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

  // ---------- profile memory is a 256-page ring ----------
  // Each dive's depth profile lives in 2 pages (512 bytes each) of a ring of 256 pages. Page numbers in the headers keep
  // counting up (0, 2, 4 ... 254, 256, 258 ...). Writes wrap around (page 256 -> physical page 0) and overwrite the oldest
  // dives, but the device can only READ pages 0-255: asking for a dive stored at page >= 256 returns erased bytes (0xFF),
  // while the newest dives' real data is returned under the OLDEST dives' numbers. Everything below deals with that.
  const RING_PAGES = 256;
  const pageOf = (h) => u16le(h, 30), samplesOf = (h) => u16le(h, 28), numberOf = (h) => u16le(h, 0);
  const isEmptySample = (b, o) => b[o] === 255 && b[o + 1] === 255 && b[o + 2] === 255 && b[o + 3] === 255;

  /**
   * Does `profile` (bytes) belong to the dive described by `header`? The sample count must agree exactly; minimum temperature
   * and maximum depth are sanity checks. status: "ok" (complete), "truncated" (genuine but shorter than the header says,
   * `missing` samples lost), "empty" (all 0xFF), "mismatch" (some other dive's data), "none" (no bytes).
   */
  function profileCheck(header, profile) {
    const n = samplesOf(header);
    if (!profile || profile.length < 4) return { status: "none", valid: 0, expected: n, missing: n };
    const atm = u16le(header, 4) & 0x1fff;
    // Bytes after this dive's last sample are erased leftovers (0xFF). Anything else there means the data continues:
    // these bytes belong to a longer dive, not to this one.
    for (let o = 4 * n; o < profile.length; o++) if (profile[o] !== 255) return { status: "mismatch", valid: 0, expected: n, missing: n };
    const blob = profile.length > 4 * n ? profile.slice(0, 4 * n) : profile;
    const total = Math.floor(blob.length / 4);
    let valid = 0, minT = 65535, maxD = 0;
    for (let i = 0; i < total; i++) {
      const o = i * 4; if (isEmptySample(blob, o)) continue;
      valid++; minT = Math.min(minT, u16le(blob, o)); maxD = Math.max(maxD, u16le(blob, o + 2));
    }
    if (valid === 0) return { status: "empty", valid: 0, expected: n, missing: n };
    const complete = valid === n;
    const countOk = complete || (valid === total && total < n);          // no holes, just shorter
    const hdrMaxM = (u16le(header, 22) - atm) * 100 / (1025 * GRAVITY), maxM = (maxD - atm) * 100 / (1025 * GRAVITY);
    const hdrMinT = u16le(header, 24);
    const tempOk = complete ? Math.abs(minT - hdrMinT) <= 5 : minT >= hdrMinT - 1;
    const depthOk = maxM <= hdrMaxM + 1.5 && (!complete || maxM >= hdrMaxM - 1.5);
    return { status: countOk && tempOk && depthOk ? (complete ? "ok" : "truncated") : "mismatch", valid, expected: n, missing: n - valid };
  }

  /**
   * Work out, for already-downloaded records, which profile really belongs to which dive.
   * records: [{fingerprint, headerHex, profileHex}] (profileHex = bytes read under that dive's own number).
   * Returns { [fingerprint]: { profileHex, status: "ok"|"truncated"|"overwritten"|"empty", missing, from } }.
   * A dive whose own bytes don't fit its header is looked up among the dives that share its physical page slot
   * (page mod 256); a dive with no matching bytes anywhere was overwritten on the device (summary data only).
   */
  function reconcileProfiles(records) {
    const parsed = records.map((r) => ({ r, h: fromHex(r.headerHex), p: fromHex(r.profileHex || "") }));
    const bySlot = new Map();
    for (const x of parsed) { const pg = pageOf(x.h); if (pg < RING_PAGES) { if (!bySlot.has(pg)) bySlot.set(pg, []); bySlot.get(pg).push(x); } }
    const out = {};
    for (const x of parsed) {
      const own = profileCheck(x.h, x.p), fp = x.r.fingerprint;
      if (own.status === "ok" || own.status === "truncated") {
        out[fp] = { profileHex: toHex(x.p.slice(0, 4 * samplesOf(x.h))), status: own.status, missing: own.missing, from: fp }; continue;
      }
      let best = null;
      for (const d of bySlot.get(pageOf(x.h) % RING_PAGES) || []) {
        if (d === x || pageOf(d.h) >= pageOf(x.h)) continue;                 // donor must be an older dive in the same slot
        const c = profileCheck(x.h, d.p);
        if ((c.status === "ok" || c.status === "truncated") && (!best || c.valid > best.c.valid)) best = { c, d };
      }
      if (best) out[fp] = { profileHex: toHex(best.d.p.slice(0, 4 * samplesOf(x.h))), status: best.c.status, missing: best.c.missing, from: best.d.r.fingerprint };
      else out[fp] = { profileHex: "", status: own.status === "empty" ? "empty" : "overwritten", missing: samplesOf(x.h), from: null };
    }
    return out;
  }

  /**
   * Download dives through a transport (kept transport-agnostic so it can be tested against a simulated device):
   *   io.send(cmdByte, dataArray)  -> sends a command
   *   io.recv(cmdByte, nBytes)     -> resolves Uint8Array(nBytes) (accumulates frames)
   * `known` is a Set of fingerprints already stored.
   * Only NEW dives are downloaded: headers are scanned from the newest end and the scan stops at the first dive that is
   * already known (the direction is detected from the dive numbers). If that leaves gaps, or `opts.full` is set, every
   * header is checked. New dives are fetched oldest first and `onDive(rawDive, result)` is awaited after each one, so a
   * dropped connection or Cancel loses at most the dive in flight and the next sync simply continues.
   * Ring-aware: a new dive stored at page >= 256 is read from the slot it physically occupies (see above).
   * Firmware / MAC are informational and best-effort; the dive count and the dives themselves are not.
   */
  async function readDives(io, known, onProgress, onDive, opts) {
    opts = opts || {};
    const say = (m, p) => onProgress && onProgress(m, p);
    let fw = null, mac = null;
    try { await io.send(CMD.FW, [0]); fw = (await io.recv(CMD.FW, 1))[0] & 0x3f; }
    catch (e) { say("Firmware version not available (" + e.message + "), continuing", 0); }
    try { await io.send(CMD.MAC, [0]); mac = toHex(await io.recv(CMD.MAC, 6)); }
    catch (e) { say("Device address not available (" + e.message + "), continuing", 0); }
    await io.send(CMD.COUNT, [0]);    const count = (await io.recv(CMD.COUNT, 1))[0];
    say(`Device reports ${count} dive(s)`, 0);
    const result = { firmware: fw, mac, count, dives: [], skipped: 0, headersRead: 0 };
    if (count === 0) return result;

    const headers = new Map();                                              // device index -> 36-byte header
    const header = async (i) => {
      if (!headers.has(i)) {
        await io.send(CMD.HEADER, [i]);
        const len = (await io.recv(CMD.HEADER, 1))[0];
        if (len !== SZ_HEADER) throw new Error(`unexpected header length ${len} for dive ${i}`);
        headers.set(i, await io.recv(CMD.HEADER_DATA, SZ_HEADER)); result.headersRead++;
      }
      return headers.get(i);
    };

    // which end is the newest? (the device numbers dives 1, 2, 3 ... in the order they were made)
    let newestFirst = true;
    if (count > 1) newestFirst = numberOf(await header(1)) > numberOf(await header(count));
    const newestToOldest = Array.from({ length: count }, (_, k) => (newestFirst ? k + 1 : count - k));

    const scan = async (full) => {
      const fresh = [];
      for (const i of newestToOldest) {
        const h = await header(i), fp = fingerprint(h);
        say(`Checking for new dives (${fresh.length} found)`, 0.05);
        if (known && known.has(fp)) { if (!full) break; continue; }
        fresh.push({ i, h, fp });
      }
      return fresh;
    };
    let fresh = await scan(!!opts.full);
    if (!opts.full && known && known.size + fresh.length < count) fresh = await scan(true);   // gaps: look at everything
    result.skipped = count - fresh.length;

    // index of the dive that physically owns profile slot `slot` (page numbers grow with the dive number: binary search)
    const indexOfPage = async (slot) => {
      let lo = 1, hi = count;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, idx = newestFirst ? count - mid + 1 : mid, pg = pageOf(await header(idx));
        if (pg === slot) return idx;
        if (pg < slot) lo = mid + 1; else hi = mid - 1;
      }
      return null;
    };
    const blobs = new Map();                                                // device index -> bytes read there
    const readBlob = async (idx) => {
      if (!blobs.has(idx)) {
        await io.send(CMD.PROFILE, [idx]);
        const len = u16be(await io.recv(CMD.PROFILE, 2), 0);
        blobs.set(idx, len ? await io.recv(CMD.PROFILE_DATA, len) : new Uint8Array(0));
      }
      return blobs.get(idx);
    };

    const todo = fresh.reverse();                                           // oldest first
    for (let k = 0; k < todo.length; k++) {
      const { i, h, fp } = todo[k], page = pageOf(h);
      say(`Downloading dive ${k + 1} of ${todo.length}`, 0.1 + (k / todo.length) * 0.9);
      const readIdx = page < RING_PAGES ? i : await indexOfPage(page % RING_PAGES);
      const blob = readIdx === null ? new Uint8Array(0) : await readBlob(readIdx);
      const check = profileCheck(h, blob);
      const keep = check.status === "ok" || check.status === "truncated";
      const profile = keep ? blob.slice(0, 4 * samplesOf(h)) : new Uint8Array(0);
      const rec = { index: i, fingerprint: fp, headerHex: toHex(h), profileHex: toHex(profile),
        profileStatus: keep ? check.status : check.status === "empty" ? "empty" : "overwritten", missing: keep ? check.missing : samplesOf(h) };
      result.dives.push(rec);
      if (onDive) await onDive(rec, result);
    }
    say(`Downloaded ${todo.length} new dive(s)`, 1);
    return result;
  }

  /** Command that sets the device clock to `d` (decimal-as-hex YYMMDDHHMMSS). */
  function buildSetTime(d) {
    d = d || new Date();
    const f = [d.getFullYear() % 100, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
    return buildCommand(CMD.SET_TIME, f.map((n) => parseInt(pad(n), 16)));
  }

  const api = { SZ_HEADER, CMD, RING_PAGES, buildCommand, parseFrame, parseDive, readDives, profileCheck, reconcileProfiles,
                fingerprint, buildSetTime, toHex, fromHex };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CosmiqDive = api;
})(typeof self !== "undefined" ? self : this);
