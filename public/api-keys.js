/* Account > API access: make, rotate, revoke and delete the keys other tools use to read your dive log, and show how to use the API.
 * A key is shown ONCE, right after it is made or rotated; the server keeps only a hash. */
"use strict";

const ApiKeys = (() => {
  const $ = (id) => document.getElementById(id);
  const say = (t, kind) => { if (window.toast) window.toast(t, kind || "ok"); };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let keys = [], max = 10, armed = null, loaded = false;

  async function api(method, path, body) {
    const r = await fetch(path, { method, credentials: "same-origin", redirect: "error", headers: { "content-type": "application/json" }, body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body || {}) });
    let data = {}; try { data = await r.json(); } catch (e) {}
    if (!r.ok) throw Object.assign(new Error(data.error || "Request failed (" + r.status + ")"), { status: r.status });
    return data;
  }
  const note = (text, bad) => { const el = $("apiMsg"); el.textContent = text || ""; el.style.color = bad ? "var(--tx-c92a2a)" : "var(--tx-2b8a3e)"; };
  /** Two-step button: the first tap turns it into a red "Sure?", a second tap within 4 s does it. */
  function confirmTap(btn, label, action) {
    const reset = (b) => { b.innerHTML = b.dataset.html; b.classList.remove("armed"); b.removeAttribute("data-armed"); };
    if (armed && armed.btn === btn) { clearTimeout(armed.t); reset(btn); armed = null; return action(); }
    if (armed) { clearTimeout(armed.t); reset(armed.btn); armed = null; }
    btn.dataset.html = btn.innerHTML; btn.textContent = "Sure?"; btn.classList.add("armed"); btn.setAttribute("data-armed", label);
    armed = { btn, t: setTimeout(() => { reset(btn); armed = null; }, 4000) };
  }
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const ago = (iso) => { const d = Math.floor((Date.now() - Date.parse(iso)) / 86400000); return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 60 ? d + " days ago" : day(iso); };
  const inDays = (iso) => Math.ceil((Date.parse(iso) - Date.now()) / 86400000);

  // ---------- how to use it (always shown, with this site's own address) ----------
  function docs() {
    const base = location.origin + "/api/v1", host = location.origin;
    $("apiBase").textContent = base;
    $("apiCurl").textContent = `curl -H "Authorization: Bearer dm_YOUR_KEY" \\\n  "${host}/api/v1/dives?kind=scuba&limit=2"`;
    $("apiExample").textContent = JSON.stringify({ dives: [{ id: "e90903091e00", device: "cosmiq", kind: "scuba", mode: "scuba", startedAt: "2025-03-14T09:30:00", durationSec: 2520, maxDepthM: 18.1, minTempC: 27, o2Percent: 32, diveNumber: 7,
      location: "Tulamben", position: { lat: -8.29, lon: 115.59 }, uploadedAt: "2025-04-01T10:00:00Z" }], count: 1, nextCursor: "MjAyNS0wMy0xNFQwOTozMDowMHxlOTA5MDMwOTFlMDA" }, null, 2);
  }

  // ---------- the list ----------
  /** Short text for the one-line row, and the full sentence for the details. */
  function status(k) {
    if (k.status === "revoked") return { cls: "revoked", short: "Revoked", full: "Revoked" + (k.revokedAt ? " " + ago(k.revokedAt) : "") };
    if (k.status === "expired") return { cls: "expired", short: "Expired", full: "Expired " + day(k.expiresAt) };
    if (!k.expiresAt) return { cls: "active", short: "Never", full: "Active \u00b7 never expires" };
    const n = inDays(k.expiresAt); return { cls: n <= 3 ? "soon" : "active", short: n <= 0 ? "Today" : n + " d", full: `Active \u00b7 expires ${day(k.expiresAt)} (${n <= 0 ? "today" : n === 1 ? "tomorrow" : "in " + n + " days"})` };
  }
  const ICON = {
    rotate: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.3-4.6L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.6L20 16"/><path d="M20 20v-4h-4"/></svg>',
    revoke: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
    del: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>',
  };
  const act = (cls, icon, label, name, extra) => `<button class="kact ${cls}" type="button" title="${label}" aria-label="${label}: ${esc(name)}" data-icon="${esc(icon)}"${extra || ""}>${ICON[icon]}</button>`;
  function render() {
    const active = keys.filter((k) => k.status === "active").length;
    const badge = $("apiBadge"); badge.style.display = active ? "" : "none"; badge.textContent = active ? active + (active === 1 ? " key" : " keys") : "";
    $("apiCount").textContent = `${active} of ${max} active keys`;
    const open = new Set([...document.querySelectorAll("#apiList .keyrow.open")].map((r) => r.dataset.id));                      // keep the details you had open
    $("apiList").innerHTML = keys.length ? keys.map((k) => { const st = status(k);
      return `<div class="keyrow ${st.cls}${open.has(k.id) ? " open" : ""}" data-id="${esc(k.id)}"><div class="kline">
        <button class="kmain" type="button" aria-expanded="${open.has(k.id)}" title="Show details"><i class="kdot ${st.cls}" aria-hidden="true"></i><span class="kname">${esc(k.description)}</span><span class="kchip ${st.cls}">${esc(st.short)}</span></button>
        ${k.status !== "revoked" ? act("k-rotate", "rotate", "Rotate", k.description) : ""}${k.status === "active" ? act("k-revoke", "revoke", "Revoke", k.description) : ""}${k.status !== "active" ? act("k-delete", "del", "Delete", k.description) : ""}</div>
        <div class="kdetail muted"><span class="kprefix">${esc(k.prefix)}\u2026</span> \u00b7 ${esc(st.full)}<br>Made ${esc(day(k.createdAt))} \u00b7 ${k.lastUsedAt ? "last used " + esc(ago(k.lastUsedAt)) : "never used"}</div></div>`; }).join("")
      : '<p class="muted" style="margin:0">No keys yet.</p>';
  }
  async function load() {
    try { const r = await api("GET", "/api/keys"); keys = r.keys; max = r.max; loaded = true; render(); }
    catch (e) { $("apiList").innerHTML = `<p class="muted">${e.status === 401 ? "Signed out: reload the page." : "Could not load: " + esc(e.message)}</p>`; }
  }

  // ---------- the key, shown once ----------
  function showKey(key, title) {
    const box = $("apiNew"); $("apiNewTitle").textContent = title; $("apiKeyText").textContent = key; box.style.display = ""; $("apiCopy").textContent = "Copy key";
    box.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function hideKey() { $("apiNew").style.display = "none"; $("apiKeyText").textContent = ""; }
  async function copy(text, btn, label) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) { const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch (e2) {} ta.remove(); if (!ok) return say("Could not copy: select the text and copy it.", "warn"); }
    btn.textContent = "Copied ✓"; setTimeout(() => { btn.textContent = label; }, 2000); say("Copied");
  }

  // ---------- actions ----------
  async function generate() {
    const description = $("apiDesc").value.trim(), days = Number($("apiDays").value);
    if (!description) { note("Describe what the key is for, for example “Home dashboard”.", true); $("apiDesc").focus(); return; }
    const btn = $("apiGen"); btn.disabled = true; note("");
    try { const r = await api("POST", "/api/keys", { description, days }); $("apiDesc").value = ""; showKey(r.key, "Your new key: " + r.item.description); say("Key generated"); await load(); }
    catch (e) { note(e.message, true); } finally { btn.disabled = false; }
  }
  async function rotate(id) {
    try { const r = await api("POST", `/api/keys/${id}/rotate`); showKey(r.key, "Rotated: " + r.item.description + ". The old key stopped working."); say("Key rotated: the old key no longer works"); await load(); }
    catch (e) { note(e.message, true); }
  }
  async function revoke(id) { try { await api("POST", `/api/keys/${id}/revoke`); say("Key revoked"); await load(); } catch (e) { note(e.message, true); } }
  async function remove(id) { try { await api("DELETE", `/api/keys/${id}`); say("Key deleted"); await load(); } catch (e) { note(e.message, true); } }

  function init() {
    if (!$("apiGen")) return;
    docs(); render();
    const sec = document.querySelector('details.acc[data-sec="api"]'); sec.addEventListener("toggle", () => { if (sec.open) load(); });
    $("apiGen").addEventListener("click", generate); $("apiDesc").addEventListener("keydown", (e) => { if (e.key === "Enter") generate(); });
    $("apiDays").addEventListener("change", () => { $("apiUnlimitedWarn").style.display = $("apiDays").value === "0" ? "" : "none"; });
    $("apiCopy").addEventListener("click", (e) => copy($("apiKeyText").textContent, e.currentTarget, "Copy key")); $("apiHide").addEventListener("click", () => { hideKey(); say("Key hidden. It cannot be shown again."); });
    $("apiCopyBase").addEventListener("click", (e) => copy($("apiBase").textContent, e.currentTarget, "Copy")); $("apiCopyCurl").addEventListener("click", (e) => copy($("apiCurl").textContent, e.currentTarget, "Copy"));
    $("apiList").addEventListener("click", (e) => {
      const b = e.target.closest("button"), row = e.target.closest(".keyrow"); if (!b || !row) return; const id = row.dataset.id;
      if (b.classList.contains("kmain")) { const o = row.classList.toggle("open"); b.setAttribute("aria-expanded", String(o)); return; }
      if (b.classList.contains("k-rotate")) confirmTap(b, "rotate", () => rotate(id));
      else if (b.classList.contains("k-revoke")) confirmTap(b, "revoke", () => revoke(id));
      else if (b.classList.contains("k-delete")) confirmTap(b, "delete", () => remove(id));
    });
    load();                                                                            // for the count on the section title
  }
  return { init, load };
})();
