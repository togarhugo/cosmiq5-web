/* Account area: profile picture, dive certifications (files), regulator service counter, help / app version.
 * Everything is stored in the signed-in user's private account (see src/account-data.js); the avatar and regulator are also
 * cached on the phone so the header and the Summary render instantly and offline. */
"use strict";

const AccountArea = (() => {
  const $ = (id) => document.getElementById(id);
  const U = window.DiveUtils;
  const say = (t, kind) => { if (window.toast) window.toast(t, kind || "ok"); };
  const store = { get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
  let me = null, regulator = store.get("regulator"), armed = null;

  async function api(method, path, body) {
    const r = await fetch(path, { method, credentials: "same-origin", redirect: "error", headers: { "content-type": "application/json" }, body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body || {}) });
    let data = {}; try { data = await r.json(); } catch (e) {}
    if (!r.ok) throw Object.assign(new Error(data.error || "Request failed (" + r.status + ")"), { status: r.status });
    return data;
  }
  const note = (id, text, bad) => { const el = $(id); if (!el) return; el.textContent = text || ""; el.style.color = bad ? "var(--tx-c92a2a)" : "var(--tx-2b8a3e)"; };
  /** Two-step button: first tap arms it ("Tap again to ..."), a second tap within 4 s confirms. */
  function confirmTap(btn, label, action) {
    if (armed && armed.btn === btn) { clearTimeout(armed.t); btn.textContent = armed.orig; btn.classList.remove("armed"); armed = null; return action(); }
    if (armed) { clearTimeout(armed.t); armed.btn.textContent = armed.orig; armed = null; }
    const orig = btn.textContent; btn.textContent = label; btn.classList.add("armed");
    armed = { btn, orig, t: setTimeout(() => { btn.textContent = orig; btn.classList.remove("armed"); armed = null; }, 4000) };
  }

  // ---------- images ----------
  async function loadImage(file) {
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); return img; }
    catch (e) { throw new Error("That picture format is not supported. Choose a JPEG or PNG."); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
  }
  function canvasOf(img, w, h, sx, sy, sw, sh) { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(img, sx, sy, sw, sh, 0, 0, w, h); return c; }

  // ---------- profile picture ----------
  function setAvatar(dataUrl) {
    for (const [img, icon] of [["acctImg", "acctIcon"], ["profImg", "profIcon"]]) {
      const i = $(img), c = $(icon); if (!i) continue;
      if (dataUrl) { i.src = dataUrl; i.hidden = false; c.style.display = "none"; } else { i.hidden = true; i.removeAttribute("src"); c.style.display = ""; }
    }
    $("avatarRemove").style.display = dataUrl ? "" : "none";
    store.set("avatar", dataUrl || null);
  }
  async function pickAvatar(file) {
    note("profMsg", "");
    try {
      const img = await loadImage(file), s = Math.min(img.naturalWidth, img.naturalHeight);
      const c = canvasOf(img, 256, 256, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s);
      let q = 0.86, url = c.toDataURL("image/jpeg", q);
      while (url.length > 140000 && q > 0.4) { q -= 0.1; url = c.toDataURL("image/jpeg", q); }
      await api("PUT", "/api/profile/avatar", { dataUrl: url });
      setAvatar(url); say("Profile picture updated"); note("profMsg", "Profile picture updated.");
    } catch (e) { note("profMsg", e.message, true); }
  }

  // ---------- diver profile: name, DAN membership, latest certification (all shown on the Summary) ----------
  let diverData = store.get("diver") || { fullName: "", dan: { number: "", plan: "", validUntil: "" }, latestCert: null };
  const saveDiver = () => store.set("diver", diverData);
  const fmtDay = (key) => { if (!key) return ""; const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); };
  /** What the Summary shows: the saved name (else the Google name), DAN details and the latest certification. */
  function diver() { return { name: diverData.fullName || (me && me.name) || "", dan: diverData.dan, latestCert: diverData.latestCert }; }
  function renderDan() {
    const d = diverData.dan, st = U.danStatus(d.validUntil, new Date());
    for (const [id, v] of [["danNumber", d.number], ["danPlan", d.plan], ["danValid", d.validUntil]]) if (document.activeElement !== $(id)) $(id).value = v || "";
    const badge = $("danBadge");
    if (d.number) {
      badge.textContent = st.state === "none" ? "Member" : st.state === "expired" ? "Expired" : st.state === "soon" ? U.danText(st.days) : "Valid";
      badge.className = "regbadge " + (st.state === "expired" ? "expired" : st.state === "soon" ? "soon" : ""); badge.style.display = "";
    } else badge.style.display = "none";
    const line = $("danState");
    line.textContent = !d.number ? "" : st.state === "none" ? "Add the date your membership is valid until to see when it needs renewing."
      : st.state === "expired" ? `Expired ${fmtDay(d.validUntil)} \u00b7 ${st.days === -1 ? "yesterday" : -st.days + " days ago"}` : `Valid until ${fmtDay(d.validUntil)} \u00b7 ${U.danText(st.days)}`;
    line.style.color = st.state === "expired" ? "var(--tx-c92a2a)" : st.state === "soon" ? "var(--tx-d9480f)" : st.state === "ok" ? "var(--tx-2b8a3e)" : "";
    Dives.render();                                                              // refresh the Summary card
  }
  async function saveName() {
    const v = $("fullName").value.trim();
    try { await api("PUT", "/api/profile/name", { fullName: v }); diverData.fullName = v; saveDiver(); say(v ? "Name saved" : "Name removed"); note("profMsg", ""); Dives.render(); }
    catch (e) { note("profMsg", e.message, true); }
  }
  async function saveDan() {
    const number = $("danNumber").value.trim();
    if (!number) return note("danState", "Enter your DAN member number.", true);
    try {
      const body = { number, plan: $("danPlan").value.trim(), validUntil: $("danValid").value };
      await api("PUT", "/api/profile/dan", body); diverData.dan = body; saveDiver(); say("DAN details saved"); renderDan();
    } catch (e) { note("danState", e.message, true); }
  }
  async function clearDan() {
    try { await api("DELETE", "/api/profile/dan"); diverData.dan = { number: "", plan: "", validUntil: "" }; saveDiver(); say("DAN details removed"); renderDan(); }
    catch (e) { note("danState", e.message, true); }
  }

  // ---------- files: dive certifications and DAN insurance documents (same mechanism, told apart by `kind`) ----------
  const fmtSize = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1000)) + " KB");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function toBase64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  const fromBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  /** Image -> JPEG under ~900 KB (longest side 2000 px); PDF -> as is (must be under 1 MB). Returns {mime, filename, data(base64)}. */
  async function prepareFile(file) {
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      if (file.size > 1_000_000) throw new Error("That PDF is " + fmtSize(file.size) + ". The limit is 1 MB: try a smaller export or a photo of the card.");
      return { mime: "application/pdf", filename: file.name, data: toBase64(new Uint8Array(await file.arrayBuffer())) };
    }
    const img = await loadImage(file), k = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
    let w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k), q = 0.88, url;
    for (let i = 0; i < 8; i++) {
      url = canvasOf(img, w, h, 0, 0, img.naturalWidth, img.naturalHeight).toDataURL("image/jpeg", q);
      if (url.length * 0.75 <= 900_000) break;
      if (q > 0.55) q -= 0.1; else { w = Math.round(w * 0.8); h = Math.round(h * 0.8); }
    }
    if (url.length * 0.75 > 1_000_000) throw new Error("That picture is too large even after shrinking it.");
    return { mime: "image/jpeg", filename: file.name.replace(/\.[^.]*$/, "") + ".jpg", data: url.split(",")[1] };
  }

  let allFiles = [], pinnedCert = diverData.pinnedCertId || "";
  const FILE_KINDS = [
    { kind: "cert", list: "certList", label: "certLabel", number: "certNumber", date: "certDate", file: "certFile", fileName: "certFileName", add: "certAdd", msg: "certMsg", none: "No certifications yet.", numberTag: "#", deleted: "Certification deleted", uploaded: "Certification uploaded" },
    { kind: "dan", list: "danList", label: "danLabel", number: "danDocNumber", file: "danFile", fileName: "danFileName", add: "danAdd", msg: "danMsg", none: "No insurance documents yet.", numberTag: "policy #", deleted: "Document deleted", uploaded: "Insurance document uploaded", defaultLabel: "DAN insurance card" },
  ];
  const fileCache = new Map();                                                   // id -> {url, mime, filename, label}: scans are fetched once and kept for the session
  let openCert = "";                                                             // the card that is expanded ("" = the stack is closed)
  const tint = (label) => { let n = 0; for (const ch of String(label)) n = (n * 31 + ch.charCodeAt(0)) >>> 0; return `hsl(${n % 360} 48% 34%)`; };
  function certCard(f, isMain, i, n) {
    const sub = [f.number ? "#" + esc(f.number) : "", f.certifiedOn ? esc(fmtDay(f.certifiedOn)) : ""].filter(Boolean).join(" \u00b7 ");
    const open = openCert === f.id;
    return `<article class="cert wcard${isMain ? " main" : ""}${open ? " open" : ""}" data-id="${esc(f.id)}" style="z-index:${n - i}">
      <div class="wface" role="button" tabindex="0" aria-expanded="${open}" aria-label="${esc(f.label)}"><div class="wimg" style="--tint:${tint(f.label)}"></div><div class="wshade"></div>
        <div class="wtitle">${esc(f.label)}${f.certifiedOn ? `<small>${esc(fmtDay(f.certifiedOn))}</small>` : ""}</div>${isMain ? '<span class="latest-tag">\u2605 Main</span>' : ""}
        <button class="wclose cert-close" type="button" aria-label="Close">\u2715</button></div>
      <div class="wfoot"><div class="wf-title"><b>${esc(f.label)}</b>${isMain ? '<span class="cc-mainbadge">\u2605 Main certification</span>' : ""}</div><div class="wf-sub muted">${sub || "No number or date added"}</div>
        <div class="row wrap" style="margin:0">${isMain ? "" : '<button class="btn-set cert-latest" type="button">Make main</button>'}<a class="btn-set cert-full" href="#" target="_blank" rel="noopener" style="background:var(--bg-6c757d)">${f.mime === "application/pdf" ? "Open PDF" : "Full size"}</a><button class="btn-set cert-save" type="button" style="background:var(--bg-6c757d)">Save</button>${navigator.canShare ? '<button class="btn-set cert-share" type="button" style="background:var(--bg-6c757d)">Share</button>' : ""}<button class="btn-set cert-del" type="button" style="background:var(--bg-c92a2a)">Delete</button></div></div></article>`;
  }
  /** Natural height of the open card's scan at the current width (capped to the screen), so it can grow smoothly. */
  function sizeOpenCard() {
    for (const card of document.querySelectorAll("#certList .wcard")) {
      const img = card.querySelector(".wimg"); if (!img) continue;
      if (card.dataset.id === openCert) { const r = Number(card.dataset.ratio) || 0.7; img.style.height = Math.min(Math.round(img.clientWidth * r), Math.round(window.innerHeight * 0.8)) + "px"; } else img.style.height = "";
    }
  }
  async function fillFace(card) {
    const id = card.dataset.id; if (!id || card.dataset.done) return; card.dataset.done = "1";
    try {
      let c = fileCache.get(id);
      if (!c) { const { cert, blob } = await fetchFile(id); c = { url: URL.createObjectURL(blob), mime: cert.mime, filename: cert.filename, label: cert.label }; fileCache.set(id, c); }
      const box = card.querySelector(".wimg"), full = card.querySelector(".cert-full"); full.href = c.url;
      if (c.mime === "application/pdf") { card.dataset.ratio = "0.62"; box.innerHTML = `<div class="wpdf"><span class="pdfmark">PDF</span></div>`; sizeOpenCard(); }
      else { const im = new Image(); im.alt = c.label; im.onload = () => { card.dataset.ratio = String(im.naturalHeight / im.naturalWidth); sizeOpenCard(); }; im.src = c.url; box.innerHTML = ""; box.appendChild(im); }
    } catch (e) { card.dataset.done = ""; }
  }
  async function loadFaces() {                                                   // a few at a time, so the whole stack fills in without a burst of requests
    const cards = [...document.querySelectorAll("#certList .wcard")].filter((c) => !c.dataset.done);
    for (let i = 0; i < cards.length; i += 3) await Promise.all(cards.slice(i, i + 3).map(fillFace));
  }
  function toggleCert(id, want) {
    openCert = want === false || (want === undefined && openCert === id) ? "" : id;
    document.querySelectorAll("#certList .wcard").forEach((c) => { const o = c.dataset.id === openCert; c.classList.toggle("open", o); c.querySelector(".wface").setAttribute("aria-expanded", o); });
    sizeOpenCard();
    const c = openCert && document.querySelector(`#certList .wcard[data-id="${openCert}"]`);
    if (c && c.scrollIntoView) setTimeout(() => c.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  }
  window.addEventListener("resize", () => { if (openCert) sizeOpenCard(); });
  function renderFiles() {
    for (const c of FILE_KINDS) {
      const box = $(c.list); if (!box) continue;
      const mine = allFiles.filter((f) => (f.kind || "cert") === c.kind).sort((a, b) => (b.certifiedOn || "").localeCompare(a.certifiedOn || "") || String(b.createdAt).localeCompare(String(a.createdAt)));
      const latest = c.kind === "cert" ? U.latestCert(allFiles, pinnedCert) : null;
      if (c.kind === "cert") {                                                    // certificates: the main one first, then newest to oldest, each on its own card
        mine.sort((a, b) => (latest && b.id === latest.id) - (latest && a.id === latest.id));
        if (openCert && !mine.some((f) => f.id === openCert)) openCert = "";
        box.innerHTML = mine.length ? mine.map((f, i) => certCard(f, latest && latest.id === f.id, i, mine.length)).join("") : `<div class="card muted">${c.none} Tap <b>Add a certificate</b> to upload a scan or PDF of your card.</div>`;
        if ($("certCount")) $("certCount").textContent = mine.length ? `\u00b7 ${mine.length}` : "";
        if ($("certWalletHint")) $("certWalletHint").style.display = mine.length ? "" : "none";
        loadFaces(); sizeOpenCard(); continue;
      }
      box.innerHTML = mine.length ? mine.map((f) => { const isLatest = latest && latest.id === f.id; return `<div class="cert${isLatest ? " latest" : ""}" data-id="${esc(f.id)}"><div class="cert-top"><b>${esc(f.label)}</b>${isLatest ? '<span class="latest-tag">\u2605 Latest</span>' : ""}${f.number ? `<span class="muted">${c.numberTag}${esc(f.number)}</span>` : ""}${f.certifiedOn ? `<span class="muted">\u00b7 ${esc(fmtDay(f.certifiedOn))}</span>` : ""}<span class="muted">${esc(f.filename)} \u00b7 ${fmtSize(f.size)}</span></div>
        <div class="row wrap" style="margin:8px 0 0"><button class="btn-set cert-view" type="button">${f.mime === "application/pdf" ? "Open" : "View"}</button><button class="btn-set cert-save" type="button" style="background:var(--bg-6c757d)">Save</button>${navigator.canShare ? '<button class="btn-set cert-share" type="button" style="background:var(--bg-6c757d)">Share</button>' : ""}<button class="btn-set cert-del" type="button" style="background:var(--bg-6c757d)">Delete</button></div>${c.kind === "cert" && !isLatest ? '<div class="row" style="margin:8px 0 0"><button class="btn-set cert-latest" type="button" style="background:var(--bg-2b8a3e)">Set as my latest certification</button></div>' : ""}<div class="cert-preview"></div></div>`; }).join("")
        : `<p class="muted" style="margin:0">${c.none}</p>`;
    }
    if (pinnedCert && !allFiles.some((f) => f.id === pinnedCert && (f.kind || "cert") === "cert")) pinnedCert = "";   // the pinned file was deleted: back to automatic
    diverData.pinnedCertId = pinnedCert;
    diverData.latestCert = (({ label, number, certifiedOn, createdAt } = {}) => (label ? { label, number, certifiedOn, createdAt } : null))(U.latestCert(allFiles, pinnedCert) || {});
    const hint = $("certLatestHint");
    if (hint) hint.textContent = !allFiles.some((f) => (f.kind || "cert") === "cert") ? "" : pinnedCert ? "You chose your main certification yourself. It is the one shown on your Overview." : "Your main certification is shown on the Summary: the newest by date. Open another card and tap \u201cMake main\u201d to choose it yourself.";
    if ($("certAuto")) $("certAuto").style.display = pinnedCert ? "" : "none";
    saveDiver(); Dives.render();
  }
  async function loadFiles() {
    try { allFiles = (await api("GET", "/api/certs")).certs; renderFiles(); }
    catch (e) { for (const c of FILE_KINDS) if ($(c.list)) $(c.list).innerHTML = `<p class="muted">${e.status === 401 ? "Signed out: reload the page." : "Could not load: " + esc(e.message)}</p>`; }
  }
  function hideCertAdd() { $("certAddBox").style.display = "none"; $("certShowAdd").style.display = ""; }
  async function fetchFile(id) { const { cert } = await api("GET", "/api/certs/" + id); return { cert, blob: new Blob([fromBase64(cert.data)], { type: cert.mime }) }; }
  async function fileAction(cfg, e) {
    const item = e.target.closest(".cert"); if (!item) return;
    const id = item.dataset.id, btn = e.target.closest("button");
    if (cfg.kind === "cert") {
      if (e.target.closest("a")) return;                                          // "Full size" / "Open PDF" are plain links
      if (btn && btn.classList.contains("cert-close")) return toggleCert(id, false);
      if (!btn && e.target.closest(".wface")) return toggleCert(id, openCert === id ? false : true);
    }
    if (!btn) return;
    try {
      if (btn.classList.contains("cert-latest")) { await api("PUT", "/api/profile/latest-cert", { id }); pinnedCert = id; openCert = id; say("Main certification updated"); renderFiles(); const m = document.querySelector("#certList .wcard.main"); if (m && m.scrollIntoView) setTimeout(() => m.scrollIntoView({ behavior: "smooth", block: "start" }), 60); return; }
      if (btn.classList.contains("cert-del")) return confirmTap(btn, "Tap again to delete", async () => { await api("DELETE", "/api/certs/" + id); const c = fileCache.get(id); if (c) { URL.revokeObjectURL(c.url); fileCache.delete(id); } if (openCert === id) openCert = ""; say(cfg.deleted); loadFiles(); });
      const { cert, blob } = await fetchFile(id), url = URL.createObjectURL(blob);
      if (btn.classList.contains("cert-view")) {
        if (cert.mime === "application/pdf") { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.click(); }
        else { const p = item.querySelector(".cert-preview"); p.innerHTML = p.firstChild ? "" : `<img class="preview" alt="${esc(cert.label)}" src="${url}">`; }
      } else if (btn.classList.contains("cert-save")) { const a = document.createElement("a"); a.href = url; a.download = cert.filename; a.click(); }
      else if (btn.classList.contains("cert-share")) {
        const file = new File([blob], cert.filename, { type: cert.mime });
        if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: cert.label }); else note(cfg.msg, "Sharing files is not supported here: use Save.", true);
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { if (err.name !== "AbortError") note(cfg.msg, err.message, true); }
  }
  async function addFile(cfg) {
    const label = $(cfg.label).value.trim(), file = $(cfg.file).files[0];
    if (!label) return note(cfg.msg, "Give it a name.", true);
    if (!file) return note(cfg.msg, "Choose a file first.", true);
    const btn = $(cfg.add); btn.disabled = true; btn.textContent = "Uploading\u2026"; note(cfg.msg, "");
    try {
      const f = await prepareFile(file);
      await api("POST", "/api/certs", { kind: cfg.kind, label, number: $(cfg.number).value.trim(), certifiedOn: cfg.date ? $(cfg.date).value : "", ...f });
      for (const id of [cfg.label, cfg.number, cfg.date, cfg.file]) if (id) $(id).value = "";
      $(cfg.fileName).textContent = ""; say(cfg.uploaded); note(cfg.msg, "Uploaded."); if (cfg.kind === "cert") hideCertAdd(); loadFiles();
    } catch (e) { note(cfg.msg, e.message, true); }
    finally { btn.disabled = false; btn.textContent = "Upload"; }
  }

  // ---------- regulator ----------
  const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString(undefined, { month: "long" }));
  /** Fills a pair of month/year selects. `blank` adds a "not set" choice. Years run from 15 years back to this year. */
  function fillMonthPicker(mId, yId, value, blank) {
    const now = new Date(), m = $(mId), y = $(yId), cur = value ? value.split("-") : null;
    const opt = (v, t) => `<option value="${v}">${t}</option>`;
    m.innerHTML = (blank ? opt("", "Month") : "") + MONTHS.map((n, i) => opt(String(i + 1).padStart(2, "0"), n)).join("");
    y.innerHTML = (blank ? opt("", "Year") : "") + Array.from({ length: 16 }, (_, i) => now.getFullYear() - i).map((v) => opt(v, v)).join("");
    if (cur) { m.value = cur[1]; if (![...y.options].some((o) => o.value === cur[0])) y.insertAdjacentHTML("beforeend", opt(cur[0], cur[0])); y.value = cur[0]; }
    else if (!blank) { m.value = String(now.getMonth() + 1).padStart(2, "0"); y.value = String(now.getFullYear()); }
  }
  /** "YYYY-MM" from a picker, "" when left blank, null when only half filled or in the future. */
  function readMonthPicker(mId, yId) {
    const m = $(mId).value, y = $(yId).value; if (!m && !y) return ""; if (!m || !y) return null;
    const v = y + "-" + m, now = new Date(); return v > now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") ? null : v;
  }
  async function renderRegulator() {
    const recs = await Dives.all(), reg = regulator, form = $("regForm"), rform = $("regResetForm");
    $("regStatus").style.display = reg && form.style.display === "none" ? "" : "none";
    $("regAdd").style.display = !reg && form.style.display === "none" ? "" : "none";
    const badge = $("regBadge");
    if (reg) {
      const st = U.regulatorStatus(reg, recs, new Date());
      $("regShownName").textContent = reg.name; $("regShownType").textContent = reg.type ? "\u00b7 " + reg.type : ""; $("regShownCount").textContent = st.dives;
      $("regShownMonthsWrap").style.display = st.months == null ? "none" : ""; if (st.months != null) { $("regShownMonths").textContent = st.months; $("regShownMonthsUnit").textContent = st.months === 1 ? "month" : "months"; }
      $("regShownLast").textContent = reg.serviced ? `Last service: ${U.monthLabel(reg.serviced)}` : "Last service: not set";
      $("regShownEvery").textContent = "Service every " + [st.limitDives ? st.limitDives + " dives" : "", st.limitMonths ? st.limitMonths + " months" : ""].filter(Boolean).join(" or ");
      const msg = $("regShownMsg"); msg.textContent = U.regulatorMessage(st); msg.className = "reg-msg " + (st.level === "red" ? "lv-red" : st.level === "orange" ? "lv-orange" : "");
      const worst = st.level === "unknown" ? "" : st.level;
      badge.textContent = st.dives + (st.dives === 1 ? " dive" : " dives") + (st.months != null ? " \u00b7 " + st.months + " mo" : ""); badge.className = "regbadge " + (worst === "ok" ? "" : worst); badge.style.display = "";
      const hist = reg.history || [];
      $("regHistory").style.display = hist.length ? "" : "none"; $("regHistoryCount").textContent = hist.length ? "(" + hist.length + ")" : "";
      $("regHistoryList").innerHTML = hist.map((h) => `<li><span>${U.monthLabel(h.m)}</span><span>${h.dives} ${h.dives === 1 ? "dive" : "dives"} on it</span></li>`).join("");
    } else { badge.style.display = "none"; rform.style.display = "none"; }
    Dives.render();                                                       // refreshes the Summary card too
  }
  const setReg = (r) => { regulator = r; store.set("regulator", r); };
  function openRegForm(reg) {
    $("regName").value = reg ? reg.name : ""; $("regType").value = reg ? reg.type : ""; $("regBase").value = reg ? reg.baseline : 0;
    fillMonthPicker("regSvcMonth", "regSvcYear", reg ? reg.serviced : "", true);
    $("regLimDives").value = reg && reg.limitDives != null ? reg.limitDives : 90; $("regLimMonths").value = reg && reg.limitMonths != null ? reg.limitMonths : 12;
    $("regForm").style.display = ""; $("regStatus").style.display = "none"; $("regAdd").style.display = "none"; $("regName").focus();
  }
  async function saveReg() {
    const name = $("regName").value.trim(), base = Number($("regBase").value), ld = Number($("regLimDives").value), lm = Number($("regLimMonths").value);
    const serviced = readMonthPicker("regSvcMonth", "regSvcYear");
    if (!name) return note("regMsg", "Enter the regulator's name.", true);
    if (!Number.isInteger(base) || base < 0 || base > 99999) return note("regMsg", "Dives already on it must be a whole number, 0 or more.", true);
    if (serviced === null) return note("regMsg", "Pick both a month and a year for the last service, and not a month in the future.", true);
    if (!Number.isInteger(ld) || (ld !== 0 && (ld < 10 || ld > 1000))) return note("regMsg", "Service every: dives must be 0 (off) or between 10 and 1000.", true);
    if (!Number.isInteger(lm) || (lm !== 0 && (lm < 3 || lm > 60))) return note("regMsg", "Service every: months must be 0 (off) or between 3 and 60.", true);
    if (!ld && !lm) return note("regMsg", "Keep at least one reminder: by dives or by months.", true);
    try {
      const recs = await Dives.all();
      const next = { name, type: $("regType").value.trim(), baseline: base, since: regulator ? regulator.since : U.regulatorReset({}, recs).since,    // a new regulator counts dives after today's last logged one
        serviced, limitDives: ld, limitMonths: lm, history: regulator ? regulator.history || [] : [] };
      await api("PUT", "/api/regulator", next); setReg(next); $("regForm").style.display = "none"; note("regMsg", ""); say("Regulator saved"); renderRegulator();
    } catch (e) { note("regMsg", e.message, true); }
  }
  function openResetForm() { fillMonthPicker("regRstMonth", "regRstYear", "", false); $("regResetForm").style.display = ""; $("regRstMonth").focus(); }
  async function resetReg() {
    const serviced = readMonthPicker("regRstMonth", "regRstYear");
    if (!serviced) return note("regMsg", "Pick the month and year of the service (not in the future).", true);
    try {
      const next = U.regulatorReset(regulator, await Dives.all(), { serviced });
      await api("PUT", "/api/regulator", next); setReg(next); $("regResetForm").style.display = "none"; note("regMsg", ""); say("Regulator counter reset to 0"); renderRegulator();
    } catch (e) { note("regMsg", e.message, true); }
  }
  async function removeReg() {
    try { await api("DELETE", "/api/regulator"); setReg(null); say("Regulator removed"); renderRegulator(); } catch (e) { note("regMsg", e.message, true); }
  }

  // ---------- share dives with the other person who uses this app ----------
  const whoIs = (email) => { const t = String(email || "").split("@")[0].split(/[._-]/)[0]; return t.charAt(0).toUpperCase() + t.slice(1); };
  let shareInfo = { targets: [], received: [] }, sharePreviewed = null;
  const shareBody = () => ({ to: $("shareTo").value, from: $("shareFrom").value, until: $("shareUntil").value });
  async function loadShare() {
    try { shareInfo = await api("GET", "/api/share"); } catch (e) { return; }
    const sel = $("shareTo"), keep = sel.value; sel.innerHTML = shareInfo.targets.map((t) => `<option value="${esc(t)}">${esc(whoIs(t))} (${esc(t)})</option>`).join(""); if (keep && shareInfo.targets.includes(keep)) sel.value = keep;
    $("shareOut").style.display = shareInfo.targets.length ? "" : "none"; $("shareNone").style.display = shareInfo.targets.length ? "none" : "";
    const rec = shareInfo.received; $("shareIn").style.display = rec.length ? "" : "none";
    $("shareInList").innerHTML = rec.map((r) => `<div class="row" style="margin:4px 0;align-items:center"><span><b>${r.count}</b> dive${r.count === 1 ? "" : "s"} from <b>${esc(whoIs(r.from))}</b> <span class="muted">(${esc(r.first.slice(0, 7))} to ${esc(r.last.slice(0, 7))})</span></span><button class="btn-set share-remove" type="button" data-from="${esc(r.from)}" style="background:var(--bg-6c757d)">Remove</button></div>`).join("");
    const badge = $("shareBadge"), n = rec.reduce((a, r) => a + r.count, 0); badge.textContent = n + " shared with you"; badge.style.display = n ? "" : "none";
  }
  async function previewShare() {
    sharePreviewed = null; $("shareCopyBtn").disabled = true; note("shareMsg", "");
    try {
      const r = await api("POST", "/api/share/preview", shareBody()), who = whoIs($("shareTo").value);
      $("sharePreview").innerHTML = r.total ? `<b>${r.total}</b> dive${r.total === 1 ? "" : "s"} would be copied to ${esc(who)}:<ul style="margin:6px 0 0">` + r.byYear.map((y) => `<li>${esc(y.year)}: ${y.count}</li>`).join("") + "</ul>" : "No dives of yours in that period.";
      if (r.total) { sharePreviewed = { ...shareBody(), total: r.total }; $("shareCopyBtn").disabled = false; $("shareCopyBtn").textContent = `Copy ${r.total} dive${r.total === 1 ? "" : "s"} to ${who}`; }
    } catch (e) { note("shareMsg", e.message, true); }
  }
  async function copyShare() {
    if (!sharePreviewed) return; const who = whoIs(sharePreviewed.to);
    try { const r = await api("POST", "/api/share/copy", { to: sharePreviewed.to, from: sharePreviewed.from, until: sharePreviewed.until });
      say(`${r.copied} dive${r.copied === 1 ? "" : "s"} copied to ${who}`); note("shareMsg", r.copied ? `${r.copied} new dive${r.copied === 1 ? "" : "s"} copied to ${who}'s account.` + (r.copied < sharePreviewed.total ? ` ${sharePreviewed.total - r.copied} ${sharePreviewed.total - r.copied === 1 ? "was" : "were"} already there.` : "") : `Nothing new: all ${sharePreviewed.total} were already in ${who}'s account.`);
    } catch (e) { note("shareMsg", e.message, true); }
  }
  async function removeShared(btn) {
    const from = btn.dataset.from;
    try { const r = await api("POST", "/api/share/remove", { from }); await Dives.forgetShared(from); say(`${r.removed} dive${r.removed === 1 ? "" : "s"} removed`); await loadShare(); Dives.render(); } catch (e) { note("shareMsg", e.message, true); }
  }

  // ---------- help / version ----------
  async function checkUpdate() {
    note("helpMsg", "Checking…");
    try {
      const regs = (navigator.serviceWorker && (await navigator.serviceWorker.getRegistrations())) || [];
      await Promise.all(regs.map((r) => r.unregister()));
      if (window.caches) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
    } catch (e) {}
    location.reload();
  }
  function showVersions() {
    $("appVer").textContent = "v" + (self.APP_VERSION || "?");
    const sv = me && me.version, el = $("serverVer");
    el.textContent = !sv ? "" : sv === self.APP_VERSION ? "You have the latest version." : `A newer version (v${sv}) is available: tap "Check for update".`;
    el.style.color = sv && sv !== self.APP_VERSION ? "var(--tx-e67700)" : "";
  }

  function open(sec) { const d = document.querySelector(`details.acc[data-sec="${sec}"]`); if (d) { d.open = true; d.scrollIntoView({ block: "start" }); } }
  async function init() {
    showVersions(); setAvatar(store.get("avatar"));
    fetch("/api/me", { credentials: "same-origin", redirect: "error" }).then((r) => (r.ok ? r.json() : null)).then((m) => {
      if (!m) return; me = m; $("who").textContent = m.email; showVersions();
      if (!$("fullName").value && !diverData.fullName && m.name) $("fullName").value = m.name;   // suggest the Google name; saved only when you tap Save
      Dives.render();
    }).catch(() => {});
    api("GET", "/api/profile").then((p) => {
      setAvatar(p.avatar); pinnedCert = p.latestCertId || ""; diverData.fullName = p.fullName || ""; diverData.dan = p.dan || diverData.dan; saveDiver();
      if (document.activeElement !== $("fullName")) $("fullName").value = diverData.fullName || (me && me.name) || "";
      renderDan();
    }).catch(() => renderDan());
    loadFiles();
    api("GET", "/api/regulator").then((r) => { setReg(r.regulator); renderRegulator(); }).catch(() => renderRegulator());
    $("avatarFile").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) pickAvatar(f); });
    $("avatarRemove").addEventListener("click", async () => { try { await api("DELETE", "/api/profile/avatar"); setAvatar(null); say("Profile picture removed"); note("profMsg", ""); } catch (e) { note("profMsg", e.message, true); } });
    for (const cfg of FILE_KINDS) {                                              // certifications and DAN documents share one mechanism
      $(cfg.file).addEventListener("change", (e) => { const f = e.target.files[0]; $(cfg.fileName).textContent = f ? f.name : ""; if (f && !$(cfg.label).value) $(cfg.label).value = cfg.defaultLabel || f.name.replace(/\.[^.]*$/, "").replace(/[_-]+/g, " ").slice(0, 80); });
      $(cfg.add).addEventListener("click", () => addFile(cfg)); $(cfg.list).addEventListener("click", (e) => fileAction(cfg, e));
    }
    $("certList").addEventListener("keydown", (e) => { const f = e.target.closest && e.target.closest(".wface"); if (f && e.target === f && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); const id = f.closest(".wcard").dataset.id; toggleCert(id, openCert === id ? false : true); } });
    $("sharePreviewBtn").addEventListener("click", previewShare); for (const id of ["shareTo", "shareFrom", "shareUntil"]) $(id).addEventListener("change", () => { sharePreviewed = null; $("shareCopyBtn").disabled = true; $("shareCopyBtn").textContent = "Copy dives"; });
    $("shareCopyBtn").addEventListener("click", (e) => { if (sharePreviewed) confirmTap(e.currentTarget, "Tap again to copy", copyShare); });
    $("shareInList").addEventListener("click", (e) => { const b = e.target.closest(".share-remove"); if (b) confirmTap(b, "Tap again to remove", () => removeShared(b)); });
    $("certShowAdd").addEventListener("click", () => { $("certAddBox").style.display = ""; $("certShowAdd").style.display = "none"; note("certMsg", ""); $("certLabel").focus(); });
    $("certAddCancel").addEventListener("click", () => { hideCertAdd(); note("certMsg", ""); });
    $("certAuto").addEventListener("click", async () => { try { await api("PUT", "/api/profile/latest-cert", { id: "" }); pinnedCert = ""; say("Main certification is now the newest by date"); renderFiles(); } catch (e) { note("certMsg", e.message, true); } });
    $("nameSave").addEventListener("click", saveName); $("fullName").addEventListener("keydown", (e) => { if (e.key === "Enter") saveName(); });
    $("danSave").addEventListener("click", saveDan); $("danClear").addEventListener("click", (e) => confirmTap(e.currentTarget, "Tap again to remove", clearDan));
    const sum = $("sumDiver");                                                    // the Summary card leads to the matching Account section
    if (sum) { const go = (e) => { if (e && e.target.closest(".diver-row") && !e.target.closest("#sumDanRow")) return window.showView("certs"); window.showView("account"); open(e && e.target.closest("#sumDanRow") ? "dan" : "profile"); }; sum.addEventListener("click", go); }
    $("regAdd").addEventListener("click", () => openRegForm(null)); $("regEdit").addEventListener("click", () => openRegForm(regulator));
    $("regCancel").addEventListener("click", () => { $("regForm").style.display = "none"; note("regMsg", ""); renderRegulator(); });
    $("regSave").addEventListener("click", saveReg);
    $("regUseLogged").addEventListener("click", async () => { const n = U.uniqueDives(await Dives.all()).filter((r) => r.mode !== "freedive").length; $("regBase").value = n; note("regMsg", `Filled in with your ${n} logged scuba/gauge dives.`); });
    $("regReset").addEventListener("click", () => { if ($("regResetForm").style.display === "none") openResetForm(); else $("regResetForm").style.display = "none"; note("regMsg", ""); });
    $("regRstSave").addEventListener("click", resetReg); $("regRstCancel").addEventListener("click", () => { $("regResetForm").style.display = "none"; note("regMsg", ""); });
    $("regRemove").addEventListener("click", (e) => confirmTap(e.currentTarget, "Tap again to remove", removeReg));
    $("updateBtn").addEventListener("click", checkUpdate);
    $("helpDiag").addEventListener("click", async () => note("helpMsg", await Dives.copyDiagnostics()));
    const hint = $("sumRegHintLink"); if (hint) hint.addEventListener("click", (e) => { e.preventDefault(); window.showView("account"); open("regulator"); });
    const card = $("sumReg"); if (card) { const go = () => { window.showView("account"); open("regulator"); }; card.addEventListener("click", go); card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") go(); }); }
  }
  function show() { renderRegulator(); showVersions(); loadShare(); }
  function showCerts() { loadFiles(); }

  return { init, show, showCerts, open, regulator: () => regulator, diver, refresh: renderRegulator };
})();
