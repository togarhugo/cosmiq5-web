/* Dive log UI: local storage (IndexedDB), device sync, cloud sync, profile chart.
 * Depends on: dive-protocol.js (CosmiqDive) and the BLE helpers in index.html
 * (txChar, log, isConnected). Raw device bytes are the source of truth; everything
 * shown is re-derived from them, so parser fixes apply retroactively. */
"use strict";

const Dives = (() => {
  const P = window.CosmiqDive;
  const DB_NAME = "cosmiq", STORE = "dives";
  let dbp = null, busy = false, cloudState = "unknown";

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
      if (!r.ok) throw new Error("HTTP " + r.status);
      const { dives } = await r.json();
      const have = new Set((await all()).map((d) => d.fingerprint));
      for (const d of dives) if (!have.has(d.fingerprint)) await put({ ...toRecord(d), uploaded: true });
      cloudState = "ok";
    } catch (e) { cloudState = navigator.onLine ? "unavailable" : "offline"; }
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
        if (!r.ok) throw new Error("HTTP " + r.status);
        for (const d of batch) await put({ ...d, uploaded: true });
        stored += batch.length;
      }
      cloudState = "ok";
    } catch (e) { cloudState = navigator.onLine ? "unavailable" : "offline"; log("Cloud upload failed: " + e.message, "log-err"); }
    return stored;
  }

  // ---------- device sync ----------
  async function syncFromDevice(io) {
    if (busy) return;
    busy = true; setBusy(true);
    try {
      const known = new Set((await all()).map((d) => d.fingerprint));
      const res = await P.readDives(io, known, (m, p) => progress(m, p));
      for (const raw of res.dives) await put(toRecord(raw, res.mac));
      const up = await cloudPush();
      const msg = `Dive sync done: ${res.count} on device, ${res.dives.length} new, ${res.skipped} already saved` +
        (cloudState === "ok" ? `, ${up} uploaded` : ", cloud unavailable (saved on this phone)");
      progress(msg, 1); log(msg, "log-info");
    } catch (e) {
      progress("Dive sync failed: " + e.message, 0); log("Dive sync failed: " + e.message, "log-err");
    } finally { if (io.end) io.end(); busy = false; setBusy(false); render(); }
  }

  // ---------- UI ----------
  const $ = (id) => document.getElementById(id);
  const fmtDur = (s) => s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 120 ? `${Math.round(s / 60)} min` : `${s} s`;
  const fmtDate = (iso) => { const [d, t] = iso.split("T"); return `${d} ${t.slice(0, 5)}`; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function progress(msg, frac) { const el = $("diveProgress"); if (el) { el.textContent = msg; $("diveBar").style.width = Math.round(frac * 100) + "%"; } }
  function setBusy(b) { const el = $("diveSyncBtn"); if (el) el.disabled = b; }

  function chart(d) {
    const s = d.samples; if (s.length < 2) return "<p class='muted'>No profile samples.</p>";
    const W = 320, H = 150, pl = 34, pr = 8, pt = 8, pb = 20;
    const maxT = s[s.length - 1].t, maxD = Math.max(1, ...s.map((x) => x.depthM));
    const X = (t) => pl + (t / maxT) * (W - pl - pr), Y = (m) => pt + (Math.max(0, m) / maxD) * (H - pt - pb);
    const pts = [[0, 0], ...s.map((x) => [x.t, x.depthM])].map(([t, m]) => `${X(t).toFixed(1)},${Y(m).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Depth profile">
      <line x1="${pl}" y1="${pt}" x2="${W - pr}" y2="${pt}" stroke="#ced4da"/>
      <polyline fill="rgba(0,123,255,.15)" stroke="#007bff" stroke-width="2" points="${X(0)},${Y(0)} ${pts} ${X(maxT)},${Y(0)}"/>
      <text x="2" y="${pt + 9}" font-size="10" fill="#6c757d">0 m</text>
      <text x="2" y="${H - pb}" font-size="10" fill="#6c757d">${maxD.toFixed(0)} m</text>
      <text x="${pl}" y="${H - 4}" font-size="10" fill="#6c757d">0</text>
      <text x="${W - pr}" y="${H - 4}" font-size="10" fill="#6c757d" text-anchor="end">${fmtDur(maxT)}</text></svg>`;
  }

  function detail(rec) {
    const d = P.parseDive(P.fromHex(rec.headerHex), P.fromHex(rec.profileHex));
    const temps = d.samples.map((x) => x.tempC);
    const tmin = temps.length ? Math.min(...temps).toFixed(1) : "–";
    return `${chart(d)}<div class="stats">
      <div><b>${d.maxDepthM.toFixed(1)} m</b><span>max depth</span></div>
      <div><b>${fmtDur(d.durationSec)}</b><span>duration</span></div>
      <div><b>${tmin} °C</b><span>min temp</span></div>
      <div><b>${d.o2Percent != null ? d.o2Percent + "%" : "–"}</b><span>O₂</span></div></div>
      <p class="muted">Depth assumes seawater (1025 kg/m³) like the device. ${d.samples.length} sample${d.samples.length === 1 ? "" : "s"}, every ${d.sampleIntervalSec}s.</p>`;
  }

  async function render() {
    const list = $("diveList"); if (!list) return;
    const recs = (await all()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    $("diveCount").textContent = recs.length ? `${recs.length} dive${recs.length === 1 ? "" : "s"}` : "";
    const cloudTxt = { ok: "☁ synced to cloud", unavailable: "☁ cloud unavailable", offline: "offline", unknown: "" }[cloudState];
    $("cloudState").textContent = cloudTxt;
    if (!recs.length) { list.innerHTML = "<p class='muted'>No dives yet. Tap <b>Sync dives</b> with your dive computer on.</p>"; return; }
    list.innerHTML = recs.map((r) => `<details class="dive" data-fp="${esc(r.fingerprint)}"><summary>
      <span class="dive-date">${esc(fmtDate(r.startedAt))}</span>
      <span class="dive-mode m-${esc(r.mode)}">${esc(r.mode)}</span>
      <span class="dive-meta">${r.maxDepthM.toFixed(1)} m · ${fmtDur(r.durationSec)}${r.uploaded ? "" : " · ⏳"}</span></summary>
      <div class="dive-body"></div></details>`).join("");
    list.querySelectorAll("details.dive").forEach((el) => el.addEventListener("toggle", async () => {
      if (!el.open || el.dataset.done) return;
      const rec = recs.find((r) => r.fingerprint === el.dataset.fp);
      try { el.querySelector(".dive-body").innerHTML = detail(rec); el.dataset.done = 1; }
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

  return { syncFromDevice, render, cloudPull, cloudPush, exportBackup, all };
})();
