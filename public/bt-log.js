/* The Bluetooth download log (browser global `BtLog`, or CommonJS for tests).
 * Every Bluetooth attempt (a download, a "what can the app see?" test, a lab handshake) is written down here as it happens: what was chosen,
 * each step with its time, who answered (serial / firmware / model), the result and the last bytes exchanged. It is kept on this device so a
 * failed attempt can be looked at afterwards, copied, saved as a file or sent to your own account. The newest 25 attempts are kept; the
 * text is plain (never HTML) and capped, so it cannot fill the storage. */
(function (root) {
  "use strict";
  const KEY = "btLog", MAX_ENTRIES = 25, MAX_STEPS = 250, HEAD = 30, TAIL = 120, MAX_CHARS = 150000, STEP_CHARS = 300;
  const store = () => { try { return root.localStorage || null; } catch (e) { return null; } };
  const load = () => { const s = store(); if (!s) return []; try { const a = JSON.parse(s.getItem(KEY) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } };
  function save(list) {
    const s = store(); if (!s) return;
    let a = list.slice(0, MAX_ENTRIES);
    for (;;) { const j = JSON.stringify(a); if (j.length <= MAX_CHARS || a.length <= 1) { try { s.setItem(KEY, j); } catch (e) { /* storage full or blocked: the log is only a convenience */ } return; } a = a.slice(0, a.length - 1); }
  }
  function envInfo() {
    const n = root.navigator || {}, uad = n.userAgentData, all = uad && uad.brands ? uad.brands.filter((b) => !/not.a.brand/i.test(b.brand)) : [], some = all.filter((b) => !/^chromium$/i.test(b.brand)), brands = (some.length ? some : all).map((b) => b.brand + " " + b.version).join(", ");
    return { browser: brands || String(n.userAgent || "").slice(0, 120), system: (uad && uad.platform) || n.platform || "", app: root.APP_VERSION || "", online: n.onLine !== false };
  }
  /** Start an attempt. meta = { kind: "download" | "test" | "handshake", device: "peregrine", model: "Peregrine" }. Returns the handle used to record it. */
  function begin(meta) {
    const t0 = Date.now(), e = { id: t0.toString(36) + Math.floor(Math.random() * 1296).toString(36), at: new Date(t0).toISOString(), kind: meta.kind || "download", device: meta.device || "", model: meta.model || "", env: envInfo(), info: {}, steps: [], trace: [], traceSkipped: 0, outcome: null, ms: 0 };
    let timer = 0;
    const flush = () => { clearTimeout(timer); timer = 0; const list = load().filter((x) => x.id !== e.id); list.unshift(e); save(list); };
    const later = () => { if (!timer) timer = setTimeout(flush, 500); };                     // a long download writes many lines: store at most twice a second
    flush();
    return {
      entry: e,
      step(text) { const t = String(text).replace(/\s+/g, " ").slice(0, STEP_CHARS), last = e.steps[e.steps.length - 1]; if (last && last[1] === t) return; e.steps.push([Date.now() - t0, t]); if (e.steps.length > MAX_STEPS) e.steps.splice(1, 1); later(); },
      trace(line) { e.trace.push("+" + ((Date.now() - t0) / 1000).toFixed(3) + "s " + String(line).slice(0, 160)); if (e.trace.length > HEAD + TAIL) { e.trace.splice(HEAD, 1); e.traceSkipped++; } later(); },
      info(o) { Object.assign(e.info, o); later(); },
      end(ok, text, extra) { e.outcome = { ok: !!ok, text: String(text || "").slice(0, 500), ...(extra || {}) }; e.ms = Date.now() - t0; flush(); },
    };
  }
  const secs = (ms) => (ms / 1000).toFixed(1) + " s";
  const KINDS = { download: "Download", test: "Bluetooth test", handshake: "Handshake" };
  function format(e) {
    const o = e.outcome, out = [`=== ${KINDS[e.kind] || e.kind}: ${e.model || e.device || "?"} ===`, `Time: ${e.at}`, `Computer: ${e.model || "?"} (${e.device || "?"})${e.info && e.info.deviceName ? ', Bluetooth name "' + e.info.deviceName + '"' : ""}`,
      `Browser: ${e.env.browser} | System: ${e.env.system} | App: ${e.env.app}${e.env.online ? "" : " | offline"}`, `Duration: ${e.ms ? secs(e.ms) : "(still running or interrupted)"}`,
      `Result: ${o ? (o.ok ? "OK" : o.cancelled ? "CANCELLED" : "FAILED") + " - " + o.text : "no result (the page was closed or reloaded during the attempt)"}`];
    const i = e.info || {};
    if (i.serial || i.firmware || i.model != null) out.push(`Identity: serial ${i.serial || "?"}, firmware ${i.firmware || "?"}, model number ${i.model == null ? "?" : i.model}${i.model == null ? "" : i.modelName ? " (" + i.modelName + ")" : " (not in the list of known models)"}`);
    if (i.total != null) out.push(`Counts: ${i.total} on the computer, ${i.fresh == null ? "?" : i.fresh} new, ${i.failed || 0} could not be read`);
    out.push("== Steps =="); for (const [t, s] of e.steps) out.push(`  +${(t / 1000).toFixed(2)}s  ${s}`);
    if (e.trace.length) { out.push(`== Bytes exchanged (${e.trace.length + e.traceSkipped} lines${e.traceSkipped ? ", " + e.traceSkipped + " in the middle left out" : ""}; TX = sent, RX = received, NOTE = what it means) ==`); e.trace.forEach((l, k) => { if (k === HEAD && e.traceSkipped) out.push("  ..."); out.push("  " + l); }); }
    return out.join("\n");
  }
  function formatAll(list) { return list.length ? ["Dive Manager Bluetooth download log", "Created: " + new Date().toISOString(), "Attempts: " + list.length, "", ...list.map((e) => format(e) + "\n")].join("\n") : "No Bluetooth attempts recorded on this device yet."; }
  const summary = (e) => { const o = e.outcome; return `${e.at.slice(0, 16).replace("T", " ")}  ${KINDS[e.kind] || e.kind}  ${e.model || e.device}  ${o ? (o.ok ? "OK" : o.cancelled ? "cancelled" : "FAILED") : "interrupted"}${o && o.text ? " - " + o.text.slice(0, 90) : ""}`; };
  const api = { begin, list: load, clear: () => { const s = store(); if (s) { try { s.removeItem(KEY); } catch (e) { /* ignore */ } } }, format, formatAll, summary, KEY, MAX_ENTRIES };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.BtLog = api;
})(typeof self !== "undefined" ? self : this);
