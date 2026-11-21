/* Pure helpers for the dive log UI (browser global `DiveUtils`, or CommonJS for tests):
 * location cleanup + suggestions, grouping by date, summary figures. No DOM access. */
(function (root) {
  "use strict";
  const dateKey = (rec) => rec.startedAt.slice(0, 10);                       // device-local "YYYY-MM-DD"
  const byStartDesc = (a, b) => b.startedAt.localeCompare(a.startedAt);

  /** Trim, single-space, drop control chars, max 60 chars. If it matches a known place ignoring case, use that spelling. */
  function normalizeLocation(text, known) {
    const t = String(text == null ? "" : text).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
    if (!t) return "";
    const hit = (known || []).find((k) => k.toLowerCase() === t.toLowerCase());
    return hit || t;
  }

  /** Distinct places already used, most recently dived first (for the suggestion list). */
  function knownLocations(recs) {
    const seen = new Map();
    for (const r of recs.slice().sort(byStartDesc)) if (r.location && !seen.has(r.location.toLowerCase())) seen.set(r.location.toLowerCase(), r.location);
    return [...seen.values()];
  }

  /** Dives grouped by date, newest date first: [{date, recs}] */
  function groupByDate(recs) {
    const m = new Map();
    for (const r of recs.slice().sort(byStartDesc)) { const k = dateKey(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].map(([date, rs]) => ({ date, recs: rs }));
  }

  /** The place of a date: the one place used, or "mixed" when the dives of that day differ. */
  function dateLocation(recsOfDate) {
    const set = [...new Set(recsOfDate.map((r) => r.location).filter(Boolean))];
    return { location: set.length === 1 ? set[0] : "", mixed: set.length > 1, missing: recsOfDate.filter((r) => !r.location).length };
  }

  /**
   * Which dates to ask about, oldest first (so "same as above" follows a trip's order). `targets` = the dives that need a place;
   * `all` = every dive (to pre-fill from other dives on the same date that already have one).
   * Returns [{date, count, fps, prefill}].
   */
  function locationAsks(targets, all) {
    const out = new Map();
    for (const r of targets.slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      const d = dateKey(r); if (!out.has(d)) out.set(d, { date: d, count: 0, fps: [], prefill: "" });
      const e = out.get(d); e.count++; e.fps.push(r.fingerprint);
    }
    for (const e of out.values()) { const known = dateLocation(all.filter((r) => dateKey(r) === e.date && r.location)); e.prefill = known.mixed ? "" : known.location; }
    return [...out.values()];
  }

  const hoursText = (sec) => { const m = Math.round(sec / 60); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`; };
  function daysBetween(key, today) {                                         // whole calendar days from `key` to `today` (local)
    const [y, m, d] = key.split("-").map(Number);
    return Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(y, m - 1, d)) / 86400000);
  }
  function agoText(days) {
    if (days <= 0) return "today"; if (days === 1) return "yesterday"; if (days < 60) return `${days} days ago`;
    if (days < 730) return `about ${Math.round(days / 30.44)} months ago`; return `about ${Math.round(days / 365.25)} years ago`;
  }

  /** The summary page: last dive date and total dive time. */
  function summarize(recs, today) {
    if (!recs.length) return { count: 0, totalSec: 0, last: null };
    const last = recs.slice().sort(byStartDesc)[0];
    return { count: recs.length, totalSec: recs.reduce((a, r) => a + (r.durationSec || 0), 0),
      last: { date: dateKey(last), startedAt: last.startedAt, location: last.location || "", daysAgo: daysBetween(dateKey(last), today || new Date()) } };
  }

  const api = { dateKey, normalizeLocation, knownLocations, groupByDate, dateLocation, locationAsks, hoursText, daysBetween, agoText, summarize };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.DiveUtils = api;
})(typeof self !== "undefined" ? self : this);
