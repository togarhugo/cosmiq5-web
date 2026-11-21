/* Dive log UI: local storage (IndexedDB), device sync, cloud sync, profile chart.
 * Depends on: dive-protocol.js (CosmiqDive) and the BLE helpers in index.html
 * (txChar, log, isConnected). Raw device bytes are the source of truth; everything
 * shown is re-derived from them, so parser fixes apply retroactively. */
"use strict";

const Dives = (() => {
  const P = window.CosmiqDive;
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
      uploaded: !!raw.uploaded };
  }

  // ---------- cloud ----------
  async function cloudPull() {
    try {
      const r = await fetch("/api/dives", { credentials: "same-origin", redirect: "error" });
      if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { status: r.status });
      const { dives } = await r.json();
      const have = new Set((await all()).map((d) => d.fingerprint));
      for (const d of dives) if (!have.has(d.fingerprint)) await put({ ...toRecord(d), uploaded: true });
      cloudState = "ok";
    } catch (e) { cloudState = failState(e); }
    render();
  }
  async function cloudPush() {
    const pending = (await all()).filter((d) => !d.uploaded);
    let stored = 0;
    try {
      for (let i = 0; i < pending.length; i += 20) {
        const batch = pending.slice(i, i + 20);
        const r = await fetch("/api/dives", { method: "POST", credentials: "same-origin", redirect: "error",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ dives: batch }) });
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
    let saved = 0, info = {};
    try {
      const known = new Set((await all()).map((d) => d.fingerprint));
      let lastRender = 0;
      const res = await P.readDives(io, known, (m, p) => progress(m, p), async (raw, r) => {
        await put(toRecord(raw, r.mac)); saved++;                      // saved the moment it arrives
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
    return { saved };
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

  /** Depth profile. `missing` = samples the device no longer had: the axis keeps the full dive length and the gap is shown. */
  function chart(d, missing = 0) {
    const s = d.samples; if (s.length < 2) return "<p class='muted'>No profile samples.</p>";
    const W = 320, H = 150, pl = 34, pr = 8, pt = 8, pb = 20;
    const lastT = s[s.length - 1].t, maxT = lastT + missing * d.sampleIntervalSec, maxD = Math.max(1, ...s.map((x) => x.depthM));
    const X = (t) => pl + (t / maxT) * (W - pl - pr), Y = (m) => pt + (Math.max(0, m) / maxD) * (H - pt - pb);
    const pts = [[0, 0], ...s.map((x) => [x.t, x.depthM])].map(([t, m]) => `${X(t).toFixed(1)},${Y(m).toFixed(1)}`).join(" ");
    const gap = missing ? `<rect x="${X(lastT).toFixed(1)}" y="${pt}" width="${(X(maxT) - X(lastT)).toFixed(1)}" height="${H - pt - pb}" fill="#adb5bd" opacity=".25"/>
      <text x="${((X(lastT) + X(maxT)) / 2).toFixed(1)}" y="${(pt + (H - pt - pb) / 2).toFixed(1)}" font-size="8" fill="#6c757d" text-anchor="middle">not</text>
      <text x="${((X(lastT) + X(maxT)) / 2).toFixed(1)}" y="${(pt + (H - pt - pb) / 2 + 10).toFixed(1)}" font-size="8" fill="#6c757d" text-anchor="middle">recovered</text>` : "";
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Depth profile">
      <line x1="${pl}" y1="${pt}" x2="${W - pr}" y2="${pt}" stroke="#ced4da"/>${gap}
      <polygon fill="rgba(0,123,255,.15)" points="${pts} ${X(lastT).toFixed(1)},${Y(0).toFixed(1)}"/>
      <polyline fill="none" stroke="#007bff" stroke-width="2" stroke-linejoin="round" points="${pts}"/>
      <text x="2" y="${pt + 9}" font-size="10" fill="#6c757d">0 m</text>
      <text x="2" y="${H - pb}" font-size="10" fill="#6c757d">${maxD.toFixed(0)} m</text>
      <text x="${pl}" y="${H - 4}" font-size="10" fill="#6c757d">0</text>
      <text x="${W - pr}" y="${H - 4}" font-size="10" fill="#6c757d" text-anchor="end">${fmtDur(maxT)}</text></svg>`;
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

  function detail(rec, res, gapBefore) {
    const d = P.parseDive(P.fromHex(rec.headerHex), P.fromHex(res.profileHex));
    const usable = res.status === "ok" || res.status === "truncated";
    const depths = d.samples.map((x) => x.depthM).filter((m) => m > 0.3);
    const avg = depths.length ? (depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(1) + " m" : "\u2013";
    const note = STATUS_TEXT[res.status] ? STATUS_TEXT[res.status](res.missing, d.sampleIntervalSec) : "";
    return `${usable ? chart(d, res.status === "truncated" ? res.missing : 0) : ""}${note ? `<p class="note">${esc(note)}</p>` : ""}<div class="stats">
      <div><b>${d.maxDepthM.toFixed(1)} m</b><span>max depth</span></div>
      <div><b>${fmtDur(d.durationSec)}</b><span>duration</span></div>
      <div><b>${d.minTempC.toFixed(1)} \u00b0C</b><span>min temp</span></div>
      <div><b>${d.o2Percent != null ? d.o2Percent + "%" : "\u2013"}</b><span>O\u2082</span></div></div>
      <div class="stats">
      <div><b>#${d.number}</b><span>dive number</span></div>
      <div><b>${usable ? avg : "\u2013"}</b><span>avg depth</span></div>
      <div><b>${gapBefore == null ? "\u2013" : fmtGap(gapBefore)}</b><span>since last dive</span></div>
      <div><b>${d.atmosphericMbar}</b><span>surface mbar</span></div></div>
      <p class="muted">Depth assumes seawater (1025 kg/m\u00b3) like the device.${usable ? ` ${d.samples.length} sample${d.samples.length === 1 ? "" : "s"}, every ${d.sampleIntervalSec}s.` : ""}</p>${techDetails(rec, res)}`;
  }

  const YEARS_KEY = "yearsOpen";
  const loadYears = () => { try { return JSON.parse(localStorage.getItem(YEARS_KEY) || "null"); } catch (e) { return null; } };

  async function render() {
    const list = $("diveList"); if (!list) return;
    const recs = (await all()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    $("diveCount").textContent = recs.length ? `(${recs.length})` : "";
    const last = loadLast(), ls = $("lastSync");
    if (ls) { ls.textContent = last ? `Last sync ${new Date(last.at).toLocaleString()}: ${last.msg}` : "No sync yet on this phone."; ls.style.color = last && !last.ok ? "#c92a2a" : ""; }
    const cloudTxt = { ok: "\u2601 synced to cloud", unavailable: "\u2601 cloud unavailable", offline: "offline", signedout: "\ud83d\udd12 signed out: reload the page to sign in again", unknown: "" }[cloudState];
    $("cloudState").textContent = cloudTxt;
    if (!recs.length) { list.innerHTML = "<p class='muted'>No dives yet. Tap <b>Sync dives</b> with your dive computer on.</p>"; return; }

    const resolved = P.reconcileProfiles(recs);                                      // which profile really belongs to which dive
    const asc = recs.slice().reverse(), gapBefore = new Map();
    asc.forEach((r, i) => { if (i) gapBefore.set(r.fingerprint, (asMs(r.startedAt) - (asMs(asc[i - 1].startedAt) + asc[i - 1].durationSec * 1000)) / 60000); });

    const byYear = new Map();
    for (const r of recs) { const y = r.startedAt.slice(0, 4); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(r); }
    const years = [...byYear.keys()];                                                // newest first
    const openNow = list.querySelector("details.year") ? new Set([...list.querySelectorAll("details.year[open]")].map((e) => e.dataset.year)) : null;
    const saved = loadYears(), open = openNow || new Set(saved || [years[0]]);

    const full = recs.filter((r) => resolved[r.fingerprint].status === "ok").length;
    const summaryOnly = recs.filter((r) => ["overwritten", "empty"].includes(resolved[r.fingerprint].status)).length, partial = recs.length - full - summaryOnly;
    let html = `<p class="muted" style="margin:0 0 8px">${recs.length} dive${recs.length === 1 ? "" : "s"} \u00b7 ${full} with full depth profile` +
      `${partial ? ` \u00b7 ${partial} partial` : ""}${summaryOnly ? ` \u00b7 ${summaryOnly} summary only` : ""}</p>`;
    for (const y of years) {
      const g = byYear.get(y), secs = g.reduce((a, r) => a + r.durationSec, 0), deepest = Math.max(...g.map((r) => r.maxDepthM));
      html += `<details class="year" data-year="${y}"${open.has(y) ? " open" : ""}><summary><b>${y}</b><span class="muted"> \u00b7 ${g.length} dive${g.length === 1 ? "" : "s"} \u00b7 ${fmtDur(secs)} \u00b7 max ${deepest.toFixed(1)} m</span></summary>` +
        g.map((r) => {
          const st = resolved[r.fingerprint].status, num = P.parseDive(P.fromHex(r.headerHex), new Uint8Array(0)).number;
          return `<details class="dive" data-fp="${esc(r.fingerprint)}"><summary>
            <span class="dive-num">#${num}</span><span class="dive-date">${esc(fmtDate(r.startedAt))}</span>
            <span class="dive-mode m-${esc(r.mode)}">${esc(r.mode)}</span>${BADGE[st] ? `<span class="badge">${BADGE[st]}</span>` : ""}
            <span class="dive-meta">${r.maxDepthM.toFixed(1)} m \u00b7 ${fmtDur(r.durationSec)}${r.uploaded ? "" : " \u00b7 \u23f3"}</span></summary>
            <div class="dive-body"></div></details>`;
        }).join("") + `</details>`;
    }
    list.innerHTML = html;
    list.querySelectorAll("details.year").forEach((el) => el.addEventListener("toggle", () => {
      try { localStorage.setItem(YEARS_KEY, JSON.stringify([...list.querySelectorAll("details.year[open]")].map((e) => e.dataset.year))); } catch (e) {}
    }));
    list.querySelectorAll("details.dive").forEach((el) => el.addEventListener("toggle", async () => {
      if (!el.open || el.dataset.done) return;
      const rec = recs.find((r) => r.fingerprint === el.dataset.fp);
      try { el.querySelector(".dive-body").innerHTML = detail(rec, resolved[rec.fingerprint], gapBefore.get(rec.fingerprint) ?? null); el.dataset.done = 1; }
      catch (e) { el.querySelector(".dive-body").textContent = "Cannot parse this dive: " + e.message; }
    }));
  }

  async function exportBackup() {
    const recs = await all();
    const blob = new Blob([JSON.stringify({ app: "cosmiq-manager", exportedAt: new Date().toISOString(),
      dives: recs.map(({ fingerprint, deviceMac, headerHex, profileHex }) => ({ fingerprint, deviceMac, headerHex, profileHex })) }, null, 1)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `cosmiq-dives-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function diagnosticsText() {
    const recs = await all(), last = loadLast(), lines = (window.__diag || []);
    const hdr = [`Cosmiq Manager diagnostics`, `app version: ${self.APP_VERSION || "?"}`, `time: ${new Date().toString()}`,
      `user agent: ${navigator.userAgent}`, `web bluetooth: ${!!navigator.bluetooth}`, `secure context: ${window.isSecureContext}`,
      `last sync: ${JSON.stringify(last)}`, `dives stored on this phone: ${recs.length}`, `cloud: ${cloudState}`, ""];
    const dv = recs.slice(0, 60).map((r) => `dive ${r.startedAt} ${r.mode} ${r.durationSec}s ${r.maxDepthM}m header=${r.headerHex} profileBytes=${r.profileHex.length / 2}`);
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

  return { syncFromDevice, render, cloudPull, cloudPush, exportBackup, all, copyDiagnostics, downloadDiagnostics };
})();
