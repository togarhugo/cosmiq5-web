/* Dive trips: the countdown, the baggage weight sums and the standard packing list (browser global `TripUtils`, or CommonJS for tests).
 * A trip = { id, title, destination, start, end (YYYY-MM-DD or ""), limits: { dive, carry, total } (kg or null), groups: [{ id, name, items: [{ id, name, kg, bag: "dive" | "carry", packed }] }] }.
 * Dates are plain calendar days (no time zone): "today" is the calendar day on the phone. */
(function (root) {
  "use strict";
  const DAY = 86400000, pad = (n) => String(n).padStart(2, "0");
  const dayMs = (k) => { const [y, m, d] = k.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  /** The calendar day of a Date, as YYYY-MM-DD (local time). */
  const todayKey = (d) => { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / DAY);               // b - a, in days
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  /** Where the trip is in time: { kind: "undated" | "upcoming" | "ongoing" | "ended", big, text, sub }. big = the number shown large (days to go, or the day of the trip). */
  function status(trip, today) {
    if (!trip.start) return { kind: "undated", big: "", text: "Dates not set", sub: "" };
    const end = trip.end || trip.start, total = daysBetween(trip.start, end) + 1, toStart = daysBetween(today, trip.start), sinceEnd = daysBetween(end, today);
    if (toStart > 0) return { kind: "upcoming", big: String(toStart), text: toStart === 1 ? "day to go" : "days to go", sub: `${plural(total, "day")}`, days: toStart };
    if (sinceEnd <= 0) { const n = daysBetween(trip.start, today) + 1; return { kind: "ongoing", big: String(n), text: `of ${total} · on the trip now`, sub: plural(total, "day"), day: n, total }; }
    return { kind: "ended", big: "", text: sinceEnd === 1 ? "Ended yesterday" : `Ended ${plural(sinceEnd, "day")} ago`, sub: plural(total, "day"), days: sinceEnd };
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  /** Weights in kg: what goes in the dive bag, what goes in the camera carry-on, both together, and how many items are packed. */
  function totals(trip) {
    let dive = 0, carry = 0, packed = 0, count = 0;
    for (const g of trip.groups || []) for (const i of g.items) { if (i.bag === "carry") carry += i.kg || 0; else dive += i.kg || 0; count++; if (i.packed) packed++; }
    return { dive: r2(dive), carry: r2(carry), total: r2(dive + carry), packed, count };
  }
  /** How a weight stands against its limit: "none" (no limit set), "ok", "warn" (within 10 %) or "over". */
  function level(used, limit) { if (!limit || limit <= 0) return "none"; if (used > limit + 1e-9) return "over"; return used >= limit * 0.9 ? "warn" : "ok"; }
  /** The kg left (positive) or over (negative) against a limit, or null when there is no limit. */
  const left = (used, limit) => (!limit || limit <= 0 ? null : r2(limit - used));
  const kgText = (n) => `${r2(n)} kg`;
  /** "12 – 19 Dec 2026", "12 Dec 2026", or "" . */
  function range(start, end) {
    if (!start) return "";
    const f = (k, parts) => new Date(dayMs(k)).toLocaleDateString("en-GB", { ...parts, timeZone: "UTC" });
    if (!end || end === start) return f(start, { day: "numeric", month: "short", year: "numeric" });
    if (start.slice(0, 7) === end.slice(0, 7)) return `${f(start, { day: "numeric" })} \u2013 ${f(end, { day: "numeric", month: "short", year: "numeric" })}`;
    if (start.slice(0, 4) === end.slice(0, 4)) return `${f(start, { day: "numeric", month: "short" })} \u2013 ${f(end, { day: "numeric", month: "short", year: "numeric" })}`;
    return `${f(start, { day: "numeric", month: "short", year: "numeric" })} \u2013 ${f(end, { day: "numeric", month: "short", year: "numeric" })}`;
  }
  /** The trip to show on the Overview: the one on now, else the next one to start. null when none is on or coming. */
  function nextTrip(trips, today) {
    const live = trips.filter((t) => t.start && (t.end || t.start) >= today).sort((a, b) => a.start.localeCompare(b.start));
    return live.find((t) => t.start <= today) || live[0] || null;
  }
  /** Trips in the order of the list: on now and coming first (soonest first), then the past (latest first), then undated. */
  function sections(trips, today) {
    const dated = trips.filter((t) => t.start), live = dated.filter((t) => (t.end || t.start) >= today).sort((a, b) => a.start.localeCompare(b.start));
    return { upcoming: live, past: dated.filter((t) => (t.end || t.start) < today).sort((a, b) => b.start.localeCompare(a.start)), undated: trips.filter((t) => !t.start) };
  }
  const newId = () => { const a = "abcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; const c = root.crypto && root.crypto.getRandomValues ? root.crypto.getRandomValues(new Uint8Array(10)) : null; for (let i = 0; i < 10; i++) s += a[(c ? c[i] : Math.floor(Math.random() * 256)) % 36]; return s; };
  /** The standard packing lists a new trip starts with (every name and weight can be changed). */
  function defaultGroups(id) {
    id = id || newId; const it = (name, kg, bag) => ({ id: id(), name, kg, bag, packed: false });
    return [
      { id: id(), name: "Core scuba kit", items: [it("Regulator", 1.9, "dive"), it("BCD", 3.2, "dive"), it("Dive computer", 0.2, "carry"), it("Mask & fins", 2.1, "dive"), it("Exposure suit (3 mm)", 1.8, "dive"), it("SMB & reel", 0.6, "dive"), it("Spare O-rings & straps", 0.1, "dive")] },
      { id: id(), name: "Underwater camera kit", items: [it("Camera body", 0.9, "carry"), it("Housing + port", 2.4, "carry"), it("Strobes & arms", 1.7, "carry"), it("Batteries & memory cards", 0.3, "carry"), it("Spare O-rings, grease & tools", 0.3, "carry")] },
    ];
  }
  const newTrip = (id) => ({ id: id || newId(), title: "", destination: "", start: "", end: "", limits: { dive: 23, carry: 7, total: null }, groups: defaultGroups() });
  const api = { todayKey, daysBetween, status, totals, level, left, kgText, range, nextTrip, sections, newId, defaultGroups, newTrip };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.TripUtils = api;
})(typeof self !== "undefined" ? self : this);
