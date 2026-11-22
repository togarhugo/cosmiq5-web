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
  const allRaw = () => tx("readonly", (s) => s.getAll());                                  // includes the stubs of deleted dives (fingerprint only)
  const all = async () => (await allRaw()).filter((r) => !r.deleted);
  /** Remove the dives another person shared with you from this device too (the account's copies were deleted on the server). */
  async function forgetShared(from) { const gone = (await all()).filter((r) => r.sharedFrom === from); for (const r of gone) await tx("readwrite", (s) => s.delete(r.fingerprint)); return gone.length; }
  const put = (rec) => tx("readwrite", (s) => s.put(rec));

  /** "name.surname@example.com" -> "Name": how a person is named next to a dive that was shared by them. */
  const whoIs = (email) => { const t = String(email || "").split("@")[0].split(/[._-]/)[0]; return t.charAt(0).toUpperCase() + t.slice(1); };
  function toRecord(raw, deviceMac) {
    const d = P.parseDive(P.fromHex(raw.headerHex), P.fromHex(raw.profileHex));
    return { fingerprint: raw.fingerprint, deviceMac: deviceMac || raw.deviceMac || null,
      headerHex: raw.headerHex, profileHex: raw.profileHex, startedAt: d.startedAt, mode: d.mode,
      durationSec: d.durationSec, maxDepthM: +d.maxDepthM.toFixed(2), o2Percent: d.o2Percent,
      uploaded: !!raw.uploaded, location: raw.location || undefined, sharedFrom: raw.sharedFrom || undefined };
  }

  // Imported dives (another computer's log read from a file) have no raw device bytes: they keep decoded values + depth samples.
  const isImported = (r) => !!r.device && r.device !== "cosmiq";
  const IMPORT_BATCH = 8;
  function fromCloudImport(d) {
    let x = {}; try { x = JSON.parse(d.extra || "{}"); } catch (e) {}
    return { fingerprint: d.fingerprint, device: d.device, startedAt: d.startedAt, mode: d.mode, durationSec: d.durationSec, maxDepthM: d.maxDepthM,
      o2Percent: d.o2Percent == null ? null : d.o2Percent, number: x.n == null ? null : x.n, minTempC: x.t == null ? null : x.t, intervalSec: x.iv || 10,
      samples: Array.isArray(x.s) ? x.s : [], headerHex: "", profileHex: "", uploaded: true, location: d.location || undefined, sharedFrom: d.sharedFrom || undefined };
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
      const { dives, deleted } = await r.json();
      const local = new Map((await allRaw()).map((d) => [d.fingerprint, d]));
      for (const fp of deleted || []) { const mine = local.get(fp); if (!mine || !mine.deleted) { await put({ fingerprint: fp, deleted: true, delSynced: true }); local.set(fp, { deleted: true }); } }   // deleted on another device
      for (const d of dives) {
        const mine = local.get(d.fingerprint);
        if (mine && mine.deleted) continue;                                                  // deleted here: stays deleted even if the cloud still holds it for a moment
        if (!mine) await put(d.device && d.device !== "cosmiq" ? fromCloudImport(d) : { ...toRecord(d), uploaded: true });
        else if (!mine.locDirty && (mine.location || "") !== (d.location || "")) await put({ ...mine, location: d.location || undefined });   // edited on another device
      }
      cloudState = "ok";
    } catch (e) { cloudState = failState(e); }
    await pushLocations();                                                            // retry edits that could not be sent earlier
    await pushDeletes();
    render();
  }

  // ---------- locations (free text per dive; edited per date) ----------
  /** map: fingerprint -> text ("" clears). Saved on this phone first, then sent to the cloud. */
  async function setLocations(map) {
    const recs = await all(), known = U.knownLocations(recs), entered = [], { extras } = U.duplicateGroups(recs);
    const target = new Map(); for (const fp of Object.keys(map)) { target.set(fp, fp); for (const h of extras.get(fp) || []) target.set(h.fingerprint, fp); }   // the record shown and the ones hidden behind it all get the place
    for (const r of recs) if (target.has(r.fingerprint)) {
      const loc = U.normalizeLocation(map[target.get(r.fingerprint)], known);
      await put({ ...r, location: loc || undefined, locDirty: true }); if (loc && target.get(r.fingerprint) === r.fingerprint) entered.push(loc);
    }
    render(); await pushLocations(); render();
    // a place you picked from the map suggestions is put on the map with that position; any other new place goes to the map search
    lastPlaced = []; const fresh = [];
    for (const n of entered) {
      if (fresh.some((f) => f.toLowerCase() === n.toLowerCase()) || lastPlaced.some((f) => f.toLowerCase() === n.toLowerCase())) continue;
      const chosen = typeof PlacesUI !== "undefined" ? PlacesUI.takePending(n) : null;
      if (window.Places.get(n)) continue;
      if (chosen) { try { await window.Places.save(n, chosen.lat, chosen.lon); lastPlaced.push(n); continue; } catch (e) { say("Could not save the position of \u201c" + n + "\u201d: " + e.message, "warn"); } }
      fresh.push(n);
    }
    if (lastPlaced.length) render();
    if (fresh.length && typeof PlacesUI !== "undefined") PlacesUI.offer(fresh);
  }
  let lastPlaced = [];
  /** "Location saved" + which places were added to the map by this save. */
  const savedText = (base) => base + (lastPlaced.length ? ` \u00b7 ${lastPlaced.map((n) => "\u201c" + n + "\u201d").join(", ")} added to the map` : "");
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
  /** Tell the cloud about dives deleted here (a deletion made offline is sent the next time). */
  async function pushDeletes() {
    const stubs = (await allRaw()).filter((r) => r.deleted && !r.delSynced);
    if (!stubs.length) return 0;
    try {
      for (let i = 0; i < stubs.length; i += 100) {
        const batch = stubs.slice(i, i + 100);
        const r = await fetch("/api/dives/delete", { method: "POST", credentials: "same-origin", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ fingerprints: batch.map((d) => d.fingerprint) }) });
        if (!r.ok) throw Object.assign(new Error("HTTP " + r.status), { status: r.status });
        for (const d of batch) await put({ ...d, delSynced: true });
      }
      cloudState = "ok";
    } catch (e) { cloudState = failState(e); }
    return stubs.length;
  }
  /** Delete dives (the one shown and the copies other computers recorded of it). Only the fingerprints are kept, so a sync or an import does not bring them back. */
  async function deleteDives(fps) {
    for (const fp of fps) await put({ fingerprint: fp, deleted: true, delSynced: false });
    await pushDeletes(); render();
    return cloudState === "ok";
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
    busy = true; setBusy(true); showBanner(true); { const g = $("impGoLog"); if (g) g.style.display = "none"; }
    let saved = 0, info = {}; const savedRecs = [];
    try {
      const known = new Set((await allRaw()).map((d) => d.fingerprint));
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
    if (savedRecs.length) { importDone(savedRecs.length); openPrompt(savedRecs, "Where did you dive?", `${savedRecs.length} new dive${savedRecs.length === 1 ? "" : "s"}. Just the area, for example Banda, Komodo or Tulamben.`); }
    return { saved };
  }

  // ---------- import a log exported from another dive computer's app ----------
  /** After an import or a sync: tell where the new dives went, with a way to open them (the Import view has no dive list). */
  function importDone(n) { const c = $("impGoLog"); if (!c || !n) return; $("impGoLogText").textContent = `${n} new dive${n === 1 ? "" : "s"} added to your dive log.`; c.style.display = ""; }
  /** A decoded dive (from a file or from Bluetooth) -> the record stored on the phone and in the cloud. */
  const importedRecord = (d, deviceId) => ({
    fingerprint: window.DiveImport.fingerprint(deviceId + "|" + d.startedAt.slice(0, 16)), device: deviceId, startedAt: d.startedAt, mode: d.mode, durationSec: d.durationSec,
    maxDepthM: d.maxDepthM, o2Percent: d.o2Percent == null ? null : d.o2Percent, number: d.number == null ? null : d.number, minTempC: d.minTempC, intervalSec: d.intervalSec,
    samples: window.DiveImport.thin(d.samples), headerHex: "", profileHex: "", uploaded: false });
  /** Files: a Shearwater Cloud database (.db) or its ZIP, or a UDDF export (XML). The kind is recognised from the content, not the name. */
  async function importFiles(files, deviceId) {
    const out = $("impMsg"), say2 = (t, bad) => { if (out) { out.textContent = t; out.style.color = bad ? "var(--tx-c92a2a)" : "var(--tx-2b8a3e)"; } };
    if (busy) { say2("Wait for the running sync to finish first.", true); return; }
    busy = true; say2("Reading\u2026"); { const g = $("impGoLog"); if (g) g.style.display = "none"; }
    const fresh = [], seen = new Set((await allRaw()).map((d) => d.fingerprint)); let already = 0, skipped = 0, found = 0, gNotDive = 0, gUtc = 0; const problems = [];
    try {
      for (const f of files) {
        if (f.size > 400_000_000) { problems.push(`${f.name}: too large (${Math.round(f.size / 1e6)} MB, limit 400 MB)`); continue; }
        try {
          const bytes = new Uint8Array(await f.arrayBuffer()), kind = deviceId === "garmin" ? "garmin" : window.ShearwaterCloud.sniff(bytes);
          let dives, note = "";
          if (kind === "garmin") {
            const res = await window.GarminFit.read(bytes, { onProgress: (n, t) => say2(`Reading file ${n} of ${t}\u2026`) });
            dives = res.dives; note = `${res.files} FIT file${res.files === 1 ? "" : "s"}, ${res.notDive} not a dive`;
            gNotDive += res.notDive; gUtc += res.utcFallback;
            for (const m of res.problems.slice(0, 3)) problems.push(`${f.name}: ${m}`);
          } else if (kind === "text") { const res = window.DiveImport.parseUddf(new TextDecoder().decode(bytes), deviceId); dives = res.dives; skipped += res.skipped; note = res.info; }
          else {
            const res = await window.ShearwaterCloud.readExport(bytes, (d, t) => say2(`Reading dive ${d} of ${t}\u2026`));
            dives = res.dives; skipped += res.skipped.deleted + res.skipped.format; note = `${res.total} dive${res.total === 1 ? "" : "s"} in the database`;
            for (const m of res.problems.slice(0, 3)) problems.push(`${f.name}: ${m}`); if (res.problems.length > 3) problems.push(`and ${res.problems.length - 3} more dives could not be read`);
          }
          found += dives.length;
          if (!dives.length) problems.push(`${f.name}: no dives found (${note})`);
          for (const d of dives) {
            const rec = importedRecord(d, deviceId);
            if (seen.has(rec.fingerprint)) { already++; continue; }
            seen.add(rec.fingerprint); await put(rec); fresh.push(rec);
          }
        } catch (e) { problems.push(`${f.name}: ${e.message}`); }
        render();
      }
      const up = fresh.length ? await cloudPush() : 0;
      const parts = [`${fresh.length} new dive${fresh.length === 1 ? "" : "s"} imported`];
      if (already) parts.push(`${already} already there`); if (skipped) parts.push(`${skipped} skipped (deleted or incomplete)`);
      if (gNotDive) parts.push(`${gNotDive} other activit${gNotDive === 1 ? "y" : "ies"} skipped (not dives)`);
      if (gUtc) parts.push(`${gUtc} dive${gUtc === 1 ? "" : "s"} had no time zone in the file, so the time shown is UTC`);
      if (fresh.length) parts.push(cloudState === "ok" ? `${up} uploaded` : "saved on this phone, cloud unavailable");
      say2(parts.join(", ") + "." + (problems.length ? " " + problems.join(" ") : ""), !fresh.length && !!problems.length);
      if (fresh.length) say(`${fresh.length} dive${fresh.length === 1 ? "" : "s"} imported`);
    } finally { busy = false; render(); }
    if (fresh.length) { importDone(fresh.length); openPrompt(fresh, "Where did you dive?", `${fresh.length} imported dive${fresh.length === 1 ? "" : "s"}. Just the area, for example Banda, Komodo or Tulamben.`); }
    return { imported: fresh.length, already, skipped, found };
  }

  // ---------- Shearwater Peregrine / Perdix over Bluetooth (beta) ----------
  let pgCancel = false;
  const BT_MODELS = { peregrine: "Peregrine", perdix: "Perdix" };
  /** What the browser can see of the dive computer, without downloading anything. */
  async function probeShearwater() {
    const out = $("pgMsg"), say2 = (t, bad) => { if (out) { out.textContent = t; out.style.color = bad ? "var(--tx-c92a2a)" : ""; } };
    if (busy) { say2("Wait for the running sync to finish first.", true); return; }
    const device = BT_MODELS[curDevice] ? curDevice : "peregrine", L = window.BtLog.begin({ kind: "test", device, model: BT_MODELS[device] });
    try { L.step("Choose your dive computer in the list"); say2("Choose your dive computer in the list\u2026"); const r = await window.Shearwater.probe((l) => { if (typeof diag === "function") diag("PG " + l); L.trace(l); }); say2(r.text, !r.ok); if (typeof diag === "function") diag("PG probe: " + r.text); log("Bluetooth test: " + r.text, r.ok ? "log-info" : "log-err"); L.step(r.text); L.end(r.ok, r.text); }
    catch (e) { const cancelled = e && e.name === "NotFoundError", m = cancelled ? "No dive computer was chosen." : (e && e.message) || String(e); say2(m, !cancelled); L.end(false, m, { cancelled }); }
    renderBtLog();
  }
  async function syncPeregrine() {
    const device = BT_MODELS[curDevice] ? curDevice : "peregrine", model = BT_MODELS[device];
    const out = $("pgMsg"), bar = $("pgBar"), btn = $("pgBtn"), cancel = $("pgCancel");
    const L = window.BtLog.begin({ kind: "download", device, model });
    const say2 = (t, bad) => { L.step(t); if (out) { out.textContent = t; out.style.color = bad ? "var(--tx-c92a2a)" : ""; } };
    if (busy) { say2("Wait for the running sync to finish first.", true); L.end(false, "Another sync was running."); return; }
    busy = true; pgCancel = false; btn.disabled = true; cancel.style.display = ""; bar.style.width = "0"; { const g = $("impGoLog"); if (g) g.style.display = "none"; }
    const fp = (startedAt) => window.DiveImport.fingerprint(device + "|" + startedAt.slice(0, 16));
    const seen = new Set((await allRaw()).map((d) => d.fingerprint)), fresh = []; let conn = null, problems = 0, ended = false;
    const trace = (l) => { if (typeof diag === "function") diag("PG " + l); L.trace(l); };
    try {
      say2("Choose your " + model + " in the list\u2026"); conn = await window.Shearwater.connect(trace);
      L.info({ deviceName: conn.name }); say2("Connected to " + conn.name + ".");
      const res = await window.Shearwater.readDives(conn.io, {
        known: (startedAt) => seen.has(fp(startedAt)), cancelled: () => pgCancel, log: (m) => L.step(m),
        identity: async (id) => {
          L.info({ serial: id.serial, firmware: id.firmware, model: id.model, modelName: id.modelName });
          if (id.model === 9 && device !== "peregrine") throw new Error(`This computer says it is a Peregrine (model number 9), but you are on the ${model} tab. Open the Shearwater Peregrine tab and try again, so its dives are not filed under the wrong computer.`);
        },
        onProgress: (m, f) => { say2(m); bar.style.width = Math.round(f * 100) + "%"; },
        onProblem: (m) => { problems++; L.step("PROBLEM: " + m); log(model + ": could not read dive " + m, "log-err"); },
        onDive: async (d) => {
          const rec = importedRecord(d, device);
          await put(rec); seen.add(rec.fingerprint); fresh.push(rec); render();                      // saved the moment it arrives
        } });
      L.info({ total: res.total, fresh: res.fresh, failed: res.failed });
      const up = fresh.length ? await cloudPush() : 0;
      const msg = `${model}: ${res.total} on the dive computer, ${fresh.length} new` + (problems ? `, ${problems} could not be read (see diagnostics)` : "") +
        (fresh.length ? (cloudState === "ok" ? `, ${up} uploaded` : ", saved on this phone, cloud unavailable") : "");
      say2(msg, !!problems && !fresh.length); bar.style.width = "100%"; log(msg, "log-info"); saveLast({ ok: !problems, msg }); L.end(!problems || fresh.length > 0, msg, { fresh: fresh.length, problems }); ended = true;
    } catch (e) {
      const cancelled = e && e.name === "NotFoundError" || (e && /Cancelled by you/.test(e.message || "")), m = e && e.name === "NotFoundError" ? "No dive computer was chosen." : e && e.message ? e.message : String(e);
      say2(m + (fresh.length ? ` ${fresh.length} dive(s) were saved before it stopped: run it again to continue.` : ""), !(e && e.name === "NotFoundError"));
      log(model + " sync stopped: " + m, "log-err"); if (fresh.length) await cloudPush(); L.end(false, m + (fresh.length ? ` (${fresh.length} dives saved before it stopped)` : ""), { cancelled, fresh: fresh.length }); ended = true;
    } finally { if (conn) conn.close(); busy = false; btn.disabled = false; cancel.style.display = "none"; if (!ended) L.end(false, "stopped unexpectedly"); render(); renderBtLog(); }
    if (fresh.length) { importDone(fresh.length); openPrompt(fresh, "Where did you dive?", `${fresh.length} new ${model} dive${fresh.length === 1 ? "" : "s"}. Just the area, for example Banda, Komodo or Tulamben.`); }
    return { saved: fresh.length };
  }
  // ---- the download log panel (Import > Bluetooth download) ----
  function renderBtLog() {
    const box = $("btLogBox"); if (!box || !window.BtLog) return;
    const list = window.BtLog.list(); $("btLogCount").textContent = list.length ? `(${list.length})` : "";
    const ul = $("btLogList"); ul.textContent = ""; if (!list.length) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "No Bluetooth attempts yet."; ul.appendChild(li); }
    for (const e of list.slice(0, 12)) { const li = document.createElement("li"); li.textContent = window.BtLog.summary(e); li.style.color = e.outcome && !e.outcome.ok && !e.outcome.cancelled ? "var(--tx-c92a2a)" : ""; ul.appendChild(li); }
    $("btLogText").value = window.BtLog.formatAll(list.slice(0, 10));
  }
  async function btLogAct(what) {
    const msg = $("btLogMsg"), say2 = (t) => { msg.textContent = t; };
    if (what === "copy") { const t = window.BtLog.formatAll(window.BtLog.list()); try { await navigator.clipboard.writeText(t); say2("Copied."); } catch (e) { $("btLogText").select(); say2("Select the text and copy it by hand."); } }
    else if (what === "save") { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([window.BtLog.formatAll(window.BtLog.list())], { type: "text/plain" })); a.download = "bluetooth-download-log.txt"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); say2("Saved."); }
    else if (what === "clear") { window.BtLog.clear(); renderBtLog(); say2("Cleared."); }
    else if (what === "send") {
      const list = window.BtLog.list(); if (!list.length) return say2("Nothing to send yet.");
      try { const r = await fetch("/api/bt-reports", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "download", body: window.BtLog.formatAll(list).slice(0, 195000) }) });
        const j = await r.json().catch(() => ({})); say2(r.ok ? `Sent to your account (report #${j.id}). It can now be looked at.` : (j.error || "Could not send (" + r.status + ")")); } catch (e) { say2("Could not send: " + e.message); }
    }
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
      grid += `<line x1="${pl}" y1="${Y(m).toFixed(1)}" x2="${W - pr}" y2="${Y(m).toFixed(1)}" class="${m === 0 ? "g-axis" : "g-grid"}" stroke-width="${m === 0 ? 1 : 0.8}"/>` +
        `<text x="${pl - 5}" y="${(Y(m) + 3).toFixed(1)}" font-size="10" class="g-lbl" text-anchor="end">${m}${m === 0 ? " m" : ""}</text>`;
    for (const t of tk.ticks)
      grid += `<line x1="${X(t).toFixed(1)}" y1="${pt}" x2="${X(t).toFixed(1)}" y2="${H - pb}" class="g-grid2" stroke-width="0.8"/>` +
        `<text x="${X(t).toFixed(1)}" y="${H - 8}" font-size="10" class="g-lbl" text-anchor="middle">${Math.round(t / 60)}</text>`;
    const gap = missing ? `<rect x="${X(lastT).toFixed(1)}" y="${pt}" width="${(X(maxT) - X(lastT)).toFixed(1)}" height="${H - pt - pb}" class="g-gap" opacity=".25"/>
      <text x="${((X(lastT) + X(maxT)) / 2).toFixed(1)}" y="${(pt + (H - pt - pb) / 2).toFixed(1)}" font-size="8" class="g-lbl" text-anchor="middle">not</text>
      <text x="${((X(lastT) + X(maxT)) / 2).toFixed(1)}" y="${(pt + (H - pt - pb) / 2 + 10).toFixed(1)}" font-size="8" class="g-lbl" text-anchor="middle">recovered</text>` : "";
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Depth profile, gridlines every ${ax.step} m and ${Math.round(tk.step / 60)} min">
      ${grid}${gap}
      <line x1="${pl}" y1="${pt}" x2="${pl}" y2="${H - pb}" class="g-axis"/>
      <polygon fill="rgba(0,123,255,.15)" points="${pts} ${X(lastT).toFixed(1)},${Y(0).toFixed(1)}"/>
      <polyline fill="none" stroke="#007bff" stroke-width="2" stroke-linejoin="round" points="${pts}"/>
      <text x="${pl}" y="${H - 8}" font-size="10" class="g-lbl" text-anchor="middle">0</text>
      <text x="${W - pr}" y="${H - 8}" font-size="10" class="g-lbl" text-anchor="end">${fmtDur(maxT)}</text></svg>`;
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
      <p class="muted">Imported from a file from the ${esc(deviceName(rec.device))}: ${sm.length} depth sample${sm.length === 1 ? "" : "s"}. The numbers are the ones in that file.</p>`;
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

  const YEARS_KEY = "yearsOpen", MONTHS_KEY = "monthsOpen";
  const loadOpen = (key) => { try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (e) { return null; } }, loadYears = () => loadOpen(YEARS_KEY);
  const say = (t, kind) => { if (window.toast) window.toast(t, kind || "ok"); };
  const dayOf = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtDayShort = (key) => dayOf(key).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const fmtDayLong = (key) => dayOf(key).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // ---------- summary page ----------
  const KIND_LABEL = { scuba: "Scuba", freedive: "Freedive" };
  function renderSummary(recs) {
    if (!$("sumHours")) return;
    const sm = U.summarize(recs, new Date());
    $("sumEmpty").style.display = sm.count ? "none" : "";
    $("sumCards").style.display = sm.count ? "" : "none";
    if (!sm.count) return;
    $("sumLastDate").textContent = fmtDayLong(sm.last.date);
    $("sumLastSub").textContent = [U.agoText(sm.last.daysAgo), sm.last.location && "\ud83d\udccd " + sm.last.location].filter(Boolean).join(" \u00b7 ");
    $("sumHours").textContent = U.hoursText(sm.totalSec);
    const kc = $("sumLastKind"); kc.className = "kindchip kind-" + sm.last.kind; kc.textContent = KIND_LABEL[sm.last.kind];
    $("sumKinds").innerHTML = U.KINDS.filter((k) => k === "scuba" || sm.byKind[k].count).map((k) => `<div class="kindrow"><span class="kindchip kind-${k}">${KIND_LABEL[k]}</span><b>${U.durText(sm.byKind[k].sec)}</b><span class="muted">${sm.byKind[k].count} dive${sm.byKind[k].count === 1 ? "" : "s"}</span></div>`).join("");
    $("sumCount").textContent = `across ${sm.count} dive${sm.count === 1 ? "" : "s"}` + (sm.duplicates ? ` \u00b7 ${sm.duplicates} recorded on ${new Set(recs.map(U.deviceOf)).size > 2 ? "more than one" : "both"} computers, counted once (${new Set(recs.map(U.deviceOf)).size > 2 ? "the preferred computer's record" : (U.DEVICES.find((x) => x.id === U.PREFERENCE.find((p) => recs.some((r) => U.deviceOf(r) === p))) || { short: "the preferred computer" }).short} used)` : "");
  }
  /** Top of the Summary: your name, latest certification, DAN membership and how long it is valid (green / orange within 60 days / red when expired). */
  function renderDiverCard() {
    const card = $("sumDiver"); if (!card) return;
    const d = typeof AccountArea !== "undefined" ? AccountArea.diver() : null; if (!d) { card.style.display = "none"; return; }
    const day = (k) => { const [y, m, dd] = k.split("-").map(Number); return new Date(y, m - 1, dd).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); };
    card.style.display = "";
    $("sumName").textContent = d.name || "Your name"; $("sumName").style.color = d.name ? "" : "var(--tx-868e96)";
    const c = d.latestCert;
    $("sumCert").textContent = c ? c.label : "None added yet";
    $("sumCertSub").textContent = c ? [c.number && "#" + c.number, c.certifiedOn && day(c.certifiedOn)].filter(Boolean).join(" \u00b7 ") : "Add one in the Certificates tab";
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
    const st = U.regulatorStatus(reg, recs, new Date());
    card.className = "card sum reg-" + st.level; card.setAttribute("role", st.level === "ok" ? "button" : "alert");
    $("sumRegCount").textContent = st.dives; $("sumRegName").textContent = [reg.name, reg.type].filter(Boolean).join(" \u00b7 ");
    $("sumRegMonthsWrap").style.display = st.months == null ? "none" : ""; if (st.months != null) { $("sumRegMonths").textContent = st.months; $("sumRegMonthsUnit").textContent = st.months === 1 ? "month" : "months"; }
    const line = (id, level, frac, warnFrac, txt) => { const el = $(id + "Line"); el.className = "regline lv-" + level; $(id + "Bar").style.width = Math.min(100, Math.max(0, frac * 100)) + "%"; $(id + "Tick").style.left = (warnFrac * 100) + "%"; $(id + "Txt").textContent = txt; };
    line("sumRegDives", st.diveLevel, st.limitDives ? st.dives / st.limitDives : 0, st.limitDives ? st.diveWarnAt / st.limitDives : 0, `${st.dives} / ${st.limitDives}`);
    line("sumRegTime", st.monthLevel, st.limitMonths && st.months != null ? st.months / st.limitMonths : 0, st.limitMonths ? st.monthWarnAt / st.limitMonths : 0, st.months == null ? "not set" : `${st.months} / ${st.limitMonths} mo`);
    const last = $("sumRegLast"); last.textContent = reg.serviced ? `Last service: ${U.monthLabel(reg.serviced)}` + (st.months === 0 ? " (this month)" : ` (${st.months} month${st.months === 1 ? "" : "s"} ago)`) : "Last service: not set";
    $("sumRegMsg").textContent = U.regulatorMessage(st);
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
      `</div><div class="row" style="margin:0"><button id="locSave" class="btn-set" type="button">Save</button><button id="locLater" class="btn-set" type="button" style="background:var(--bg-6c757d)">Later</button></div>`;
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
      if (n) { await setLocations(map); say(savedText(`Location saved for ${n} dive${n === 1 ? "" : "s"}`)); } else updateBanner(await all());
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
  // ---- which dive computers are shown: the ones that have dives, plus the ones this person added by hand ----
  const SRC_KEY = "sources", OWNER_KEY = "owner", USER_KEYS = ["lastSync", "diver", "regulator", SRC_KEY, "logDevice", "yearsOpen", "monthsOpen", "btLog"];
  const HOW = { cosmiq: "Sync over Bluetooth", peregrine: "From a Shearwater Cloud export", perdix: "From a Shearwater Cloud export", garmin: "From FIT files (Garmin Connect)" };
  const loadSrc = () => { try { const a = JSON.parse(localStorage.getItem(SRC_KEY) || "[]"); return Array.isArray(a) ? a.filter((x) => U.DEVICES.some((v) => v.id === x)) : []; } catch (e) { return []; } };
  const saveSrc = (a) => { try { localStorage.setItem(SRC_KEY, JSON.stringify(a)); } catch (e) {} };
  const visibleSources = (recs) => { const added = loadSrc(); return U.DEVICES.filter((x) => added.includes(x.id) || recs.some((r) => U.deviceOf(r) === x.id)); };
  const srcButtons = (list) => list.map((x) => `<button type="button" class="srcbtn" data-add="${x.id}"><b>${esc(x.name)}</b><span class="muted">${esc(HOW[x.id])}</span></button>`).join("");
  /** Things that only make sense with a Cosmiq+ (Connect & Sync, its settings tab) are hidden for someone who uses other computers only. */
  function cosmiqChrome(vis) {
    const none = vis.length > 0 && !vis.some((x) => x.id === "cosmiq");
    document.body.classList.toggle("no-cosmiq", none);
    if (none && typeof window.showView === "function" && document.getElementById("deviceView") && document.getElementById("deviceView").style.display !== "none") window.showView("summary");
  }
  /** Draws the computer selector, shows the matching sync / import card, and returns the computer being shown ("" = none chosen yet). */
  let curDevice = "cosmiq";                                                                           // the log being shown (picked by you, or your newest dive's computer)
  function renderDeviceTabs(recs) {
    const vis = visibleSources(recs), ids = vis.map((x) => x.id);
    cosmiqChrome(vis);
    const shown = !vis.length ? "" : ids.includes(selDevice) ? selDevice : recs.length && ids.includes(U.deviceOf(recs[0])) ? U.deviceOf(recs[0]) : ids[0];    // until you pick one: the computer of your newest dive (not remembered, so it follows the data as it arrives)
    const box = $("devTabs"), show = (id, on) => { const el = $(id); if (el) el.style.display = on ? "" : "none"; };
    if (box) box.innerHTML = vis.map((x) => { const n = recs.filter((r) => U.deviceOf(r) === x.id).length;
      return `<button type="button" role="tab" aria-selected="${x.id === shown}" class="${x.id === shown ? "active" : ""}" data-dev="${x.id}">${esc(x.name)}<span class="muted"> \u00b7 ${n}</span></button>`; }).join("");
    show("devTabs", !!vis.length);
    const more = U.DEVICES.filter((x) => !ids.includes(x.id));
    show("srcEmpty", !vis.length); if ($("srcEmptyList")) $("srcEmptyList").innerHTML = srcButtons(U.DEVICES);
    show("srcAddRow", !!vis.length && !!more.length); if ($("srcAddList")) $("srcAddList").innerHTML = srcButtons(more); if (!more.length) show("srcAddList", false);
    const sync = $("syncCard"), imp = $("importCard");
    if (sync) sync.style.display = shown === "cosmiq" ? "" : "none";
    if (imp) {
      imp.style.display = shown && shown !== "cosmiq" ? "" : "none";
      const garmin = shown === "garmin", shearwater = shown === "peregrine" || shown === "perdix", model = (U.DEVICES.find((x) => x.id === shown) || { short: "" }).short;
      show("impPeregrine", shearwater); show("impNotePeregrine", shearwater); show("impBt", shown === "peregrine" || shown === "perdix");
      const intro = $("btIntro"); if (intro) intro.textContent = shown === "perdix" ? "Reads the Perdix straight over Bluetooth, the same way as the Peregrine: no export and no Shearwater Cloud. The Peregrine version is proven on a real computer; the Perdix has not been tried yet, so if it fails, run the test below and send the download log. A Perdix 2 should work; an older computer with classic Bluetooth cannot connect from a browser." : "Reads the Peregrine straight over Bluetooth: no export and no Shearwater Cloud. This works on a real Peregrine. Dives already in your log (from an earlier file import too) are recognised and not added twice.";
      const fh = $("impFileHead"); if (fh) { fh.style.display = garmin ? "none" : ""; fh.textContent = "Or import a file from Shearwater Cloud instead"; } show("impGarmin", garmin); show("impNoteGarmin", garmin);
      const set = (id, t) => { const el = $(id); if (el) el.textContent = t; };
      set("impTitle", (U.DEVICES.find((x) => x.id === shown) || { name: "" }).name);
      document.querySelectorAll(".impModel").forEach((el) => { el.textContent = model; });
      set("dropTitle", garmin ? "Drop your Garmin dive files here" : "Drop your Shearwater Cloud file here");
      const kinds = $("dropKinds"); if (kinds) kinds.innerHTML = garmin ? "or tap to choose them &middot; <code>.fit</code> or <code>.zip</code>" : "or tap to choose it &middot; <code>.db</code>, <code>.zip</code> or UDDF";
      const zone = $("dropZone"); if (zone) zone.setAttribute("aria-label", garmin ? "Drop Garmin dive files here, or tap to choose them" : "Drop a Shearwater Cloud file here, or tap to choose one");
    }
    show("srcHideRow", !!shown && !recs.some((r) => U.deviceOf(r) === shown));                   // a computer added by mistake can be hidden again while it has no dives
    curDevice = shown; return shown;
  }
  function addSource(id) { saveSrc([...new Set([...loadSrc(), id])]); selDevice = id; try { localStorage.setItem(DEV_KEY, id); } catch (e) {} const m = $("impMsg"); if (m) m.textContent = ""; const l = $("srcAddList"); if (l) l.style.display = "none"; render(); }
  function hideSource() { if (curDevice) saveSrc(loadSrc().filter((x) => x !== curDevice)); selDevice = null; try { localStorage.removeItem(DEV_KEY); } catch (e) {} render(); }
  /**
   * The dives cached on this device belong to one person. When someone else signs in on the same browser, the cache and the per-person
   * settings are cleared first (dives not yet uploaded are saved to a backup file, never given to the other account). Returns true when it cleared.
   */
  async function claimDevice() {
    try {
      const r = await fetch("/api/me", { credentials: "same-origin", redirect: "error" }); if (!r.ok) return false;
      const email = String((await r.json()).email || "").toLowerCase(); if (!email) return false;
      const prev = localStorage.getItem(OWNER_KEY);
      if (prev && prev !== email) {
        const recs = await all(); if (recs.some((x) => x.uploaded === false)) { try { await exportBackup(); } catch (e) {} }
        await tx("readwrite", (s) => s.clear()); for (const k of USER_KEYS) { try { localStorage.removeItem(k); } catch (e) {} }
        localStorage.setItem(OWNER_KEY, email); return true;
      }
      if (!prev) localStorage.setItem(OWNER_KEY, email);
    } catch (e) { /* offline or signed out: keep what is cached for the same person */ }
    return false;
  }
  function pickDevice(id) { selDevice = id; try { localStorage.setItem(DEV_KEY, id); } catch (e) {} const m = $("impMsg"); if (m) m.textContent = ""; const g = $("impGoLog"); if (g) g.style.display = "none"; render(); }

  let renderPending = false, wired = false;
  function wireList(list) {
    if (wired) return; wired = true;
    $("devTabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-dev]"); if (b) pickDevice(b.dataset.dev); });
    document.addEventListener("click", (e) => { const a = e.target.closest && e.target.closest(".togo-import, #impToLog"); if (!a) return; e.preventDefault(); window.showView(a.id === "impToLog" ? "log" : "import"); });
    $("impGoLogBtn").addEventListener("click", () => window.showView("log"));
    for (const id of ["srcEmptyList", "srcAddList"]) $(id).addEventListener("click", (e) => { const b = e.target.closest("button[data-add]"); if (b) addSource(b.dataset.add); });
    $("srcAdd").addEventListener("click", () => { const l = $("srcAddList"); l.style.display = l.style.display === "none" ? "" : "none"; });
    $("srcHide").addEventListener("click", hideSource);
    $("pgBtn").addEventListener("click", syncPeregrine); $("pgProbe").addEventListener("click", probeShearwater);
    for (const [id, what] of [["btLogCopy", "copy"], ["btLogSave", "save"], ["btLogSend", "send"], ["btLogClear", "clear"]]) $(id).addEventListener("click", () => btLogAct(what)); $("btLogBox").addEventListener("toggle", renderBtLog); renderBtLog(); $("pgCancel").addEventListener("click", () => { pgCancel = true; $("pgMsg").textContent = "Cancelling\u2026"; });
    const card = $("importCard");                                                                  // drop a file from Finder / Spotlight / Files onto the card
    if (card) {
      const over = (on) => card.classList.toggle("dropping", on);
      card.addEventListener("dragenter", (e) => { e.preventDefault(); over(true); }); card.addEventListener("dragover", (e) => { e.preventDefault(); over(true); });
      card.addEventListener("dragleave", (e) => { if (!card.contains(e.relatedTarget)) over(false); });
      card.addEventListener("drop", async (e) => { e.preventDefault(); over(false); const fs = [...((e.dataTransfer && e.dataTransfer.files) || [])]; if (fs.length) await importFiles(fs, curDevice); });
    }
    const zone = $("dropZone"); if (zone) zone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("impFile").click(); } });
    const pick = $("impFile");
    if (pick) pick.addEventListener("change", async (e) => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) await importFiles(fs, curDevice); });
    list.addEventListener("click", async (e) => {
      const head = e.target.closest(".dh-loc");
      if (head) {                                                                // swap the chip for an editor
        const date = head.dataset.date, cur = head.classList.contains("empty") || head.dataset.mixed ? "" : head.dataset.loc || "";
        await fillSuggestions();
        const span = document.createElement("span"); span.className = "dh-edit";
        span.innerHTML = `<input list="locList" maxlength="60" autocomplete="off" placeholder="e.g. Komodo" value="${esc(cur)}" aria-label="Location for ${esc(date)}"><button class="btn-set dh-save" type="button" data-date="${esc(date)}">Save</button><button class="btn-set dh-cancel" type="button" style="background:var(--bg-6c757d)" aria-label="Cancel">\u2715</button>`;
        head.replaceWith(span); span.querySelector("input").focus(); return;
      }
      const dask = e.target.closest(".del-ask");
      if (dask) {                                                                // ask before deleting: the dive is gone for good
        const row = dask.closest(".del-row"), n = row.dataset.fps.split(",").length - 1;
        row.innerHTML = `<div class="del-confirm" role="alertdialog" aria-label="Confirm delete"><b>Delete dive${row.dataset.num ? " " + esc(row.dataset.num) : ""}?</b>` +
          `<p>${esc(row.dataset.what)}</p><p>${n ? `The copy${n === 1 ? "" : "ies"} of this dive from another computer (${esc(row.dataset.copies)}) ${n === 1 ? "is" : "are"} deleted too. ` : ""}This cannot be undone, and the dive will not come back when you sync or import again. Copies on other people's accounts are not touched.</p>` +
          `<div class="row" style="margin:0"><button class="btn-set del-yes" type="button">Delete dive</button><button class="btn-set del-no" type="button" style="background:var(--bg-6c757d)">Keep it</button></div></div>`;
        row.querySelector(".del-no").focus(); return;
      }
      if (e.target.closest(".del-no")) { const row = e.target.closest(".del-row"); row.innerHTML = `<button class="del-ask" type="button">Delete this dive\u2026</button>`; return; }
      const dyes = e.target.closest(".del-yes");
      if (dyes) {
        const row = dyes.closest(".del-row"), fps = row.dataset.fps.split(","); dyes.disabled = true;
        const ok = await deleteDives(fps); say(ok ? (fps.length === 1 ? "Dive deleted" : `Dive deleted (and ${fps.length - 1} cop${fps.length === 2 ? "y" : "ies"} from other computers)`) : "Dive deleted on this device; it will be removed from your account when the connection is back", ok ? "ok" : "warn"); return;
      }
      const mset = e.target.closest(".mh-set");
      if (mset) {                                                                // bulk: one place for every dive of the month
        await fillSuggestions();
        const month = mset.dataset.month, n = (await all()).filter((r) => U.monthKey(r) === month).length, box = document.createElement("div"); box.className = "mh-edit";
        box.innerHTML = `<input type="text" list="locList" maxlength="60" autocomplete="off" placeholder="One place for all ${n} dives, e.g. Komodo" aria-label="Place for the whole month">
          <label class="chk"><input type="checkbox" class="mh-replace"> Replace places that are already set</label>
          <div class="row" style="margin:0"><button class="btn-set mh-save" type="button" data-month="${esc(month)}">Apply to the month</button><button class="btn-set dh-cancel" type="button" style="background:var(--bg-6c757d)">Cancel</button></div>`;
        mset.parentElement.appendChild(box); mset.style.display = "none"; box.querySelector("input[type=text]").focus(); return;
      }
      const msave = e.target.closest(".mh-save");
      if (msave) {
        const box = msave.closest(".mh-edit"), v = U.normalizeLocation(box.querySelector("input[type=text]").value), replace = box.querySelector(".mh-replace").checked;
        if (!v) { say("Type a place first", "warn"); return; }
        const targets = U.bulkTargets((await all()).filter((r) => U.monthKey(r) === msave.dataset.month), replace);
        if (!targets.length) { say("Every dive this month already has a place. Tick \u201cReplace\u201d to change them.", "warn"); return; }
        await setLocations(Object.fromEntries(targets.map((fp) => [fp, v]))); say(savedText(`Location saved for ${targets.length} dive${targets.length === 1 ? "" : "s"}`)); return;
      }
      if (e.target.closest(".dh-cancel")) { renderPending = false; render(); return; }
      const dsave = e.target.closest(".dh-save");
      if (dsave) {
        const date = dsave.dataset.date, v = dsave.parentElement.querySelector("input").value, rs = (await all()).filter((r) => U.dateKey(r) === date);
        await setLocations(Object.fromEntries(rs.map((r) => [r.fingerprint, v]))); say(U.normalizeLocation(v) ? savedText("Location saved") : "Location cleared"); return;
      }
      const vsave = e.target.closest(".dive-loc-save");
      if (vsave) { await setLocations({ [vsave.dataset.fp]: vsave.parentElement.querySelector("input").value }); say(savedText("Location saved")); }
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
    const own = everything.filter((r) => !r.sharedFrom);                              // the computers of this person (dives shared with you do not make a computer of yours)
    const { dup, extras } = U.duplicateGroups(everything), recs = U.uniqueDives(everything).reverse();    // the dive log: every dive once, newest first, the preferred computer's record
    $("diveCount").textContent = recs.length ? `(${recs.length})` : "";
    renderSummary(everything); renderDiverCard(); renderRegulatorCard(everything); updateBanner(recs); wireList(list);
    if (typeof PlacesUI !== "undefined") PlacesUI.render(everything);                  // map pins + places still to put on the map
    renderDeviceTabs(own);                                                              // the Import view: which dive computers, their sync / import cards
    const last = loadLast(), ls = $("lastSync");
    if (ls) { ls.textContent = last ? `Last sync ${new Date(last.at).toLocaleString()}: ${last.msg}` : "No sync yet on this phone."; ls.style.color = last && !last.ok ? "var(--tx-c92a2a)" : ""; }
    const cloudTxt = { ok: "\u2601 synced to cloud", unavailable: "\u2601 cloud unavailable", offline: "offline", signedout: "\ud83d\udd12 signed out: reload the page to sign in again", unknown: "" }[cloudState];
    $("cloudState").textContent = cloudTxt;
    const asc0 = recs.slice().reverse(), numbers = new Map(asc0.map((r, i) => [r.fingerprint, i + 1]));      // logbook numbers: 1 = your oldest dive
    const chip = (r) => `<span class="devchip">${esc((U.DEVICES.find((x) => x.id === U.deviceOf(r)) || { short: U.deviceOf(r) }).short)}</span>` + (r.sharedFrom ? `<span class="devchip shared" title="A dive shared with you">from ${esc(whoIs(r.sharedFrom))}</span>` : "");
    const alsoOn = (r) => { const hid = extras.get(r.fingerprint) || []; const names = [...new Set(hid.map((h) => (U.DEVICES.find((x) => x.id === U.deviceOf(h)) || { short: "another computer" }).short))]; return names.length ? `<span class="badge also" title="Also recorded by: ${esc(names.join(", "))}. This record is the one shown and counted.">also on ${esc(names.join(", "))}</span>` : ""; };
    if (!recs.length) { list.innerHTML = "<p class='muted'>No dives yet. Open <a href=\"#\" class=\"togo-import\">Import</a> to download or import the dives of your dive computer.</p>"; return; }
    const ae = document.activeElement;                                              // never rebuild the list under someone who is typing
    if (ae && ae.tagName === "INPUT" && (list.contains(ae) || ($("locPrompt") && $("locPrompt").contains(ae)))) { renderPending = true; return; }

    const resolved = {}; for (const r of recs) resolved[r.fingerprint] = { status: "ok" };                                  // imports are complete
    const cosmiqGroups = new Map(); for (const r of everything) if (U.deviceOf(r) === "cosmiq") { const k = (r.sharedFrom || "") + "|" + (r.deviceMac || ""); if (!cosmiqGroups.has(k)) cosmiqGroups.set(k, []); cosmiqGroups.get(k).push(r); }
    const reconciled = {}; for (const g of cosmiqGroups.values()) Object.assign(reconciled, P.reconcileProfiles(g));             // which Cosmiq+ profile really belongs to which dive (one computer at a time)
    for (const r of recs) if (reconciled[r.fingerprint]) resolved[r.fingerprint] = reconciled[r.fingerprint];
    const asc = recs.slice().reverse(), gapBefore = new Map();
    asc.forEach((r, i) => { if (i) gapBefore.set(r.fingerprint, (asMs(r.startedAt) - (asMs(asc[i - 1].startedAt) + asc[i - 1].durationSec * 1000)) / 60000); });

    const byYear = new Map();
    for (const r of recs) { const y = r.startedAt.slice(0, 4); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(r); }
    const years = [...byYear.keys()];                                                // newest first
    const openNow = list.querySelector("details.year") ? new Set([...list.querySelectorAll("details.year[open]")].map((e) => e.dataset.year)) : null;
    const openDives = new Set([...list.querySelectorAll("details.dive[open]")].map((e) => e.dataset.fp));
    const saved = loadYears(), open = openNow || new Set(saved || [years[0]]);
    const openMonthsNow = list.querySelector("details.mbox") ? new Set([...list.querySelectorAll("details.mbox[open]")].map((e) => e.dataset.month)) : null, savedMonths = loadOpen(MONTHS_KEY), openMonths = openMonthsNow || new Set(savedMonths || [recs[0].startedAt.slice(0, 7)]);   // the newest month starts open

    const rowHtml = (r) => {
      const st = resolved[r.fingerprint].status, num = numbers.get(r.fingerprint);
      return `<details class="dive" data-fp="${esc(r.fingerprint)}"><summary>
        ${numBox(num)}<span class="dive-date">${esc(fmtDate(r.startedAt).slice(11))}</span>
        <span class="dive-mode m-${esc(r.mode)}">${esc(r.mode)}</span>${chip(r)}${BADGE[st] ? `<span class="badge">${BADGE[st]}</span>` : ""}${alsoOn(r)}
        <span class="dive-meta">${r.maxDepthM.toFixed(1)} m \u00b7 ${fmtDur(r.durationSec)}${r.uploaded ? "" : " \u00b7 \u23f3"}</span></summary>
        <div class="dive-body"></div></details>`;
    };
    let html = "";    for (const y of years) {
      const g = byYear.get(y), secs = g.reduce((a, r) => a + r.durationSec, 0), deepest = Math.max(...g.map((r) => r.maxDepthM));
      const tile = (v, label) => `<div><b>${v}</b><span>${label}</span></div>`;
      html += `<details class="year" data-year="${y}"${open.has(y) ? " open" : ""}><summary><span class="yname">${y}</span><span class="ystats">${tile(g.length, g.length === 1 ? "dive" : "dives")}${tile(fmtDur(secs), "time")}${tile(deepest.toFixed(1) + " m", "deepest")}</span><span class="chev" aria-hidden="true">\u25B8</span></summary><div class="ybody">` +
        U.groupByMonth(g).map(({ month, recs: mrs }) => {
          const names = [...new Set(mrs.map((r) => r.location).filter(Boolean))], msecs = mrs.reduce((a, r) => a + r.durationSec, 0);
          const head = `<summary class="monthhead" data-month="${esc(month)}"><span class="mh-name"><span class="mh-chev" aria-hidden="true">\u25B8</span>${esc(new Date(+month.slice(0, 4), +month.slice(5) - 1, 1).toLocaleDateString(undefined, { month: "long" }))}</span><span class="mh-stat">${mrs.length} dive${mrs.length === 1 ? "" : "s"} \u00b7 ${fmtDur(msecs)} \u00b7 max ${Math.max(...mrs.map((r) => r.maxDepthM)).toFixed(1)} m</span>` +
            `<span class="mh-place">${names.length ? "\ud83d\udccd " + esc(names.join(", ")) : '<span class="muted">No place set</span>'}</span></summary>`;
          return `<details class="mbox" data-month="${esc(month)}"${openMonths.has(month) ? " open" : ""}>` + head + `<div class="mbody"><div class="mh-actions"><button class="mh-set" type="button" data-month="${esc(month)}">Set place for the month</button></div>` + U.groupByDate(mrs).map(({ date, recs: rs }) => {
            const dl = U.dateLocation(rs), label = dl.mixed ? "Mixed" : dl.location || "Add location";
            return `<div class="datehead"><span class="dh-date">${esc(fmtDayShort(date))}</span><button class="dh-loc${dl.location || dl.mixed ? "" : " empty"}" type="button" data-date="${esc(date)}" data-loc="${esc(dl.location)}"${dl.mixed ? ' data-mixed="1"' : ""}>\ud83d\udccd ${esc(label)}</button></div>` + rs.map(rowHtml).join("");
          }).join("") + `</div></details>`;
        }).join("") + `</div></details>`;
    }
    list.innerHTML = html; fillSuggestions();
    list.querySelectorAll("details.year").forEach((el) => el.addEventListener("toggle", () => {
      try { localStorage.setItem(YEARS_KEY, JSON.stringify([...list.querySelectorAll("details.year[open]")].map((e) => e.dataset.year))); } catch (e) {}
    }));
    list.querySelectorAll("details.mbox").forEach((el) => el.addEventListener("toggle", () => {
      try { localStorage.setItem(MONTHS_KEY, JSON.stringify([...list.querySelectorAll("details.mbox[open]")].map((e) => e.dataset.month))); } catch (e) {}
    }));
    list.querySelectorAll("details.dive").forEach((el) => el.addEventListener("toggle", async () => {
      if (!el.open || el.dataset.done) return;
      const rec = recs.find((r) => r.fingerprint === el.dataset.fp);
      try { el.querySelector(".dive-body").innerHTML = detail(rec, resolved[rec.fingerprint], gapBefore.get(rec.fingerprint) ?? null, numbers.get(rec.fingerprint)); el.dataset.done = 1; }
      catch (e) { el.querySelector(".dive-body").textContent = "Cannot parse this dive: " + e.message; }
      const copies = (extras.get(rec.fingerprint) || []).map((x) => x.fingerprint), names = (extras.get(rec.fingerprint) || []).map((x) => (U.DEVICES.find((d) => d.id === U.deviceOf(x)) || { short: U.deviceOf(x) }).short);
      const row = document.createElement("div"); row.className = "del-row"; row.dataset.fps = [rec.fingerprint, ...copies].join(","); row.dataset.what = `${fmtDate(rec.startedAt)} \u00b7 ${rec.maxDepthM.toFixed(1)} m \u00b7 ${fmtDur(rec.durationSec)}`; row.dataset.num = numbers.get(rec.fingerprint) || ""; row.dataset.copies = [...new Set(names)].join(", ");
      row.innerHTML = `<button class="del-ask" type="button">Delete this dive\u2026</button>`; el.querySelector(".dive-body").appendChild(row);
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

  return { claimDevice, forgetShared, syncFromDevice, syncPeregrine, probeShearwater, importFiles, deleteDives, render, revealPrompt, setLocations, cloudPull, cloudPush, exportBackup, all, copyDiagnostics, downloadDiagnostics };
})();
