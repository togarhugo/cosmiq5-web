/* Dive places on a map: the data layer (browser global `Places`, or CommonJS for tests).
 * A place is the free-text dive location you already type ("Tulamben"). It gets a position once, then every dive with that
 * location is on the map. Positions are saved in your account (/api/places) and cached on this phone.
 * Place search uses OpenStreetMap's Nominatim service: one request per tap on Search, never while typing (their usage policy). */
(function (root) {
  "use strict";
  const KEY = "places", keyOf = (name) => String(name || "").trim().toLowerCase();
  const ls = (typeof localStorage !== "undefined") ? localStorage : null;
  let map = {};                                                      // key -> {name, lat, lon}
  try { map = JSON.parse((ls && ls.getItem(KEY)) || "{}") || {}; } catch (e) { map = {}; }
  const persist = () => { try { ls && ls.setItem(KEY, JSON.stringify(map)); } catch (e) {} };

  async function api(method, body) {
    const r = await fetch("/api/places", { method, credentials: "same-origin", redirect: "error", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    let data = {}; try { data = await r.json(); } catch (e) {}
    if (!r.ok) throw Object.assign(new Error(data.error || "Request failed (" + r.status + ")"), { status: r.status });
    return data;
  }
  /** Fetch from the account (the phone's cached copy is used until this answers, and when offline). */
  async function load() {
    try { const { places } = await api("GET"); map = {}; for (const p of places) map[keyOf(p.name)] = { name: p.name, lat: p.lat, lon: p.lon }; persist(); return true; }
    catch (e) { return false; }
  }
  /** key -> {lat, lon} for the pins. */
  const coords = () => { const o = {}; for (const k of Object.keys(map)) o[k] = { lat: map[k].lat, lon: map[k].lon }; return o; };
  const get = (name) => map[keyOf(name)] || null;
  async function save(name, lat, lon) {
    await api("PUT", { name, lat, lon }); map[keyOf(name)] = { name, lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 }; persist();
  }
  async function remove(name) { await api("DELETE", { name }); delete map[keyOf(name)]; persist(); }

  // ---- search ----
  let last = 0, ctl = null;
  /** Results: [{label, name, lat, lon, box}] (at most 6). Waits so that requests are at least 1.1 s apart. */
  async function search(query) {
    const q = String(query || "").trim(); if (q.length < 2) return [];
    if (ctl) ctl.abort(); ctl = new AbortController();
    const wait = last + 1100 - Date.now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const lang = (typeof navigator !== "undefined" && navigator.language) || "en";
    const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=0&accept-language=" + encodeURIComponent(lang) + "&q=" + encodeURIComponent(q);
    const r = await fetch(url, { signal: ctl.signal, referrerPolicy: "origin", headers: { accept: "application/json" } });      // the app sends no referrer by default; OSM asks to be told who is asking
    if (!r.ok) throw new Error(r.status === 429 ? "The map search is busy: wait a moment and try again." : "The map search failed (" + r.status + ").");
    const rows = await r.json();
    return (Array.isArray(rows) ? rows : []).map((x) => ({ label: String(x.display_name || x.name || ""), name: String(x.name || "").trim(), lat: Number(x.lat), lon: Number(x.lon),
      box: Array.isArray(x.boundingbox) ? x.boundingbox.map(Number) : null })).filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon) && Math.abs(x.lat) <= 90 && Math.abs(x.lon) <= 180);
  }

  const api2 = { load, coords, get, save, remove, search, keyOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api2; else root.Places = api2;
})(typeof self !== "undefined" ? self : this);
