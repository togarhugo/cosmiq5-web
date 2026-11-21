/* Dive log UI: local storage (IndexedDB), device sync, cloud sync, profile chart.
 * Depends on: dive-protocol.js (CosmiqDive) and the BLE helpers in index.html
 * (txChar, log, isConnected). Raw device bytes are the source of truth; everything
 * shown is re-derived from them, so parser fixes apply retroactively. */
"use strict";

const Dives = (() => {
  const P = window.CosmiqDive, U = window.DiveUtils;
  const DB_NAME = "cosmiq", STORE = "dives";
  let dbp = null, busy = false, cloudState = "unknown";
  const failState = (e) => (e && e.status === 401 ? "signedout" : navigator.onLine ? "unavailable" : "offline");

  // ---------- local storage ----------
  function openDb() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "fingerprint" });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  const tx = async (mode, fn) => { const db = await openDb(); return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode), s = t.objectStore(STORE); const out = fn(s);
    t.oncomplete = () => res(out.result); t.onerror = () => rej(t.error); }); };
  const all = () => tx("readonly", (s) => s.getAll());
  const put = (rec) => tx("readwrite", (s) => s.put(rec));

  function toRecord(raw, deviceMac) {
    const d = P.parseDive(P.fromHex(raw.headerHex), P.fromHex(raw.profileHex));
    return { fingerprint: raw.fingerprint, deviceMac: deviceMac || raw.deviceMac || null,
      headerHex: raw.headerHex, profileHex: raw.profileHex, startedAt: d.startedAt, mode: d.mode,
      durationSec: d.durationSec, maxDepthM: +d.maxDepthM.toFixed(2), o2Percent: d.o2Percent,
      uploaded: !!raw.uploaded, location: raw.location || undefined };
  }

  // Imported dives (another computer's log read from a file) have no raw device bytes: they keep decoded values + depth samples.
  const isImported = (r) => !!r.device && r.device !== "cosmiq";
  const IMPORT_BATCH = 8;
  function fromCloudImport(d) {
    let x = {}; try { x = JSON.parse(d.extra || "{}"); } catch (e) {}
    return { fingerprint: d.fingerprint, device: d.device, startedAt: d.startedAt, mode: d.mode, durationSec: d.durationSec, maxDepthM: d.maxDepthM,
      o2Percent: d.o2Percent == null ? null : d.o2Percent, number: x.n == null ? null : x.n, minTempC: x.t == null ? null : x.t, intervalSec: x.iv || 10,
      samples: Array.isArray(x.s) ? x.s : [], headerHex: "", profileHex: "", uploaded: true, location: d.location || undefined };
  }
  function toWire(r) {
    if (!isImported(r)) return r;
    return { fingerprint: r.fingerprint, device: r.device, startedAt: r.startedAt, mode: r.mode, durationSec: r.durationSec, maxDepthM: r.maxDepthM,
      o2Percent: r.o2Percent, headerHex: "", profileHex: "", location: r.location || null, extra: JSON.stringify({ n: r.number, t: r.minTempC, iv: r.intervalSec, s: r.samples }) };
  }

  // ---------- cloud ----------
  async function cloudPull() {
    try {
      const r = await fetch("/api/dives", { credentials: "same-origin", redirect: "error" });
      if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { status: r.status });
      const { dives } = await r.json();
      const local = new Map((await all()).map((d) => [d.fingerprint, d]));
      for (const d of dives) {
        const mine = local.get(d.fingerprint);
        if (!mine) await put(d.device && d.device !== "cosmiq" ? fromCloudImport(d) : { ...toRecord(d), uploaded: true });
        else if (!mine.locDirty && (mine.location || "") !== (d.location || "")) await put({ ...mine, location: d.location || undefined });   // edited on another device
      }
      cloudState = "ok";
    } catch (e) { cloudState = failState(e); }
    await pushLocations();                                                            // retry edits that could not be sent earlier
    render();
  }

  // ---------- locations (free text per dive; edited per date) ----------
  /** map: fingerprint -> text ("" clears). Saved on this phone first, then sent to the cloud. */
  async function setLocations(map) {
    const recs = await all(), known = U.knownLocations(recs);
    for (const r of recs) if (Object.prototype.hasOwnProperty.call(map, r.fingerprint)) {
      const loc = U.normalizeLocation(map[r.fingerprint], known);
      await put({ ...r, location: loc || undefined, locDirty: true });
    }
    render(); await pushLocations(); render();
  }
  async function pushLocations() {
    const dirty = (await all()).filter((r) => r.locDirty && r.uploaded);                // a dive not yet in the cloud is uploaded (with its place) first
    if (!dirty.length) return 0;
    try {
      for (let i = 0; i < dirty.length; i += 100) {
        const batch = dirty.slice(i, i + 100);
        const r = await fetch("/api/dives/location", { method: "POST", credentials: "same-origin", redirect: "error", headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: batch.map((d) => ({ fingerprint: d.fingerprint, location: d.location || null })) }) });
        if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { status: r.status });
        for (const d of batch) await put({ ...d, locDirty: false });
      }
      cloudState = "ok";
    } catch (e) { cloudState = failState(e); }
    return dirty.length;
  }
  async function cloudPush() {
    const pending = (await all()).filter((d) => !d.uploaded);
    let stored = 0;
    try {
      for (let i = 0; i < pending.length; i += IMPORT_BATCH) {
        const batch = pending.slice(i, i + IMPORT_BATCH);
        const r = await fetch("/api/dives", { method: "POST", credentials: "same-origin", redirect: "error",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ dives: batch.map(toWire) }) });
        if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { status: r.status });
        for (const d of batch) await put({ ...d, uploaded: true });
        stored += batch.length;
      }
      cloudState = "ok";
    } catch (e) { cloudState = failState(e); log("Cloud upload failed: " + e.message, "log-err"); }
    return stored;
  }

  // ---------- device sync ----------
  const LAST = "lastSync";
  const saveLast = (o) => { try { localStorage.setItem(LAST, JSON.stringify({ at: new Date().toISOString(), ...o })); } catch (e) {} };
  const loadLast = () => { try { return JSON.parse(localStorage.getItem(LAST) || "null"); } catch (e) { return null; } };

  async function syncFromDevice(io, opts) {
    if (busy) return;
    busy = true; setBusy(true); showBanner(true);
    let saved = 0, info = {}; const savedRecs = [];
    try {
      const known = new Set((await all()).map((d) => d.fingerprint));
      let lastRender = 0;
      const res = await P.readDives(io, known, (m, p) => progress(m, p), async (raw, r) => {
        const rec = toRecord(raw, r.mac); await put(rec); savedRecs.push(rec); saved++;       // saved the moment it arrives
        if (Date.now() - lastRender > 400) { lastRender = Date.now(); render(); }
      }, opts);
      info = { count: res.count, newDives: res.dives.length, skipped: res.skipped, fw: res.firmware, mac: res.mac };
      const up = await cloudPush();
      const msg = `Dive sync done: ${res.count} on device, ${res.dives.length} new, ${res.skipped} already saved` +
        (cloudState === "ok" ? `, ${up} uploaded` : cloudState === "signedout" ? ", NOT uploaded (signed out: reload to sign in)" : ", cloud unavailable (saved on this phone)");
      progress(msg, 1); log(msg, "log-info"); saveLast({ ok: true, msg, ...info });
      if (res.count === 0) log("The dive computer reports 0 dives stored.", "log-info");
    } catch (e) {
      const msg = `Dive sync stopped: ${e.message}` + (saved ? `. ${saved} dive(s) were saved before it stopped, run the sync again to continue.` : "");
      progress(msg, 0); log(msg, "log-err"); saveLast({ ok: false, msg, saved, ...info });
      if (saved) await cloudPush();
    } finally { if (io.end) io.end(); busy = false; setBusy(false); showBanner(false); render(); }
    if (savedRecs.length) openPrompt(savedRecs, "Where did you dive?", `${savedRecs.length} new dive${savedRecs.length === 1 ? "" : "s"}. Just the area, for example Banda, Komodo or Tulamben.`);
    return { saved };
  }

  // ---------- import a log exported from another dive computer's app ----------
  async function importFiles(files, deviceId) {
    const out = $("impMsg"), say2 = (t, bad) => { if (out) { out.textContent = t; out.style.color = bad ? "#c92a2a" : "#2b8a3e"; } };
    if (busy) { say2("Wait for the running sync to finish first.", true); return; }
    busy = true; say2("Reading\u2026");
    const fresh = [], seen = new Set((await all()).map((d) => d.fingerprint)); let already = 0, skipped = 0, found = 0; const problems = [];
    try {
      for (const f of files) {
        if (f.size > 80_000_000) { problems.push(`${f.name}: too large (${Math.round(f.size / 1e6)} MB, limit 80 MB)`); continue; }
        try {
          const res = window.DiveImport.parseUddf(await f.text(), deviceId);
          found += res.dives.length; skipped += res.skipped;
          if (!res.dives.length) problems.push(`${f.name}: no dives found (${res.info})`);
          for (const d of res.dives) {
            if (seen.has(d.fingerprint)) { already++; continue; }
            seen.add(d.fingerprint); const rec = { ...d, headerHex: "", profileHex: "", uploaded: false }; await put(rec); fresh.push(rec);
          }
        } catch (e) { problems.push(`${f.name}: ${e.message}`); }
        render();
      }
      const up = fresh.length ? await cloudPush() : 0;
      const parts = [`${fresh.length} new dive${fresh.length === 1 ? "" : "s"} imported`];
      if (already) parts.push(`${already} already there`); if (skipped) parts.push(`${skipped} skipped (incomplete)`);
      if (fresh.length) parts.push(cloudState === "ok" ? `${up} uploaded` : "saved on this phone, cloud unavailable");
      say2(parts.join(", ") + "." + (problems.length ? " " + problems.join(" ") : ""), !fresh.length && !!problems.length);
      if (fresh.length) say(`${fresh.length} dive${fresh.length === 1 ? "" : "s"} imported`);
    } finally { busy = false; render(); }
    if (fresh.length) openPrompt(fresh, "Where did you dive?", `${fresh.length} imported dive${fresh.length === 1 ? "" : "s"}. Just the area, for example Banda, Komodo or Tulamben.`);
    return { imported: fresh.length, already, skipped, found };
  }

  // ---------- UI ----------
  const $ = (id) => document.getElementById(id);
  const fmtDur = (s) => s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`;
  const fmtDate = (iso) => { const [d, t] = iso.split("T"); return `${d} ${t.slice(0, 5)}`; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function progress(msg, frac) {
    for (const [t, b] of [["diveProgress", "diveBar"], ["bannerText", "bannerBar"]]) { const el = $(t); if (el) { el.textContent = msg; $(b).style.width = Math.round(frac * 100) + "%"; } }
  }
  function showBanner(on) { const el = $("syncBanner"); if (el) el.style.display = on ? "block" : "none"; }
  function setBusy(b) { const el = $("diveSyncBtn"); if (el) el.disabled = b; }

  /** Depth profile with a grid: horizontal lines at round depths, vertical lines at round minutes.
   *  `missing` = samples the device no longer had: the axis keeps the full dive length and the gap is shown. */
  function chart(d, missing = 0) {
    const s = d.samples; if (s.length < 2) return "<p class='muted'>No profile samples.</p>";
    const W = 340, H = 190, pl = 40, pr = 10, pt = 10, pb = 24;
    const lastT = s[s.length - 1].t, maxT = lastT + missing * d.sampleIntervalSec, deepest = Math.max(1, ...s.map((x) => x.depthM));
    const ax = U.niceAxis(deepest, 5), maxD = ax.max, tk = U.timeTicks(maxT);
    const X = (t) => pl + (t / maxT) * (W - pl - pr), Y = (m) => pt + (Math.max(0, m) / maxD) * (H - pt - pb);
    const pts = [[0, 0], ...s.map((x) => [x.t, x.depthM])].map(([t, m]) => `${X(t).toFixed(1)},${Y(m).toFixed(1)}`).join(" ");
    let grid = "";
    for (let m = 0; m <= maxD + 1e-9; m += ax.step)
      grid += `<line x1="${pl}" y1="${Y(m).toFixed(1)}" x2="${W - pr}" y2="${Y(m).toFixed(1)}" stroke="${m === 0 ? "#adb5bd" : "#dee2e6"}" stroke-width="${m === 0 ? 1 : 0.8}"/>` +
        `<text x="${pl - 5}" y="${(Y(m) + 3).toFixed(1)}" font-size="10" fill="#6c757d" text-anchor="end">${m}${m === 0 ? " m" : ""}</text>`;
    for (const t of tk.ticks)
      grid += `<line x1="${X(t).toFixed(1)}" y1="${pt}" x2="${X(t).toFixed(1)}" y2="${H - pb}" stroke="#e9ecef" stroke-width="0.8"/>` +
        `<text x="${X(t).toFixed(1)}" y="${H - 8}" font-size="10" fill="#6c757d" text-anchor="middle">${Math.round(t / 60)}</text>`;
    const gap = missing ? `<rect x="${X(lastT).toFixed(1)}" y="${pt}" width="${(X(maxT) - X(lastT)).toFixed(1)}" height="${H - pt - pb}" fill="#adb5bd" opacity=".25"/>
      <text x="${((X(lastT) + X(maxT)) / 2).toFixed(1)}" y="${(pt + (H - pt - pb) / 2).toFixed(1)}" font-size="8" fill="#6c757d" text-anchor="middle">not</text>
      <text x="${((X(lastT) + X(maxT)) / 2).toFixed(1)}" y="${(pt + (H - pt - pb) / 2 + 10).toFixed(1)}" font-size="8" fill="#6c757d" text-anchor="middle">recovered</text>` : "";
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Depth profile, gridlines every ${ax.step} m and ${Math.round(tk.step / 60)} min">
      ${grid}${gap}
      <line x1="${pl}" y1="${pt}" x2="${pl}" y2="${H - pb}" stroke="#adb5bd"/>
      <polygon fill="rgba(0,123,255,.15)" points="${pts} ${X(lastT).toFixed(1)},${Y(0).toFixed(1)}"/>
      <polyline fill="none" stroke="#007bff" stroke-width="2" stroke-linejoin="round" points="${pts}"/>
      <text x="${pl}" y="${H - 8}" font-size="10" fill="#6c757d" text-anchor="middle">0</text>
      <text x="${W - pr}" y="${H - 8}" font-size="10" fill="#6c757d" text-anchor="end">${fmtDur(maxT)}</text></svg>`;
  }

  // Layout of the 36-byte dive header. Fields come from libdivecomputer's Cosmiq parser plus our own decoding of a real
  // device's log; bytes still marked "unknown" are shown raw so new meanings can be spotted.
  const HEADER_MAP = [[0, 2, "dive number (the device's own count)"], [2, 1, "mode (2 scuba, 3 gauge, 4 freedive)"], [3, 1, "O\u2082 %"],
    [4, 2, "surface pressure (low 13 bits, mbar) + 3 flag bits"], [6, 2, "year"], [8, 1, "day"], [9, 1, "month"], [10, 1, "minute"], [11, 1, "hour"],
    [12, 2, "duration"], [14, 8, "unknown (settings-like constants)"], [22, 2, "max depth (raw pressure, mbar)"], [24, 2, "minimum temperature (0.1 \u00b0C)"],
    [26, 1, "sample interval (s)"], [27, 1, "unknown"], [28, 2, "number of profile samples"], [30, 2, "profile start page"], [32, 2, "profile end page"], [34, 2, "unknown (16-bit value, not a CRC we recognise)"]];
  const STATUS_TEXT = {
    ok: "",
    truncated: (m, iv) => `The last ${m} sample${m === 1 ? "" : "s"} (about ${Math.max(1, Math.round(m * iv / 60))} min) of this depth profile could not be recovered: the device had already overwritten them. The summary figures above come from the dive header and are complete.`,
    overwritten: () => "This dive's depth profile no longer exists on the device. Its profile memory is a ring that keeps roughly the last 128 dives, and newer dives overwrote this one. The summary (depth, time, temperature) is intact.",
    empty: () => "The device returned no depth data for this dive.",
  };
  const BADGE = { truncated: "partial profile", overwritten: "summary only", empty: "no profile" };

  function techDetails(rec, res) {
    const h = P.fromHex(rec.headerHex);
    const rows = HEADER_MAP.map(([o, n, name]) => {
      const bytes = P.toHex(h.slice(o, o + n)).match(/../g).join(" ");
      const unk = name.startsWith("unknown");
      return `<tr${unk ? ' class="unk"' : ""}><td>${o}${n > 1 ? "\u2013" + (o + n - 1) : ""}</td><td>${bytes}</td><td>${esc(name)}</td></tr>`;
    }).join("");
    const from = res.from && res.from !== rec.fingerprint ? " Recovered from the bytes the device returned under an older dive's number (the profile memory wrapped around)." : "";
    return `<details class="tech"><summary>Technical details</summary>
      <p class="muted">Location: this dive computer's log has no location (GPS) field. Every header byte is a dive statistic, a memory pointer, or an unknown setting-like value (amber); none looks like coordinates.</p>
      <table class="hdr">${rows}</table>
      <p class="muted">Profile: ${esc(res.status)}, ${res.profileHex.length / 2} bytes.${from} Fingerprint ${esc(rec.fingerprint)}.</p></details>`;
  }

  const fmtGap = (min) => (min < 90 ? `${Math.max(0, Math.round(min))} min` : min < 2880 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.floor(min / 1440)} d ${Math.round((min % 1440) / 60)} h`);
  const asMs = (iso) => { const [d, t] = iso.split("T"); const [y, mo, da] = d.split("-").map(Number), [h, mi] = t.split(":").map(Number); return Date.UTC(y, mo - 1, da, h, mi); };

  const numBox = (n) => `<span class="dive-num">${esc(n)}</span>`;
  const deviceName = (id) => (U.DEVICES.find((x) => x.id === id) || { name: id }).name;
  /** Detail of an imported dive: values and samples come from the file, there are no raw device bytes to show. */
  function detailImported(rec, num, gapBefore) {
    const sm = (rec.samples || []).map(([t, depthM, tempC]) => ({ t, depthM, tempC })), depths = sm.map((x) => x.depthM).filter((m) => m > 0.3);
    const avg = depths.length ? (depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(1) + " m" : "\u2013";
    return `${locEditor(rec)}${chart({ samples: sm, sampleIntervalSec: rec.intervalSec || 10 })}<div class="stats">
      <div><b>${rec.maxDepthM.toFixed(1)} m</b><span>max depth</span></div>
      <div><b>${fmtDur(rec.durationSec)}</b><span>duration</span></div>
      <div><b>${rec.minTempC != null ? rec.minTempC.toFixed(1) + " \u00b0C" : "\u2013"}</b><span>min temp</span></div>
      <div><b>${rec.o2Percent != null ? rec.o2Percent + "%" : "\u2013"}</b><span>O\u2082</span></div></div>
      <div class="stats">
      <div><b class="numtile">${esc(num)}</b><span>dive number</span></div>
      <div><b>${avg}</b><span>avg depth</span></div>
      <div><b>${gapBefore == null ? "\u2013" : fmtGap(gapBefore)}</b><span>since last dive</span></div>
      <div><b>${rec.intervalSec || 10} s</b><span>sample every</span></div></div>
      <p class="muted">Imported from a file exported from the ${esc(deviceName(rec.device))} app: ${sm.length} depth sample${sm.length === 1 ? "" : "s"}. The numbers are the ones in that file.</p>`;
  }

  function detail(rec, res, gapBefore, num) {
    if (isImported(rec)) return detailImported(rec, num, gapBefore);
    const d = P.parseDive(P.fromHex(rec.headerHex), P.fromHex(res.profileHex));
    const usable = res.status === "ok" || res.status === "truncated";
    const depths = d.samples.map((x) => x.depthM).filter((m) => m > 0.3);
    const avg = depths.length ? (depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(1) + " m" : "\u2013";
    const note = STATUS_TEXT[res.status] ? STATUS_TEXT[res.status](res.missing, d.sampleIntervalSec) : "";
    return `${locEditor(rec)}${usable ? chart(d, res.status === "truncated" ? res.missing : 0) : ""}${note ? `<p class="note">${esc(note)}</p>` : ""}<div class="stats">
      <div><b>${d.maxDepthM.toFixed(1)} m</b><span>max depth</span></div>
      <div><b>${fmtDur(d.durationSec)}</b><span>duration</span></div>
      <div><b>${d.minTempC.toFixed(1)} \u00b0C</b><span>min temp</span></div>
      <div><b>${d.o2Percent != null ? d.o2Percent + "%" : "\u2013"}</b><span>O\u2082</span></div></div>
      <div class="stats">
      <div><b class="numtile">${d.number}</b><span>dive number</span></div>
      <div><b>${usable ? avg : "\u2013"}</b><span>avg depth</span></div>
      <div><b>${gapBefore == null ? "\u2013" : fmtGap(gapBefore)}</b><span>since last dive</span></div>
      <div><b>${d.atmosphericMbar}</b><span>surface mbar</span></div></div>
      <p class="muted">Depth assumes seawater (1025 kg/m\u00b3) like the device.${usable ? ` ${d.samples.length} sample${d.samples.length === 1 ? "" : "s"}, every ${d.sampleIntervalSec}s.` : ""}</p>${techDetails(rec, res)}`;
  }

  const YEARS_KEY = "yearsOpen";
  const loadYears = () => { try { return JSON.parse(localStorage.getItem(YEARS_KEY) || "null"); } catch (e) { return null; } };
  const say = (t, kind) => { if (window.toast) window.toast(t, kind || "ok"); };
  const dayOf = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtDayShort = (key) => dayOf(key).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const fmtDayLong = (key) => dayOf(key).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // ---------- summary page ----------
  function renderSummary(recs) {
    if (!$("sumHours")) return;
    const sm = U.summarize(recs, new Date());
    $("sumEmpty").style.display = sm.count ? "none" : "";
    $("sumCards").style.display = sm.count ? "" : "none";
    if (!sm.count) return;
    $("sumLastDate").textContent = fmtDayLong(sm.last.date);
    $("sumLastSub").textContent = [U.agoText(sm.last.daysAgo), sm.last.location && "\ud83d\udccd " + sm.last.location].filter(Boolean).join(" \u00b7 ");
    $("sumHours").textContent = U.hoursText(sm.totalSec);
    $("sumCount").textContent = `across ${sm.count} dive${sm.count === 1 ? "" : "s"}`;
  }
  /** Top of the Summary: your name, latest certification, DAN membership and how long it is valid (green / orange within 60 days / red when expired). */
  function renderDiverCard() {
    const card = $("sumDiver"); if (!card) return;
    const d = typeof AccountArea !== "undefined" ? AccountArea.diver() : null; if (!d) { card.style.display = "none"; return; }
    const day = (k) => { const [y, m, dd] = k.split("-").map(Number); return new Date(y, m - 1, dd).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); };
    card.style.display = "";
    $("sumName").textContent = d.name || "Your name"; $("sumName").style.color = d.name ? "" : "#868e96";
    const c = d.latestCert;
    $("sumCert").textContent = c ? c.label : "None added yet";
    $("sumCertSub").textContent = c ? [c.number && "#" + c.number, c.certifiedOn && day(c.certifiedOn)].filter(Boolean).join(" \u00b7 ") : "Add one in Account \u203a Dive certifications";
    const dan = d.dan || {}, st = U.danStatus(dan.validUntil, new Date()), row = $("sumDanRow");
    row.className = "diver-row dan-" + (dan.number ? (st.state === "none" ? "none" : st.state) : "none");
    if (!dan.number) { $("sumDan").textContent = "Not added yet"; $("sumDanValid").textContent = "Add it in Account \u203a DAN insurance"; $("sumDanValid").style.fontWeight = "400"; return; }
    $("sumDan").textContent = ["#" + dan.number, dan.plan].filter(Boolean).join(" \u00b7 "); $("sumDanValid").style.fontWeight = "";
    $("sumDanValid").textContent = st.state === "none" ? "No validity date set"
      : st.state === "expired" ? `Expired ${day(dan.validUntil)} \u00b7 ${st.days === -1 ? "yesterday" : -st.days + " days ago"}` : `Valid until ${day(dan.validUntil)} \u00b7 ${U.danText(st.days)}`;
  }
  /** Regulator service card: green below 70 dives, orange from 70, red from 90. */
  function renderRegulatorCard(recs) {
    const card = $("sumReg"); if (!card) return;
    const reg = typeof AccountArea !== "undefined" ? AccountArea.regulator() : null;
    $("sumRegHint").style.display = reg ? "none" : "";
    card.style.display = reg ? "" : "none"; if (!reg) return;
    const n = U.regulatorCount(reg, recs), lvl = U.regulatorLevel(n);
    card.className = "card sum reg-" + lvl; card.setAttribute("role", lvl === "ok" ? "button" : "alert");
    $("sumRegCount").textContent = n; $("sumRegName").textContent = [reg.name, reg.type].filter(Boolean).join(" \u00b7 ");
    $("sumRegBar").style.width = Math.min(100, (n / U.REG_RED) * 100) + "%";
    $("sumRegMsg").textContent = lvl === "red" ? `Service now: ${n} dives, the ${U.REG_RED}-dive limit is reached`
      : lvl === "orange" ? `Service soon: ${U.REG_RED - n} dive${U.REG_RED - n === 1 ? "" : "s"} to the ${U.REG_RED}-dive limit` : `Service is due at ${U.REG_ORANGE} dives (${U.REG_ORANGE - n} to go)`;
  }

  // ---------- locations: the question after a sync, the banner, date headers, per-dive field ----------
  const locEditor = (rec) => `<div class="loc1"><span aria-hidden="true">\ud83d\udccd</span><input class="dive-loc" list="locList" maxlength="60" autocomplete="off" placeholder="Location, e.g. Komodo" value="${esc(rec.location || "")}" aria-label="Dive location"><button class="btn-set dive-loc-save" type="button" data-fp="${esc(rec.fingerprint)}">Save</button></div>`;
  async function fillSuggestions() { const known = U.knownLocations(await all()); $("locList").innerHTML = known.map((k) => `<option value="${esc(k)}">`).join(""); return known; }

  /** Ask for the area of each date among `targets`. One row per date; "same as above" copies the row before it. */
  async function openPrompt(targets, heading, sub) {
    const el = $("locPrompt"); if (!el) return;
    const recs = await all(), asks = U.locationAsks(targets.map((t) => recs.find((r) => r.fingerprint === t.fingerprint) || t), recs);
    if (!asks.length) { el.style.display = "none"; return; }
    const known = await fillSuggestions();
    const hint = (sub || "Just the area, for example Banda, Komodo or Tulamben.") + (asks.length > 1 ? " Tap \u201c\u2191 same\u201d to repeat the place above." : "");
    let idx = 0; const monthName = (k) => new Date(+k.slice(0, 4), +k.slice(5) - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const groups = U.asksByMonth(asks);
    el.innerHTML = `<h3>${esc(heading)}</h3><p class="muted" style="margin:0 0 10px">${esc(hint)}</p><div class="locrows">` +
      groups.map((g) => (g.asks.length > 1 ? `<div class="monthask"><label for="locM${esc(g.month)}">${esc(monthName(g.month))} \u00b7 ${g.asks.length} dates</label><input id="locM${esc(g.month)}" class="month-in" data-month="${esc(g.month)}" list="locList" maxlength="60" autocomplete="off" placeholder="Same place for the whole month" style="width:100%;box-sizing:border-box">` : `<div class="monthask" style="background:none;padding:0 0 4px">`) +
        g.asks.map((a) => { const i = idx++; a.i = i;
          return `<div class="locask"><label for="locIn${i}">${esc(fmtDayLong(a.date))} <span class="muted">\u00b7 ${a.count} dive${a.count === 1 ? "" : "s"}</span></label>
          <div class="row" style="margin:6px 0 10px"><input id="locIn${i}" data-i="${i}" list="locList" maxlength="60" autocomplete="off" placeholder="e.g. Komodo" value="${esc(a.prefill)}">${i ? `<button class="btn-set same" type="button" data-i="${i}" title="Use the place above">\u2191 same</button>` : ""}</div></div>`; }).join("") + `</div>`).join("") +
      `</div><div class="row" style="margin:0"><button id="locSave" class="btn-set" type="button">Save</button><button id="locLater" class="btn-set" type="button" style="background:#6c757d">Later</button></div>`;
    el.style.display = "block"; updateBanner(recs); el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.onclick = async (e) => {
      const same = e.target.closest(".same");
      if (same) { const i = +same.dataset.i; $("locIn" + i).value = $("locIn" + (i - 1)).value; return; }
      if (e.target.id === "locLater") { el.style.display = "none"; updateBanner(await all()); return; }
      if (e.target.id !== "locSave") return;
      const map = {}; let n = 0;
      asks.forEach((a) => {                                                           // a date's own entry wins; otherwise its month's place applies
        const month = el.querySelector(`.month-in[data-month="${a.date.slice(0, 7)}"]`);
        const v = U.normalizeLocation($("locIn" + a.i).value || (month ? month.value : ""), known);
        if (v) { a.fps.forEach((fp) => { map[fp] = v; }); n += a.fps.length; }
      });
      el.style.display = "none";
      if (n) { await setLocations(map); say(`Location saved for ${n} dive${n === 1 ? "" : "s"}`); } else updateBanner(await all());
    };
    const first = el.querySelector("input:not([value=''])") || el.querySelector("input"); if (first && !first.value) first.focus({ preventScroll: true });
  }
  function revealPrompt() { const el = $("locPrompt"); if (el && el.style.display !== "none") el.scrollIntoView({ block: "start" }); }
  function updateBanner(recs) {
    const b = $("locBanner"); if (!b) return;
    const missing = recs.filter((r) => !r.location);
    const promptOpen = $("locPrompt") && $("locPrompt").style.display !== "none";
    b.style.display = missing.length && !promptOpen ? "flex" : "none";
    $("locBannerText").textContent = `${missing.length} dive${missing.length === 1 ? " has" : "s have"} no location`;
    $("locBannerBtn").onclick = () => openPrompt(missing, "Add dive locations", "Just the area, for example Banda, Komodo or Tulamben.");
  }

  // ---------- one dive log per dive computer ----------
  const DEV_KEY = "logDevice";
  let selDevice = (() => { try { return localStorage.getItem(DEV_KEY); } catch (e) { return null; } })();
  /** Draws the computer selector, shows the matching sync / import card, and returns the computer being shown. */
  function renderDeviceTabs(recs) {
    const ids = U.DEVICES.map((x) => x.id);
    if (!ids.includes(selDevice)) selDevice = recs.length ? U.deviceOf(recs[0]) : "cosmiq";           // newest dive's computer
    const box = $("devTabs");
    if (box) box.innerHTML = U.DEVICES.map((x) => { const n = recs.filter((r) => U.deviceOf(r) === x.id).length;
      return `<button type="button" role="tab" aria-selected="${x.id === selDevice}" class="${x.id === selDevice ? "active" : ""}" data-dev="${x.id}">${esc(x.name)}<span class="muted"> \u00b7 ${n}</span></button>`; }).join("");
    const sync = $("syncCard"), imp = $("importCard");
    if (sync) sync.style.display = selDevice === "cosmiq" ? "" : "none";
    if (imp) { imp.style.display = selDevice === "cosmiq" ? "none" : ""; const t = $("impTitle"); if (t) t.textContent = "Import from " + deviceName(selDevice); }
    return selDevice;
  }
  function pickDevice(id) { selDevice = id; try { localStorage.setItem(DEV_KEY, id); } catch (e) {} const m = $("impMsg"); if (m) m.textContent = ""; render(); }

  let renderPending = false, wired = false;
  function wireList(list) {
    if (wired) return; wired = true;
    $("devTabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-dev]"); if (b) pickDevice(b.dataset.dev); });
    const pick = $("impFile");
    if (pick) pick.addEventListener("change", async (e) => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) await importFiles(fs, selDevice); });
    list.addEventListener("click", async (e) => {
      const head = e.target.closest(".dh-loc");
      if (head) {                                                                // swap the chip for an editor
        const date = head.dataset.date, cur = head.classList.contains("empty") || head.dataset.mixed ? "" : head.dataset.loc || "";
        await fillSuggestions();
        const span = document.createElement("span"); span.className = "dh-edit";
        span.innerHTML = `<input list="locList" maxlength="60" autocomplete="off" placeholder="e.g. Komodo" value="${esc(cur)}" aria-label="Location for ${esc(date)}"><button class="btn-set dh-save" type="button" data-date="${esc(date)}">Save</button><button class="btn-set dh-cancel" type="button" style="background:#6c757d" aria-label="Cancel">\u2715</button>`;
        head.replaceWith(span); span.querySelector("input").focus(); return;
      }
      const mset = e.target.closest(".mh-set");
      if (mset) {                                                                // bulk: one place for every dive of the month
        await fillSuggestions();
        const month = mset.dataset.month, n = (await all()).filter((r) => U.monthKey(r) === month).length, box = document.createElement("div"); box.className = "mh-edit";
        box.innerHTML = `<input type="text" list="locList" maxlength="60" autocomplete="off" placeholder="One place for all ${n} dives, e.g. Komodo" aria-label="Place for the whole month">
          <label class="chk"><input type="checkbox" class="mh-replace"> Replace places that are already set</label>
          <div class="row" style="margin:0"><button class="btn-set mh-save" type="button" data-month="${esc(month)}">Apply to the month</button><button class="btn-set dh-cancel" type="button" style="background:#6c757d">Cancel</button></div>`;
        mset.parentElement.appendChild(box); mset.style.display = "none"; box.querySelector("input[type=text]").focus(); return;
      }
      const msave = e.target.closest(".mh-save");
      if (msave) {
        const box = msave.closest(".mh-edit"), v = U.normalizeLocation(box.querySelector("input[type=text]").value), replace = box.querySelector(".mh-replace").checked;
        if (!v) { say("Type a place first", "warn"); return; }
        const targets = U.bulkTargets((await all()).filter((r) => U.monthKey(r) === msave.dataset.month), replace);
        if (!targets.length) { say("Every dive this month already has a place. Tick \u201cReplace\u201d to change them.", "warn"); return; }
        await setLocations(Object.fromEntries(targets.map((fp) => [fp, v]))); say(`Location saved for ${targets.length} dive${targets.length === 1 ? "" : "s"}`); return;
      }
      if (e.target.closest(".dh-cancel")) { renderPending = false; render(); return; }
      const dsave = e.target.closest(".dh-save");
      if (dsave) {
        const date = dsave.dataset.date, v = dsave.parentElement.querySelector("input").value, rs = (await all()).filter((r) => U.dateKey(r) === date);
        await setLocations(Object.fromEntries(rs.map((r) => [r.fingerprint, v]))); say(U.normalizeLocation(v) ? "Location saved" : "Location cleared"); return;
      }
      const vsave = e.target.closest(".dive-loc-save");
      if (vsave) { await setLocations({ [vsave.dataset.fp]: vsave.parentElement.querySelector("input").value }); say("Location saved"); }
    });
    list.addEventListener("keydown", (e) => {
      if (e.target.tagName !== "INPUT") return;
      if (e.target.type === "checkbox") return;
      if (e.key === "Enter") { const b = (e.target.closest(".mh-edit") || e.target.parentElement).querySelector("button.btn-set"); if (b) b.click(); }
      if (e.key === "Escape" && e.target.closest(".dh-edit, .mh-edit")) { renderPending = false; render(); }
    });
    document.addEventListener("focusout", () => { if (renderPending) { renderPending = false; setTimeout(render, 60); } });
  }

  async function render() {
    const list = $("diveList"); if (!list) return;
    const everything = (await all()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    $("diveCount").textContent = everything.length ? `(${everything.length})` : "";
    renderSummary(everything); renderDiverCard(); renderRegulatorCard(everything); updateBanner(everything); wireList(list);
    const dev = renderDeviceTabs(everything), recs = everything.filter((r) => U.deviceOf(r) === dev), numbers = U.diveNumbers(recs);
    const last = loadLast(), ls = $("lastSync");
    if (ls) { ls.textContent = last ? `Last sync ${new Date(last.at).toLocaleString()}: ${last.msg}` : "No sync yet on this phone."; ls.style.color = last && !last.ok ? "#c92a2a" : ""; }
    const cloudTxt = { ok: "\u2601 synced to cloud", unavailable: "\u2601 cloud unavailable", offline: "offline", signedout: "\ud83d\udd12 signed out: reload the page to sign in again", unknown: "" }[cloudState];
    $("cloudState").textContent = cloudTxt;
    if (!recs.length) { list.innerHTML = dev === "cosmiq" ? "<p class='muted'>No Cosmiq+ dives yet. Tap <b>Sync dives</b> with your dive computer on.</p>" : `<p class='muted'>No ${esc(deviceName(dev))} dives yet. Export your log from its app as UDDF and choose the file above.</p>`; return; }
    const ae = document.activeElement;                                              // never rebuild the list under someone who is typing
    if (ae && ae.tagName === "INPUT" && (list.contains(ae) || ($("locPrompt") && $("locPrompt").contains(ae)))) { renderPending = true; return; }

    const resolved = dev === "cosmiq" ? P.reconcileProfiles(recs) : Object.fromEntries(recs.map((r) => [r.fingerprint, { status: "ok" }]));   // which profile really belongs to which dive (imports are complete)
    const asc = recs.slice().reverse(), gapBefore = new Map();
    asc.forEach((r, i) => { if (i) gapBefore.set(r.fingerprint, (asMs(r.startedAt) - (asMs(asc[i - 1].startedAt) + asc[i - 1].durationSec * 1000)) / 60000); });

    const byYear = new Map();
    for (const r of recs) { const y = r.startedAt.slice(0, 4); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(r); }
    const years = [...byYear.keys()];                                                // newest first
    const openNow = list.querySelector("details.year") ? new Set([...list.querySelectorAll("details.year[open]")].map((e) => e.dataset.year)) : null;
    const openDives = new Set([...list.querySelectorAll("details.dive[open]")].map((e) => e.dataset.fp));
    const saved = loadYears(), open = openNow || new Set(saved || [years[0]]);

    const full = recs.filter((r) => resolved[r.fingerprint].status === "ok").length;
    const summaryOnly = recs.filter((r) => ["overwritten", "empty"].includes(resolved[r.fingerprint].status)).length, partial = recs.length - full - summaryOnly;
    const rowHtml = (r) => {
      const st = resolved[r.fingerprint].status, num = numbers.get(r.fingerprint);
      return `<details class="dive" data-fp="${esc(r.fingerprint)}"><summary>
        ${numBox(num)}<span class="dive-date">${esc(fmtDate(r.startedAt).slice(11))}</span>
        <span class="dive-mode m-${esc(r.mode)}">${esc(r.mode)}</span>${BADGE[st] ? `<span class="badge">${BADGE[st]}</span>` : ""}
        <span class="dive-meta">${r.maxDepthM.toFixed(1)} m \u00b7 ${fmtDur(r.durationSec)}${r.uploaded ? "" : " \u00b7 \u23f3"}</span></summary>
        <div class="dive-body"></div></details>`;
    };
    let html = `<p class="muted" style="margin:0 0 8px">${recs.length} dive${recs.length === 1 ? "" : "s"}${dev === "cosmiq" ? ` \u00b7 ${full} with full depth profile` +
      `${partial ? ` \u00b7 ${partial} partial` : ""}${summaryOnly ? ` \u00b7 ${summaryOnly} summary only` : ""}` : ""}</p>`;
    for (const y of years) {
      const g = byYear.get(y), secs = g.reduce((a, r) => a + r.durationSec, 0), deepest = Math.max(...g.map((r) => r.maxDepthM));
      html += `<details class="year" data-year="${y}"${open.has(y) ? " open" : ""}><summary><b>${y}</b><span class="muted"> \u00b7 ${g.length} dive${g.length === 1 ? "" : "s"} \u00b7 ${fmtDur(secs)} \u00b7 max ${deepest.toFixed(1)} m</span></summary>` +
        U.groupByMonth(g).map(({ month, recs: mrs }) => {
          const names = [...new Set(mrs.map((r) => r.location).filter(Boolean))];
          const head = `<div class="monthhead" data-month="${esc(month)}"><span class="mh-name">${esc(new Date(+month.slice(0, 4), +month.slice(5) - 1, 1).toLocaleDateString(undefined, { month: "long" }))}<span class="muted" style="font-weight:400"> \u00b7 ${mrs.length} dive${mrs.length === 1 ? "" : "s"}${names.length ? " \u00b7 " + esc(names.join(", ")) : ""}</span></span><button class="mh-set" type="button" data-month="${esc(month)}">Set place for the month</button></div>`;
          return head + U.groupByDate(mrs).map(({ date, recs: rs }) => {
            const dl = U.dateLocation(rs), label = dl.mixed ? "Mixed" : dl.location || "Add location";
            return `<div class="datehead"><span class="dh-date">${esc(fmtDayShort(date))}</span><button class="dh-loc${dl.location || dl.mixed ? "" : " empty"}" type="button" data-date="${esc(date)}" data-loc="${esc(dl.location)}"${dl.mixed ? ' data-mixed="1"' : ""}>\ud83d\udccd ${esc(label)}</button></div>` + rs.map(rowHtml).join("");
          }).join("");
        }).join("") + `</details>`;
    }
    list.innerHTML = html; fillSuggestions();
    list.querySelectorAll("details.year").forEach((el) => el.addEventListener("toggle", () => {
      try { localStorage.setItem(YEARS_KEY, JSON.stringify([...list.querySelectorAll("details.year[open]")].map((e) => e.dataset.year))); } catch (e) {}
    }));
    list.querySelectorAll("details.dive").forEach((el) => el.addEventListener("toggle", async () => {
      if (!el.open || el.dataset.done) return;
      const rec = recs.find((r) => r.fingerprint === el.dataset.fp);
      try { el.querySelector(".dive-body").innerHTML = detail(rec, resolved[rec.fingerprint], gapBefore.get(rec.fingerprint) ?? null, numbers.get(rec.fingerprint)); el.dataset.done = 1; }
      catch (e) { el.querySelector(".dive-body").textContent = "Cannot parse this dive: " + e.message; }
    }));
    list.querySelectorAll("details.dive").forEach((el) => { if (openDives.has(el.dataset.fp)) el.open = true; });     // keep what you had open
  }

  async function exportBackup() {
    const recs = await all();
    const blob = new Blob([JSON.stringify({ app: "cosmiq-manager", exportedAt: new Date().toISOString(),
      dives: recs.map((r) => isImported(r) ? { fingerprint: r.fingerprint, device: r.device, startedAt: r.startedAt, mode: r.mode, durationSec: r.durationSec, maxDepthM: r.maxDepthM, o2Percent: r.o2Percent, number: r.number, minTempC: r.minTempC, intervalSec: r.intervalSec, samples: r.samples, location: r.location }
        : { fingerprint: r.fingerprint, deviceMac: r.deviceMac, headerHex: r.headerHex, profileHex: r.profileHex, location: r.location }) }, null, 1)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `cosmiq-dives-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function diagnosticsText() {
    const recs = await all(), last = loadLast(), lines = (window.__diag || []);
    const hdr = [`Dive Manager diagnostics`, `app version: ${self.APP_VERSION || "?"}`, `time: ${new Date().toString()}`,
      `user agent: ${navigator.userAgent}`, `web bluetooth: ${!!navigator.bluetooth}`, `secure context: ${window.isSecureContext}`,
      `last sync: ${JSON.stringify(last)}`, `dives stored on this phone: ${recs.length}`, `cloud: ${cloudState}`, ""];
    const dv = recs.slice(0, 60).map((r) => isImported(r) ? `dive ${r.startedAt} ${r.mode} ${r.durationSec}s ${r.maxDepthM}m device=${r.device} samples=${(r.samples || []).length}` : `dive ${r.startedAt} ${r.mode} ${r.durationSec}s ${r.maxDepthM}m header=${r.headerHex} profileBytes=${r.profileHex.length / 2}`);
    return hdr.concat(["--- stored dives (headers) ---"], dv, ["", `--- activity log (last ${lines.length} lines) ---`], lines).join("\n");
  }
  async function copyDiagnostics() {
    const text = await diagnosticsText();
    try { await navigator.clipboard.writeText(text); return "Copied. Paste it into a message."; }
    catch (e) { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch (e2) {} ta.remove(); return ok ? "Copied. Paste it into a message." : "Could not copy: use Download instead."; }
  }
  async function downloadDiagnostics() {
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([await diagnosticsText()], { type: "text/plain" }));
    a.download = `cosmiq-diagnostics-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  return { syncFromDevice, importFiles, render, revealPrompt, setLocations, cloudPull, cloudPush, exportBackup, all, copyDiagnostics, downloadDiagnostics };
})();
