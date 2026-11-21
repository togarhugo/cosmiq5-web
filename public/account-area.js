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
  const note = (id, text, bad) => { const el = $(id); if (!el) return; el.textContent = text || ""; el.style.color = bad ? "#c92a2a" : "#2b8a3e"; };
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

  // ---------- certifications ----------
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

  async function loadCerts() {
    const box = $("certList"); if (!box) return;
    try {
      const { certs } = await api("GET", "/api/certs");
      box.innerHTML = certs.length ? certs.map((c) => `<div class="cert" data-id="${esc(c.id)}"><div class="cert-top"><b>${esc(c.label)}</b>${c.number ? `<span class="muted">#${esc(c.number)}</span>` : ""}<span class="muted">${esc(c.filename)} · ${fmtSize(c.size)}</span></div>
        <div class="row wrap" style="margin:8px 0 0"><button class="btn-set cert-view" type="button">${c.mime === "application/pdf" ? "Open" : "View"}</button><button class="btn-set cert-save" type="button" style="background:#6c757d">Save</button>${navigator.canShare ? '<button class="btn-set cert-share" type="button" style="background:#6c757d">Share</button>' : ""}<button class="btn-set cert-del" type="button" style="background:#6c757d">Delete</button></div><div class="cert-preview"></div></div>`).join("")
        : '<p class="muted" style="margin:0">No certifications yet.</p>';
    } catch (e) { box.innerHTML = `<p class="muted">${e.status === 401 ? "Signed out: reload the page." : "Could not load: " + esc(e.message)}</p>`; }
  }
  async function fetchCert(id) { const { cert } = await api("GET", "/api/certs/" + id); return { cert, blob: new Blob([fromBase64(cert.data)], { type: cert.mime }) }; }
  async function certAction(e) {
    const item = e.target.closest(".cert"); if (!item) return;
    const id = item.dataset.id, btn = e.target.closest("button"); if (!btn) return;
    try {
      if (btn.classList.contains("cert-del")) return confirmTap(btn, "Tap again to delete", async () => { await api("DELETE", "/api/certs/" + id); say("Certification deleted"); loadCerts(); });
      const { cert, blob } = await fetchCert(id), url = URL.createObjectURL(blob);
      if (btn.classList.contains("cert-view")) {
        if (cert.mime === "application/pdf") { const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.click(); }
        else { const p = item.querySelector(".cert-preview"); p.innerHTML = p.firstChild ? "" : `<img class="preview" alt="${esc(cert.label)}" src="${url}">`; }
      } else if (btn.classList.contains("cert-save")) { const a = document.createElement("a"); a.href = url; a.download = cert.filename; a.click(); }
      else if (btn.classList.contains("cert-share")) {
        const file = new File([blob], cert.filename, { type: cert.mime });
        if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: cert.label }); else note("certMsg", "Sharing files is not supported here: use Save.", true);
      }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { if (err.name !== "AbortError") note("certMsg", err.message, true); }
  }
  async function addCert() {
    const label = $("certLabel").value.trim(), file = $("certFile").files[0];
    if (!label) return note("certMsg", "Give the certification a name.", true);
    if (!file) return note("certMsg", "Choose a file first.", true);
    const btn = $("certAdd"); btn.disabled = true; btn.textContent = "Uploading…"; note("certMsg", "");
    try {
      const f = await prepareFile(file);
      await api("POST", "/api/certs", { label, number: $("certNumber").value.trim(), ...f });
      $("certLabel").value = ""; $("certNumber").value = ""; $("certFile").value = ""; $("certFileName").textContent = "";
      say("Certification uploaded"); note("certMsg", "Uploaded."); loadCerts();
    } catch (e) { note("certMsg", e.message, true); }
    finally { btn.disabled = false; btn.textContent = "Upload"; }
  }

  // ---------- regulator ----------
  async function renderRegulator() {
    const recs = await Dives.all(), reg = regulator, form = $("regForm");
    $("regStatus").style.display = reg && form.style.display === "none" ? "" : "none";
    $("regAdd").style.display = !reg && form.style.display === "none" ? "" : "none";
    const badge = $("regBadge");
    if (reg) {
      const n = U.regulatorCount(reg, recs), lvl = U.regulatorLevel(n);
      $("regShownName").textContent = reg.name; $("regShownType").textContent = reg.type ? "· " + reg.type : ""; $("regShownCount").textContent = n;
      badge.textContent = n + (n === 1 ? " dive" : " dives"); badge.className = "regbadge " + (lvl === "ok" ? "" : lvl); badge.style.display = "";
    } else badge.style.display = "none";
    Dives.render();                                                       // refreshes the Summary card too
  }
  const setReg = (r) => { regulator = r; store.set("regulator", r); };
  function openRegForm(reg) {
    $("regName").value = reg ? reg.name : ""; $("regType").value = reg ? reg.type : ""; $("regBase").value = reg ? reg.baseline : 0;
    $("regForm").style.display = ""; $("regStatus").style.display = "none"; $("regAdd").style.display = "none"; $("regName").focus();
  }
  async function saveReg() {
    const name = $("regName").value.trim(), base = Number($("regBase").value);
    if (!name) return note("regMsg", "Enter the regulator's name.", true);
    if (!Number.isInteger(base) || base < 0 || base > 99999) return note("regMsg", "Dives already on it must be a whole number, 0 or more.", true);
    try {
      const recs = await Dives.all();
      const next = { name, type: $("regType").value.trim(), baseline: base, since: regulator ? regulator.since : U.regulatorReset({}, recs).since };    // a new regulator counts dives after today's last logged one
      await api("PUT", "/api/regulator", next); setReg(next); $("regForm").style.display = "none"; note("regMsg", ""); say("Regulator saved"); renderRegulator();
    } catch (e) { note("regMsg", e.message, true); }
  }
  async function resetReg() {
    try { const next = U.regulatorReset(regulator, await Dives.all()); await api("PUT", "/api/regulator", next); setReg(next); say("Regulator counter reset to 0"); renderRegulator(); }
    catch (e) { note("regMsg", e.message, true); }
  }
  async function removeReg() {
    try { await api("DELETE", "/api/regulator"); setReg(null); say("Regulator removed"); renderRegulator(); } catch (e) { note("regMsg", e.message, true); }
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
    el.style.color = sv && sv !== self.APP_VERSION ? "#e67700" : "";
  }

  function open(sec) { const d = document.querySelector(`details.acc[data-sec="${sec}"]`); if (d) { d.open = true; d.scrollIntoView({ block: "start" }); } }
  async function init() {
    showVersions(); setAvatar(store.get("avatar"));
    fetch("/api/me", { credentials: "same-origin", redirect: "error" }).then((r) => (r.ok ? r.json() : null)).then((m) => {
      if (!m) return; me = m; $("who").textContent = m.email; showVersions();
    }).catch(() => {});
    api("GET", "/api/profile").then((p) => setAvatar(p.avatar)).catch(() => {});
    api("GET", "/api/regulator").then((r) => { setReg(r.regulator); renderRegulator(); }).catch(() => renderRegulator());
    $("avatarFile").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) pickAvatar(f); });
    $("avatarRemove").addEventListener("click", async () => { try { await api("DELETE", "/api/profile/avatar"); setAvatar(null); say("Profile picture removed"); note("profMsg", ""); } catch (e) { note("profMsg", e.message, true); } });
    $("certFile").addEventListener("change", (e) => { const f = e.target.files[0]; $("certFileName").textContent = f ? f.name : ""; if (f && !$("certLabel").value) $("certLabel").value = f.name.replace(/\.[^.]*$/, "").replace(/[_-]+/g, " ").slice(0, 80); });
    $("certAdd").addEventListener("click", addCert); $("certList").addEventListener("click", certAction);
    $("regAdd").addEventListener("click", () => openRegForm(null)); $("regEdit").addEventListener("click", () => openRegForm(regulator));
    $("regCancel").addEventListener("click", () => { $("regForm").style.display = "none"; note("regMsg", ""); renderRegulator(); });
    $("regSave").addEventListener("click", saveReg);
    $("regUseLogged").addEventListener("click", async () => { const n = (await Dives.all()).filter((r) => r.mode !== "freedive").length; $("regBase").value = n; note("regMsg", `Filled in with your ${n} logged scuba/gauge dives.`); });
    $("regReset").addEventListener("click", (e) => confirmTap(e.currentTarget, "Tap again to reset to 0", resetReg));
    $("regRemove").addEventListener("click", (e) => confirmTap(e.currentTarget, "Tap again to remove", removeReg));
    $("updateBtn").addEventListener("click", checkUpdate);
    $("helpDiag").addEventListener("click", async () => note("helpMsg", await Dives.copyDiagnostics()));
    const hint = $("sumRegHintLink"); if (hint) hint.addEventListener("click", (e) => { e.preventDefault(); window.showView("account"); open("regulator"); });
    const card = $("sumReg"); if (card) { const go = () => { window.showView("account"); open("regulator"); }; card.addEventListener("click", go); card.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") go(); }); }
  }
  function show() { loadCerts(); renderRegulator(); showVersions(); }

  return { init, show, open, regulator: () => regulator, refresh: renderRegulator };
})();
