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
  const DEVICES = [{ id: "cosmiq", name: "Cosmiq+ Gen 5", short: "Cosmiq+" }, { id: "peregrine", name: "Shearwater Peregrine", short: "Peregrine" }, { id: "perdix", name: "Shearwater Perdix", short: "Perdix" }, { id: "garmin", name: "Garmin Descent", short: "Garmin" }];
  const deviceOf = (rec) => rec.device || "cosmiq";
  /**
   * When two computers recorded the same dive, the record of the FIRST one in this list is the one shown and counted: the Shearwaters first
   * (their log is the most complete), the Cosmiq+ last. A dive copied from another person's log (`sharedFrom`) always comes after the person's own
   * computers: your own Perdix beats a Peregrine dive that was shared with you.
   */
  const PREFERENCE = ["peregrine", "perdix", "garmin", "cosmiq"];
  const isShared = (r) => !!r.sharedFrom;
  const startMs = (r) => Date.parse(r.startedAt + "Z"), HOUR = 3600000;
  /** Do the two dives overlap on the clock, started within 20 minutes of each other (the other computer started a few minutes early or late)? Two different dives of an hour each can overlap by chance when one clock is off, so a late start alone is not enough. */
  const overlaps = (a, b) => { const as = startMs(a), bs = startMs(b); return Math.abs(as - bs) <= 20 * 60000 && as < bs + (b.durationSec || 0) * 1000 && bs < as + (a.durationSec || 0) * 1000; };
  /** Clocks one or two whole hours apart (time zone / daylight saving: seen as exactly one hour in a real log): same length (5 min or 15 %) and depth (2 m or 10 %). */
  function shiftedSame(a, b) {
    const diff = startMs(b) - startMs(a), h = Math.round(diff / HOUR);
    if (h === 0 || Math.abs(h) > 2 || Math.abs(diff - h * HOUR) > 5 * 60000) return false;
    const ad = (a.durationSec || 0) * 1000, bd = (b.durationSec || 0) * 1000, ma = a.maxDepthM || 0, mb = b.maxDepthM || 0;
    return Math.abs(ad - bd) <= Math.max(300000, 0.15 * Math.max(ad, bd)) && Math.abs(ma - mb) <= Math.max(2, 0.1 * Math.max(ma, mb));
  }
  /**
   * A clock that is simply off by some minutes (a Perdix 66 min behind a Peregrine in June, 77 min in October: a time zone plus drift): the same dive has
   * the same length and depth, just another start time. Tight on length (2.5 min or 6 %) and depth (1 m or 5 %), and at most 2.5 h apart.
   */
  function offClockSame(a, b) {
    const ad = a.durationSec || 0, bd = b.durationSec || 0, ma = a.maxDepthM || 0, mb = b.maxDepthM || 0;
    return Math.abs(startMs(b) - startMs(a)) <= 2.5 * HOUR && Math.abs(ad - bd) <= Math.max(150, 0.06 * Math.max(ad, bd)) && Math.abs(ma - mb) <= Math.max(1, 0.05 * Math.max(ma, mb));
  }
  /** The same, but the length may differ by 20 % and the depth by 4 m or 15 % (two divers wear two computers: one surfaces a little earlier, one swims a little deeper). Only trusted when the clock offset agrees with the dives around it. */
  function offClockLoose(a, b) {
    const ad = a.durationSec || 0, bd = b.durationSec || 0, ma = a.maxDepthM || 0, mb = b.maxDepthM || 0;
    return Math.abs(startMs(b) - startMs(a)) <= 2.5 * HOUR && Math.abs(ad - bd) <= Math.max(150, 0.2 * Math.max(ad, bd)) && Math.abs(ma - mb) <= Math.max(4, 0.15 * Math.max(ma, mb));
  }
  const sameDive = (a, b) => overlaps(a, b) || shiftedSame(a, b) || offClockSame(a, b);
  /**
   * Dives recorded by two computers at once: {duplicate fingerprint -> the fingerprint it duplicates}. The computers are ranked in
   * DEVICES order (the Cosmiq+ first): the higher-ranked computer's dive is the one that is kept and counted. Dives of the same
   * computer are never duplicates of each other. A clock that is whole hours off is only trusted for a dive nothing else matched,
   * and each kept dive is matched that way at most once (a second dive of the same size 1-2 hours away is a different dive).
   */
  function duplicateMap(recs) {
    const out = new Map(), kept = [];
    for (const shared of [false, true]) for (const id of PREFERENCE) {
      const mine = recs.filter((r) => deviceOf(r) === id && isShared(r) === shared), matched = new Set(), claimed = new Set(), rest = [];
      for (const r of mine) { const hit = kept.find((k) => Math.abs(startMs(k) - startMs(r)) < 15 * HOUR && overlaps(k, r)); if (hit) { out.set(r.fingerprint, hit.fingerprint); matched.add(hit.fingerprint); } else rest.push(r); }
      // dives with no simultaneous twin: the same dive on a clock that is off. One-to-one, best match first.
      const edges = [];
      for (const r of rest) for (const k of kept) {
        if (matched.has(k.fingerprint) || Math.abs(startMs(k) - startMs(r)) >= 15 * HOUR) continue;
        const whole = shiftedSame(k, r), off = !whole && offClockSame(k, r), loose = !whole && !off && offClockLoose(k, r); if (!whole && !off && !loose) continue;
        edges.push({ r, k, dt: startMs(r) - startMs(k), whole, loose, cost: Math.abs((k.durationSec || 0) - (r.durationSec || 0)) / 60 + Math.abs((k.maxDepthM || 0) - (r.maxDepthM || 0)) - (whole ? 1 : 0) + Math.abs(startMs(r) - startMs(k)) / 1e7 });
      }
      edges.sort((x, y) => x.cost - y.cost);
      const offCount = (key, fp) => edges.filter((e) => !e.whole && !e.loose && e[key].fingerprint === fp).length, refs = [], used = new Set(), take = (e) => { out.set(e.r.fingerprint, e.k.fingerprint); claimed.add(e.k.fingerprint); used.add(e.r.fingerprint); refs.push(e); };
      for (const e of edges) {                                                      // round 1: whole hours, and look-alikes that have no competitor
        if (used.has(e.r.fingerprint) || claimed.has(e.k.fingerprint)) continue;
        if (e.whole || (!e.loose && offCount("r", e.r.fingerprint) === 1 && offCount("k", e.k.fingerprint) === 1)) take(e);
      }
      for (const e of edges) {                                                      // round 2: a dive with several look-alikes only matches the one whose clock offset agrees with its neighbours' (within 6 min, within 3 days)
        if (used.has(e.r.fingerprint) || claimed.has(e.k.fingerprint)) continue;
        if (refs.some((x) => Math.abs(startMs(x.r) - startMs(e.r)) <= 72 * HOUR && Math.abs(x.dt - e.dt) <= 6 * 60000)) take(e);
      }
      for (const r of mine) if (!out.has(r.fingerprint)) kept.push(r);
    }
    for (const r of recs) if (!PREFERENCE.includes(deviceOf(r))) kept.push(r);
    return out;
  }
  /** {dup: duplicate fingerprint -> kept fingerprint, extras: kept fingerprint -> [the records hidden behind it]} */
  function duplicateGroups(recs) {
    const dup = duplicateMap(recs), extras = new Map(), byFp = new Map(recs.map((r) => [r.fingerprint, r]));
    for (const [d, k] of dup) { if (!extras.has(k)) extras.set(k, []); extras.get(k).push(byFp.get(d)); }
    return { dup, extras };
  }
  /** Dives to count in totals: every dive once. When two computers recorded the same dive, the Cosmiq+ record is used. */
  function uniqueDives(recs) {
    const { dup, extras } = duplicateGroups(recs);
    return recs.filter((r) => !dup.has(r.fingerprint)).map((r) => {                      // a place entered on a hidden record (for example the Cosmiq+'s) is not lost when another computer's record is the one shown
      const hidden = extras.get(r.fingerprint); if (!hidden || r.location) return r;
      const loc = hidden.map((h) => h.location).find(Boolean); return loc ? { ...r, location: loc } : r;
    }).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
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
    const all = recs; recs = uniqueDives(recs);
    if (!recs.length) return { count: 0, totalSec: 0, last: null, duplicates: 0, byKind: byKind([]) };
    const last = recs.slice().sort(byStartDesc)[0];
    return { count: recs.length, totalSec: recs.reduce((a, r) => a + (r.durationSec || 0), 0),
      duplicates: all.length - recs.length, byKind: byKind(all),
      last: { kind: kindOf(last), date: dateKey(last), startedAt: last.startedAt, location: last.location || "", daysAgo: daysBetween(dateKey(last), today || new Date()) } };
  }

  // ---- scuba or freedive ----
  const KINDS = ["scuba", "freedive"];
  /** A dive with a tank (scuba, or the computer in gauge mode) or a breath-hold dive. */
  const kindOf = (r) => (r.mode === "freedive" ? "freedive" : "scuba");
  const blank = () => ({ count: 0, sec: 0 });
  /** Dives and dive time per kind, each dive counted once: {scuba: {count, sec}, freedive: {count, sec}}. */
  function byKind(recs) { const o = { scuba: blank(), freedive: blank() }; for (const r of uniqueDives(recs)) { const k = o[kindOf(r)]; k.count++; k.sec += r.durationSec || 0; } return o; }
  /** Short duration text for a total of seconds: "45 s", "3 min 13 s", "42 min", "3 h 20 min". */
  function durText(sec) { sec = Math.round(sec || 0); if (sec < 60) return sec + " s"; if (sec < 600) return `${Math.floor(sec / 60)} min ${sec % 60} s`; if (sec < 3600) return Math.round(sec / 60) + " min"; return hoursText(sec); }

  // ---- places (the dive locations, for the map) ----
  /**
   * Every place you have dived (free-text location, case-insensitive), most dives first. Each dive counts once.
   * [{key, name, count, first, last, by: {scuba: {count, sec, first, last}, freedive: {...}}}]. With `kind` ("scuba" | "freedive") only the places
   * where you did that kind remain, and count / first / last describe that kind only (`by` always has both).
   */
  function placeStats(recs, kind) {
    const m = new Map();
    for (const r of uniqueDives(recs).sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      if (!r.location) continue;
      const key = r.location.trim().toLowerCase(), k = kindOf(r);
      const e = m.get(key) || { key, name: r.location, count: 0, first: r.startedAt, last: r.startedAt, by: { scuba: { count: 0, sec: 0 }, freedive: { count: 0, sec: 0 } } };
      const b = e.by[k]; b.count++; b.sec += r.durationSec || 0; if (!b.first) b.first = r.startedAt; b.last = r.startedAt;
      e.count++; e.last = r.startedAt; e.name = r.location; m.set(key, e);                  // the newest spelling wins
    }
    let list = [...m.values()];
    if (kind) list = list.filter((e) => e.by[kind].count > 0).map((e) => ({ ...e, count: e.by[kind].count, first: e.by[kind].first, last: e.by[kind].last }));
    return list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
  /** Split the places into those with a position (pins) and those still to be put on the map. `coords`: key -> {lat, lon}. */
  function pinsAndMissing(stats, coords) {
    const pins = [], missing = [];
    for (const e of stats) { const c = coords[e.key]; if (c) pins.push({ ...e, lat: c.lat, lon: c.lon }); else missing.push(e); }
    return { pins, missing };
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

  // ---- regulator service: a reminder by dives AND a reminder by time ----
  const REG_ORANGE = 70, REG_RED = 90, REG_DEFAULT_MONTHS = 12, REG_HISTORY_MAX = 20;       // the original fixed limits: 90 dives, warning from 70
  /** Dives on the regulator: the starting count plus every dive that began after `since`. Freedives do not use a regulator. */
  function regulatorCount(reg, recs) {
    if (!reg) return 0;
    return (reg.baseline || 0) + uniqueDives(recs).filter((r) => r.mode !== "freedive" && (!reg.since || r.startedAt > reg.since)).length;
  }
  /** Whole months from a service month ("2026-03") to today: 0 in the same month. */
  const monthsSince = (ym, today) => { const t = today || new Date(); return (t.getFullYear() * 12 + t.getMonth()) - (+ym.slice(0, 4) * 12 + (+ym.slice(5, 7) - 1)); };
  const monthLabel = (ym, locale) => new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1).toLocaleDateString(locale, { month: "short", year: "numeric" });
  /** The warning starts 20 dives / 2 months before the limit (for small limits: after 75 % / one month before). */
  const diveWarnAt = (limit) => (limit >= 40 ? limit - 20 : Math.floor(limit * 0.75));
  const monthWarnAt = (limit) => (limit >= 6 ? limit - 2 : limit - 1);
  const worst = (levels) => (levels.includes("red") ? "red" : levels.includes("orange") ? "orange" : "ok");
  /**
   * Where the regulator stands. Two reminders, each optional (a limit of 0 switches it off): dives since the last service
   * and months since the last service (needs the service month). The regulator is orange / red when EITHER one is.
   * -> {dives, limitDives, diveLevel, divesLeft, months, limitMonths, monthLevel, monthsLeft, level, serviced, dueBy}
   *    diveLevel / monthLevel: "ok" | "orange" | "red" | "off" (limit 0) | "unknown" (no service month yet, months only)
   */
  function regulatorStatus(reg, recs, today) {
    const limitDives = reg && reg.limitDives != null ? reg.limitDives : REG_RED, limitMonths = reg && reg.limitMonths != null ? reg.limitMonths : REG_DEFAULT_MONTHS;
    const dives = regulatorCount(reg, recs), serviced = (reg && reg.serviced) || "", months = serviced ? monthsSince(serviced, today) : null;
    const diveLevel = !limitDives ? "off" : dives >= limitDives ? "red" : dives >= diveWarnAt(limitDives) ? "orange" : "ok";
    const monthLevel = !limitMonths ? "off" : months == null ? "unknown" : months >= limitMonths ? "red" : months >= monthWarnAt(limitMonths) ? "orange" : "ok";
    const level = worst([diveLevel, monthLevel]);
    const dueBy = level === "ok" ? null : [diveLevel === level ? "dives" : "", monthLevel === level ? "time" : ""].filter(Boolean).join("+");
    return { dives, limitDives, diveLevel, divesLeft: limitDives ? Math.max(0, limitDives - dives) : null, diveWarnAt: limitDives ? diveWarnAt(limitDives) : null,
      months, limitMonths, monthLevel, monthsLeft: limitMonths && months != null ? Math.max(0, limitMonths - months) : null, monthWarnAt: limitMonths ? monthWarnAt(limitMonths) : null, level, dueBy, serviced };
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  /** One sentence for the Summary: what is due, or how much is left. */
  function regulatorMessage(st, locale) {
    if (st.level === "red") {
      const parts = []; if (st.diveLevel === "red") parts.push(`${plural(st.dives, "dive")} (limit ${st.limitDives})`); if (st.monthLevel === "red") parts.push(`${plural(st.months, "month")} since ${monthLabel(st.serviced, locale)} (limit ${st.limitMonths})`);
      return "Service now: " + parts.join(" and ");
    }
    const left = []; if (st.divesLeft != null) left.push([st.diveLevel, plural(st.divesLeft, "dive")]); if (st.monthsLeft != null) left.push([st.monthLevel, plural(st.monthsLeft, "month")]);
    if (!left.length) return "Add the last service date to get a time reminder";
    if (st.level === "orange") return "Service soon: " + left.filter(([l]) => l === "orange").map(([, t]) => t).join(" or ") + " to go";
    return "Next service in " + left.map(([, t]) => t).join(" or ");
  }
  /** The original single-number rule (90 dives, warning from 70) for callers that only have a count. Custom limits and the time reminder: regulatorStatus. */
  const regulatorLevel = (n) => (n >= REG_RED ? "red" : n >= REG_ORANGE ? "orange" : "ok");
  /**
   * Reset to 0: count only dives after the latest one logged so far. With `opts.serviced` ("YYYY-MM") the service is recorded: the month becomes the
   * last service and the service is added to the history together with the dives the regulator had done.
   */
  function regulatorReset(reg, recs, opts) {
    const next = { ...reg, baseline: 0, since: recs.reduce((a, r) => (r.startedAt > a ? r.startedAt : a), "") };
    if (opts && opts.serviced) {
      const t = opts.today || new Date(), at = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      next.serviced = opts.serviced; next.history = [{ m: opts.serviced, dives: regulatorCount(reg, recs), at }, ...(reg && reg.history || [])].slice(0, REG_HISTORY_MAX);
    }
    return next;
  }

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

  /** The map-pin icon (outline, takes the colour of the text around it) used wherever a place is shown. */
  const PIN = '<svg class="pin" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>';
  const api = { PIN, PREFERENCE, isShared, duplicateGroups, regulatorStatus, regulatorMessage, monthsSince, monthLabel, REG_HISTORY_MAX, KINDS, kindOf, byKind, durText, placeStats, pinsAndMissing, DEVICES, deviceOf, uniqueDives, duplicateMap, sameDive, diveNumbers, niceAxis, timeTicks, daysUntil, latestCert, danStatus, danText, monthKey, groupByMonth, bulkTargets, asksByMonth, REG_ORANGE, REG_RED, regulatorCount, regulatorLevel, regulatorReset, dateKey, normalizeLocation, knownLocations, groupByDate, dateLocation, locationAsks, hoursText, daysBetween, agoText, summarize };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.DiveUtils = api;
})(typeof self !== "undefined" ? self : this);
