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

  // ---- several dive computers ----
  const DEVICES = [{ id: "cosmiq", name: "Cosmiq+ Gen 5", short: "Cosmiq+" }, { id: "peregrine", name: "Shearwater Peregrine", short: "Peregrine" }];
  const deviceOf = (rec) => rec.device || "cosmiq";
  const endMs = (r) => Date.parse(r.startedAt + "Z") + (r.durationSec || 0) * 1000;
  /**
   * Dives to count in totals: when two computers recorded the same dive (worn together), it is counted once. A dive from a
   * different computer that starts before an earlier dive has ended is that same dive. Same-computer dives never merge.
   */
  function uniqueDives(recs) {
    const asc = recs.slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt)), kept = [];
    for (const r of asc) {
      const t = Date.parse(r.startedAt + "Z");
      let dup = false;
      for (let i = kept.length - 1; i >= 0 && t - Date.parse(kept[i].startedAt + "Z") < 86400000; i--)
        if (deviceOf(kept[i]) !== deviceOf(r) && t < endMs(kept[i])) { dup = true; break; }
      if (!dup) kept.push(r);
    }
    return kept;
  }
  /** Dive number to show: the computer's own count when it has one, otherwise its place in that computer's log (oldest = 1). */
  function diveNumbers(recs) {
    const out = new Map(), by = new Map();
    for (const r of recs) { const d = deviceOf(r); if (!by.has(d)) by.set(d, []); by.get(d).push(r); }
    for (const rs of by.values()) rs.slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt)).forEach((r, i) => out.set(r.fingerprint, r.number != null ? r.number : i + 1));
    return out;
  }
  /** Round axis steps for the depth chart: the smallest 1/2/5 step that needs at most `lines` gridlines. Returns {step, max}. */
  function niceAxis(max, lines) {
    lines = lines || 5; max = Math.max(max, 1e-9);
    const base = Math.pow(10, Math.floor(Math.log10(max / lines)) - 1);
    for (let k = 0; k < 40; k++) {
      const step = [1, 2, 5][k % 3] * base * Math.pow(10, Math.floor(k / 3)), n = Math.ceil(max / step - 1e-9);
      if (n <= lines) return { step, max: Math.max(1, n) * step };
    }
    return { step: max, max };
  }
  /** Time gridlines in seconds: a round number of minutes, 3-6 lines for the whole dive. */
  function timeTicks(totalSec) {
    const steps = [60, 120, 300, 600, 900, 1800, 3600, 7200], step = steps.find((s) => totalSec / s <= 6) || 7200;
    const out = []; for (let t = step; t < totalSec - step * 0.25; t += step) out.push(t);
    return { step, ticks: out };
  }

  /** The summary page: last dive date and total dive time. */
  function summarize(recs, today) {
    recs = uniqueDives(recs);
    if (!recs.length) return { count: 0, totalSec: 0, last: null };
    const last = recs.slice().sort(byStartDesc)[0];
    return { count: recs.length, totalSec: recs.reduce((a, r) => a + (r.durationSec || 0), 0),
      last: { date: dateKey(last), startedAt: last.startedAt, location: last.location || "", daysAgo: daysBetween(dateKey(last), today || new Date()) } };
  }

  // ---- month grouping (bulk locations for a dive trip) ----
  const monthKey = (rec) => rec.startedAt.slice(0, 7);                         // "YYYY-MM"
  function groupByMonth(recs) {
    const m = new Map();
    for (const r of recs.slice().sort(byStartDesc)) { const k = monthKey(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].map(([month, rs]) => ({ month, recs: rs }));
  }
  /** Fingerprints a bulk "whole month" action touches: only dives without a place unless `replace` is set. */
  const bulkTargets = (recs, replace) => recs.filter((r) => replace || !r.location).map((r) => r.fingerprint);
  /** The date rows of the location question, grouped by month (oldest month first), for a "whole month" input per month. */
  function asksByMonth(asks) {
    const m = new Map();
    for (const a of asks) { const k = a.date.slice(0, 7); if (!m.has(k)) m.set(k, []); m.get(k).push(a); }
    return [...m.entries()].map(([month, rows]) => ({ month, asks: rows }));
  }

  // ---- regulator service counter ----
  const REG_ORANGE = 70, REG_RED = 90;
  /** Dives on the regulator: the starting count plus every dive that began after `since`. Freedives do not use a regulator. */
  function regulatorCount(reg, recs) {
    if (!reg) return 0;
    return (reg.baseline || 0) + uniqueDives(recs).filter((r) => r.mode !== "freedive" && (!reg.since || r.startedAt > reg.since)).length;
  }
  const regulatorLevel = (n) => (n >= REG_RED ? "red" : n >= REG_ORANGE ? "orange" : "ok");
  /** Reset to 0: count only dives after the latest one logged so far. */
  const regulatorReset = (reg, recs) => ({ ...reg, baseline: 0, since: recs.reduce((a, r) => (r.startedAt > a ? r.startedAt : a), "") });

  // ---- diver profile (Summary): latest certification, DAN validity ----
  /** Whole days from today (local) until `key` (YYYY-MM-DD): positive = in the future, 0 = today, negative = past. */
  const daysUntil = (key, today) => 0 - daysBetween(key, today);          // (0 - x, not -x: avoids a negative zero)
  /**
   * The most recent dive certification (files of kind "dan" are insurance, not certifications). Ranked by the date it was earned;
   * certifications without a date only count when none has one (otherwise an old card uploaded today would look like the latest).
   */
  function latestCert(certs, pinnedId) {
    const mine = (certs || []).filter((c) => (c.kind || "cert") === "cert");
    const pinned = pinnedId && mine.find((c) => c.id === pinnedId);                  // the one you chose always wins
    if (pinned) return pinned;
    const dated = mine.filter((c) => c.certifiedOn);
    const pool = dated.length ? dated : mine;
    const when = (c) => c.certifiedOn || String(c.createdAt || "").slice(0, 10);
    return pool.slice().sort((a, b) => when(b).localeCompare(when(a)) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")))[0] || null;
  }
  /** DAN membership validity: state "none" (no date), "ok", "soon" (within `soonDays`, including today) or "expired". */
  function danStatus(validUntil, today, soonDays) {
    if (!validUntil) return { state: "none", days: null };
    const days = daysUntil(validUntil, today || new Date());
    return { state: days < 0 ? "expired" : days <= (soonDays == null ? 60 : soonDays) ? "soon" : "ok", days };
  }
  function danText(days) {
    if (days == null) return "";
    if (days < 0) return days === -1 ? "expired yesterday" : `expired ${-days} days ago`;
    return days === 0 ? "expires today" : days === 1 ? "1 day left" : days < 120 ? `${days} days left` : `${Math.round(days / 30.44)} months left`;
  }

  const api = { DEVICES, deviceOf, uniqueDives, diveNumbers, niceAxis, timeTicks, daysUntil, latestCert, danStatus, danText, monthKey, groupByMonth, bulkTargets, asksByMonth, REG_ORANGE, REG_RED, regulatorCount, regulatorLevel, regulatorReset, dateKey, normalizeLocation, knownLocations, groupByDate, dateLocation, locationAsks, hoursText, daysBetween, agoText, summarize };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.DiveUtils = api;
})(typeof self !== "undefined" ? self : this);
