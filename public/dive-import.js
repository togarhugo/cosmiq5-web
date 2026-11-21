/* Import dive logs from a file exported by another dive computer's app (browser global `DiveImport`, or CommonJS for tests).
 * Format: UDDF (Universal Dive Data Format), which Shearwater Cloud, Subsurface and most dive-log apps export. SI units:
 * seconds, metres, Kelvin, fractions. The parser is tolerant: it looks elements up by name and ignores what it does not know.
 * Pure functions: the caller passes in a DOMParser (the browser's, or @xmldom/xmldom in tests). */
(function (root) {
  "use strict";
  const MAX_SAMPLES = 1000;                                    // longer profiles are thinned (the max depth is kept exactly)
  const pad = (n) => String(n).padStart(2, "0");

  /** Small synchronous 48-bit hash -> 12 hex chars (same shape as the Cosmiq fingerprint). Stable, so re-importing a file adds nothing. */
  function fingerprint(text) {
    let a = 0x811c9dc5, b = 0x9747b28c;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      a = Math.imul(a ^ c, 0x01000193) >>> 0; b = Math.imul(b ^ c, 0x85ebca6b) >>> 0; b = (b ^ (b >>> 13)) >>> 0;
    }
    return a.toString(16).padStart(8, "0") + (b & 0xffff).toString(16).padStart(4, "0");
  }

  const kids = (node, name) => Array.from(node.getElementsByTagNameNS("*", name));
  const first = (node, name) => { const l = node.getElementsByTagNameNS("*", name); return l.length ? l[0] : null; };
  const val = (node, name) => { const e = node && first(node, name); return e ? (e.textContent || "").trim() : ""; };
  const numOf = (t) => { if (t === "" || t == null) return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
  const celsius = (k) => (k == null ? null : k > 100 ? k - 273.15 : k);          // UDDF says Kelvin; a few exporters write Celsius

  /** "2024-05-01T09:30:15+07:00" -> "2024-05-01T09:30:00" (the clock time shown on the computer; any zone suffix is dropped). */
  function localStart(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(text || "").trim());
    if (!m) return null;
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    return `${m[1]}-${m[2]}-${m[3]}T${pad(h)}:${pad(mi)}:00`;
  }

  function thin(samples) {
    if (samples.length <= MAX_SAMPLES) return samples;
    const stride = Math.ceil(samples.length / MAX_SAMPLES), out = [];
    let deepest = 0; samples.forEach((s, i) => { if (s[1] > samples[deepest][1]) deepest = i; });
    samples.forEach((s, i) => { if (i % stride === 0 || i === deepest || i === samples.length - 1) out.push(s); });
    return out;
  }
  const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

  /**
   * @param {string} xml     file contents
   * @param {string} device  device id the dives belong to ("peregrine")
   * @param {function} DOMParserImpl  constructor with parseFromString (default: the browser's)
   * @returns {{dives: object[], skipped: number, info: string}}  dive records ready to store (no raw bytes)
   */
  function parseUddf(xml, device, DOMParserImpl) {
    const Parser = DOMParserImpl || (typeof DOMParser !== "undefined" ? DOMParser : null);
    if (!Parser) throw new Error("This browser cannot read XML files.");
    let doc;
    try { doc = new Parser().parseFromString(xml, "application/xml"); } catch (e) { throw new Error("That file is not valid XML."); }
    if (!doc || !doc.documentElement || (doc.getElementsByTagName("parsererror").length)) throw new Error("That file is not valid XML.");
    const rootName = doc.documentElement.localName || doc.documentElement.nodeName;
    if (String(rootName).toLowerCase() !== "uddf") throw new Error(`That is not a UDDF dive log (it is a "${rootName}" file). In Shearwater Cloud choose Export → UDDF.`);

    const mixes = new Map();                                                      // gas mixes: id -> O2 percent
    for (const m of kids(doc, "mix")) { const id = m.getAttribute("id"), o2 = numOf(val(m, "o2")); if (id && o2 != null) mixes.set(id, o2 <= 1 ? Math.round(o2 * 100) : Math.round(o2)); }

    const dives = []; let skipped = 0;
    const nodes = kids(doc, "dive");
    for (const dv of nodes) {
      const before = first(dv, "informationbeforedive") || dv;
      const startedAt = localStart(val(before, "datetime") || val(dv, "datetime"));
      const raw = [];                                                              // [t, depth, temp] for waypoints that carry a depth
      let gas = null, lastTemp = null;
      for (const w of kids(dv, "waypoint")) {
        const t = numOf(val(w, "divetime")), depth = numOf(val(w, "depth")), temp = celsius(numOf(val(w, "temperature")));
        if (temp != null) lastTemp = temp;
        if (gas == null) { const sw = first(w, "switchmix"); if (sw && mixes.has(sw.getAttribute("ref"))) gas = mixes.get(sw.getAttribute("ref")); }
        if (t == null || depth == null || depth < -5 || depth > 400) continue;
        raw.push([Math.round(t), Math.max(0, +depth.toFixed(2)), lastTemp == null ? null : +lastTemp.toFixed(1)]);
      }
      raw.sort((a, b) => a[0] - b[0]);
      const after = first(dv, "informationafterdive") || dv;
      const maxFromSamples = raw.reduce((m, s) => Math.max(m, s[1]), 0);
      const maxDepth = numOf(val(after, "greatestdepth")) ?? maxFromSamples;
      const duration = numOf(val(after, "diveduration")) ?? (raw.length ? raw[raw.length - 1][0] : null);
      const temps = raw.map((s) => s[2]).filter((x) => x != null);
      const minTemp = celsius(numOf(val(after, "lowesttemperature"))) ?? (temps.length ? Math.min(...temps) : null);
      if (!startedAt || duration == null || duration < 1 || !(maxDepth > 0 || raw.length)) { skipped++; continue; }
      if (gas == null) { const tl = first(dv, "tankdata"), link = tl && first(tl, "link"); if (link && mixes.has(link.getAttribute("ref"))) gas = mixes.get(link.getAttribute("ref")); }
      const deltas = []; for (let i = 1; i < raw.length; i++) deltas.push(raw[i][0] - raw[i - 1][0]);
      const number = numOf(val(before, "divenumber"));
      dives.push({
        fingerprint: fingerprint(device + "|" + startedAt.slice(0, 16)), device, startedAt, mode: "scuba",
        durationSec: Math.round(duration), maxDepthM: +maxDepth.toFixed(2), o2Percent: gas,
        number: number != null && Number.isInteger(number) && number > 0 ? number : null,
        minTempC: minTemp == null ? null : +minTemp.toFixed(1), intervalSec: median(deltas) || 10,
        samples: thin(raw),
      });
    }
    const info = `${nodes.length} dive${nodes.length === 1 ? "" : "s"} in the file`;
    return { dives, skipped, info };
  }

  const api = { parseUddf, fingerprint, localStart, thin, MAX_SAMPLES };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.DiveImport = api;
})(typeof self !== "undefined" ? self : this);
