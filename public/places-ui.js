/* Maps: the Summary map with a pin for every place you have dived, and the "put it on the map" picker with place search.
 * Needs: Leaflet (vendor/leaflet.js, global L), DiveUtils, Places. Map tiles and place search come from OpenStreetMap. */
"use strict";

const PlacesUI = (() => {
  const $ = (id) => document.getElementById(id);
  const U = window.DiveUtils, P = window.Places;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const say = (t, kind) => { if (window.toast) window.toast(t, kind || "ok"); };
  const hasMap = () => typeof L !== "undefined";
  const fmtDay = (iso) => new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  let map = null, layer = null, sig = "", stats = [], pins = [], missing = [];

  function tiles(m) {
    let failed = 0;
    const t = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, minZoom: 1, referrerPolicy: "origin",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' });
    t.on("tileerror", () => { if (++failed === 3 && m._note) m._note("The map background could not be loaded (offline?). Your pins are still listed below."); });
    t.on("tileload", () => { failed = 0; });
    t.addTo(m); return t;
  }
  const pinIcon = (count) => L.divIcon({ className: "pin-wrap", iconSize: [32, 42], iconAnchor: [16, 40], popupAnchor: [0, -36],
    html: `<svg viewBox="0 0 32 42" width="32" height="42" aria-hidden="true"><path d="M16 1C8 1 2 7 2 15c0 10 14 26 14 26s14-16 14-26C30 7 24 1 16 1z" fill="#e03131" stroke="#fff" stroke-width="2"/><circle cx="16" cy="15" r="8.5" fill="#fff"/><text x="16" y="19" font-size="${count > 99 ? 8 : count > 9 ? 10 : 12}" font-weight="700" text-anchor="middle" fill="#c92a2a" font-family="system-ui,sans-serif">${count}</text></svg>` });
  const plainPin = () => L.divIcon({ className: "pin-wrap", iconSize: [32, 42], iconAnchor: [16, 40], html: '<svg viewBox="0 0 32 42" width="32" height="42" aria-hidden="true"><path d="M16 1C8 1 2 7 2 15c0 10 14 26 14 26s14-16 14-26C30 7 24 1 16 1z" fill="#1971c2" stroke="#fff" stroke-width="2"/><circle cx="16" cy="15" r="6" fill="#fff"/></svg>' });
  function newMap(el) {
    const m = L.map(el, { zoomControl: true, worldCopyJump: true, attributionControl: true }).setView([0, 20], 2);
    const note = document.createElement("div"); note.className = "map-note"; note.hidden = true; el.appendChild(note);
    m._note = (t) => { note.textContent = t; note.hidden = false; }; tiles(m); return m;
  }

  // ---------- the Summary map ----------
  function popup(p) {
    const box = document.createElement("div"); box.className = "pin-pop";
    const b = document.createElement("b"); b.textContent = p.name; box.appendChild(b);
    const d = document.createElement("div"); d.textContent = `${p.count} dive${p.count === 1 ? "" : "s"} · ${p.first.slice(0, 4) === p.last.slice(0, 4) && p.first.slice(5, 7) === p.last.slice(5, 7) ? fmtDay(p.last) : fmtDay(p.first) + " – " + fmtDay(p.last)}`; box.appendChild(d);
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "btn-set"; btn.textContent = "Move pin"; btn.addEventListener("click", () => { map.closePopup(); open([p.name]); }); box.appendChild(btn);
    return box;
  }
  function draw() {
    if (!map) return;
    layer.clearLayers();
    for (const p of pins) L.marker([p.lat, p.lon], { icon: pinIcon(p.count), title: `${p.name}: ${p.count} dive${p.count === 1 ? "" : "s"}`, keyboard: true }).bindPopup(() => popup(p)).addTo(layer);
    const s = pins.map((p) => `${p.key}:${p.lat}:${p.lon}`).join("|");
    if (s !== sig) {                                                                   // only re-frame when the pins changed, not on every refresh
      sig = s;
      if (pins.length > 1) map.fitBounds(L.latLngBounds(pins.map((p) => [p.lat, p.lon])), { padding: [34, 34], maxZoom: 9 });
      else if (pins.length === 1) map.setView([pins[0].lat, pins[0].lon], 8); else map.setView([0, 20], 2);
    }
  }
  /** Redraw from the dives. Called after every render of the dive log. */
  function render(recs) {
    const card = $("mapCard"); if (!card) return;
    stats = U.placeStats(recs); const split = U.pinsAndMissing(stats, P.coords()); pins = split.pins; missing = split.missing;
    card.style.display = stats.length ? "" : "none";
    const banner = $("placeBanner");
    if (banner) { banner.style.display = missing.length ? "flex" : "none"; $("placeBannerText").textContent = `${missing.length} place${missing.length === 1 ? " is" : "s are"} not on the map yet`; }
    if (!stats.length) return;
    $("mapMsg").textContent = `${stats.length} place${stats.length === 1 ? "" : "s"} · ${pins.length} on the map` + (missing.length ? ` · ${missing.length} still to place` : "");
    $("mapUnplaced").innerHTML = missing.length ? missing.map((m) => `<button type="button" class="chip" data-key="${esc(m.key)}">📍 ${esc(m.name)} <span class="muted">${m.count}</span> ›</button>`).join("") : "";
    $("placeList").innerHTML = stats.map((s) => { const has = !!P.get(s.name);
      return `<div class="place-row"><span><b>${esc(s.name)}</b> <span class="muted">${s.count} dive${s.count === 1 ? "" : "s"}</span></span><span class="row" style="margin:0;gap:6px"><button type="button" class="btn-set pl-set" data-key="${esc(s.key)}">${has ? "Move" : "Set on map"}</button>${has ? `<button type="button" class="btn-set pl-del" data-key="${esc(s.key)}" style="background:#6c757d">Remove pin</button>` : ""}</span></div>`; }).join("");
    if (!map && hasMap() && card.offsetParent !== null) { map = newMap($("sumMap")); layer = L.layerGroup().addTo(map); }
    if (map) draw();
    if (!hasMap()) $("sumMap").textContent = "The map could not be loaded.";
  }
  /** The Summary tab was opened: the map needs a size, and it is created here the first time. */
  function shown() { if ($("mapCard") && $("mapCard").style.display !== "none") { render(lastRecs()); if (map) { setTimeout(() => { map.invalidateSize(); sig = ""; draw(); }, 50); } } }
  let recsNow = []; const lastRecs = () => recsNow;
  function renderFrom(recs) { recsNow = recs; render(recs); }

  // ---------- the picker: search, tap, drag, save ----------
  let pk = null;
  function open(names) {
    if (!hasMap()) { say("The map could not be loaded.", "warn"); return; }
    const queue = names.slice(); pk = { queue, name: null, marker: null, map: null }; $("placePicker").hidden = false; document.body.classList.add("pp-open");
    if (!pk.map) { pk.map = newMap($("ppMap")); pk.map.on("click", (e) => setPin(e.latlng.lat, e.latlng.lng)); }
    next();
  }
  function next() {
    if (!pk) return;
    const name = pk.queue.shift(); if (!name) return close();
    const left = pk.queue.length; pk.name = name; setPin(null);
    $("ppTitle").textContent = `Where is “${name}”?` + (left ? ` (${left} more after this)` : ""); $("ppSkip").textContent = left ? "Skip this one" : "Cancel";
    $("ppQuery").value = name; $("ppResults").innerHTML = ""; $("ppSave").disabled = true;
    const have = P.get(name);
    if (have) { setPin(have.lat, have.lon); pk.map.setView([have.lat, have.lon], 10); $("ppHint").textContent = "Drag the pin or tap the map to move it."; }
    else { pk.map.setView([0, 20], 2); $("ppHint").textContent = "Search for the place, or tap the map to drop the pin. You can drag it afterwards."; search(); }
    setTimeout(() => pk && pk.map.invalidateSize(), 60);
  }
  function setPin(lat, lon) {
    if (!pk) return;
    if (lat == null) { if (pk.marker) { pk.map.removeLayer(pk.marker); pk.marker = null; } $("ppCoords").textContent = ""; $("ppSave").disabled = true; return; }
    if (!pk.marker) { pk.marker = L.marker([lat, lon], { draggable: true, icon: plainPin(), keyboard: true }).addTo(pk.map); pk.marker.on("dragend", () => { const p = pk.marker.getLatLng(); setPin(p.lat, p.lng); }); }
    else pk.marker.setLatLng([lat, lon]);
    $("ppCoords").textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)}`; $("ppSave").disabled = false;
  }
  async function search() {
    const q = $("ppQuery").value.trim(), out = $("ppResults"); if (q.length < 2) { out.innerHTML = ""; return; }
    out.innerHTML = '<p class="muted" style="margin:6px 0">Searching…</p>';
    try {
      const rows = await P.search(q); if (!pk) return;
      out.innerHTML = rows.length ? rows.map((r, i) => `<button type="button" class="res" data-i="${i}"><b>${esc(r.name || r.label.split(",")[0])}</b><span class="muted">${esc(r.label)}</span></button>`).join("") : '<p class="muted" style="margin:6px 0">Nothing found. Try another spelling or a nearby town, or tap the map.</p>';
      out._rows = rows;
    } catch (e) { if (e.name !== "AbortError") out.innerHTML = `<p class="muted" style="margin:6px 0;color:#c92a2a">${esc(navigator.onLine ? e.message : "Search needs an internet connection.")}</p>`; }
  }
  function choose(r) {
    setPin(r.lat, r.lon);
    if (r.box && r.box.length === 4 && r.box.every(Number.isFinite)) pk.map.fitBounds([[r.box[0], r.box[2]], [r.box[1], r.box[3]]], { maxZoom: 13, padding: [20, 20] }); else pk.map.setView([r.lat, r.lon], 11);
    $("ppHint").textContent = "Drag the pin to fine-tune it, then Save.";
  }
  async function save() {
    if (!pk || !pk.marker) return; const p = pk.marker.getLatLng(), name = pk.name; $("ppSave").disabled = true;
    try { await P.save(name, p.lat, p.lng); say(`“${name}” is on the map`); if (typeof Dives !== "undefined") Dives.render(); next(); }
    catch (e) { say(e.message, "bad"); $("ppSave").disabled = false; }
  }
  function close() { if (!pk) return; try { pk.map.remove(); } catch (e) {} pk = null; $("placePicker").hidden = true; document.body.classList.remove("pp-open"); $("ppMap").innerHTML = ""; }

  let wired = false;
  function wire() {
    if (wired || !$("mapCard")) return; wired = true;
    $("ppGo").addEventListener("click", search); $("ppQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
    $("ppResults").addEventListener("click", (e) => { const b = e.target.closest(".res"); if (b && $("ppResults")._rows) choose($("ppResults")._rows[+b.dataset.i]); });
    $("ppSave").addEventListener("click", save); $("ppSkip").addEventListener("click", () => (pk && pk.queue.length ? next() : close())); $("ppClose").addEventListener("click", close);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pk) close(); });
    const byKey = (k) => stats.find((s) => s.key === k);
    $("mapUnplaced").addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (!b) return; const first = byKey(b.dataset.key); open([first.name, ...missing.filter((m) => m.key !== first.key).map((m) => m.name)]); });
    $("placeBannerBtn").addEventListener("click", () => open(missing.map((m) => m.name)));
    $("placeList").addEventListener("click", async (e) => {
      const set = e.target.closest(".pl-set"), del = e.target.closest(".pl-del");
      if (set) open([byKey(set.dataset.key).name]);
      if (del) { const s = byKey(del.dataset.key); try { await P.remove(s.name); say(`Pin of “${s.name}” removed`); sig = ""; Dives.render(); } catch (err) { say(err.message, "bad"); } }
    });
  }
  async function init() { wire(); await P.load(); if (typeof Dives !== "undefined") Dives.render(); }

  return { render: renderFrom, shown, open, init, pins: () => pins, missing: () => missing };
})();
