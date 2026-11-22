import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
const U = createRequire(import.meta.url)("../public/dive-utils.js");
const dive = (startedAt, durationSec, location, fp) => ({ fingerprint: fp || startedAt, startedAt, durationSec, ...(location ? { location } : {}) });

test("normalizeLocation: cleans input and reuses the spelling of a known place", () => {
  assert.equal(U.normalizeLocation("  Komodo   National\tPark "), "Komodo National Park");
  assert.equal(U.normalizeLocation("komodo", ["Banda", "Komodo"]), "Komodo", "case-insensitive match uses the known spelling");
  assert.equal(U.normalizeLocation("Ban\u0000da\n"), "Ban da"); assert.equal(U.normalizeLocation("   "), ""); assert.equal(U.normalizeLocation(null), "");
  assert.equal(U.normalizeLocation("x".repeat(100)).length, 60);
  assert.equal(U.normalizeLocation("Tulamben", ["Banda"]), "Tulamben");
});

test("knownLocations: distinct, most recently dived first, case-insensitive", () => {
  const r = [dive("2024-01-01T10:00:00", 3600, "Banda"), dive("2025-05-01T10:00:00", 3600, "Komodo"), dive("2025-06-01T10:00:00", 3600, "komodo"),
    dive("2023-01-01T10:00:00", 3600, "Tulamben"), dive("2025-07-01T10:00:00", 3600)];
  assert.deepEqual(U.knownLocations(r), ["komodo", "Banda", "Tulamben"], "the most recent spelling wins");
  assert.deepEqual(U.knownLocations([]), []);
});

test("groupByDate and dateLocation: newest first, mixed / missing detected", () => {
  const r = [dive("2025-03-14T09:00:00", 60, "Banda", "a"), dive("2025-03-15T08:00:00", 60, "", "b"), dive("2025-03-14T13:00:00", 60, "Komodo", "c"), dive("2025-03-15T11:00:00", 60, "", "d")];
  const g = U.groupByDate(r);
  assert.deepEqual(g.map((x) => x.date), ["2025-03-15", "2025-03-14"]); assert.deepEqual(g[1].recs.map((x) => x.fingerprint), ["c", "a"], "newest dive first within a date");
  assert.deepEqual(U.dateLocation(g[1].recs), { location: "", mixed: true, missing: 0 });
  assert.deepEqual(U.dateLocation(g[0].recs), { location: "", mixed: false, missing: 2 });
  assert.deepEqual(U.dateLocation([r[0]]), { location: "Banda", mixed: false, missing: 0 });
});

test("locationAsks: one row per date, oldest first, pre-filled from other dives of the same date", () => {
  const all = [dive("2025-03-14T09:00:00", 60, "Banda", "old"), dive("2025-03-14T15:00:00", 60, "", "n1"), dive("2025-03-16T09:00:00", 60, "", "n2"), dive("2025-03-15T09:00:00", 60, "", "n3"), dive("2025-03-15T12:00:00", 60, "", "n4")];
  const asks = U.locationAsks(all.filter((r) => !r.location), all);
  assert.deepEqual(asks.map((a) => a.date), ["2025-03-14", "2025-03-15", "2025-03-16"]);
  assert.deepEqual(asks.map((a) => a.count), [1, 2, 1]); assert.deepEqual(asks[1].fps, ["n3", "n4"]);
  assert.deepEqual(asks.map((a) => a.prefill), ["Banda", "", ""], "same-day dive already located -> suggested");
  assert.deepEqual(U.locationAsks([], all), []);
});

test("summarize: last dive date, total dive time, dive count, location of the last dive", () => {
  const r = [dive("2026-10-17T08:26:00", 4500, "Komodo"), dive("2026-10-12T06:36:00", 3600), dive("2021-06-11T14:10:00", 3600 * 2 + 60)];
  const s = U.summarize(r, new Date(2026, 10, 21, 15, 0));
  assert.equal(s.count, 3); assert.equal(s.totalSec, 4500 + 3600 + 7260);
  assert.deepEqual(s.last, { kind: "scuba", date: "2026-10-17", startedAt: "2026-10-17T08:26:00", location: "Komodo", daysAgo: 35 });
  assert.deepEqual(U.summarize([], new Date()), { count: 0, totalSec: 0, last: null, duplicates: 0, byKind: { scuba: { count: 0, sec: 0 }, freedive: { count: 0, sec: 0 } } }); assert.equal(s.duplicates, 0);
  assert.equal(U.summarize([dive("2026-11-21T09:00:00", 60)], new Date(2026, 10, 21, 23, 59)).last.daysAgo, 0, "same calendar day = today");
});

test("daysBetween crosses month / year / leap boundaries; agoText wording", () => {
  assert.equal(U.daysBetween("2026-01-31", new Date(2026, 1, 1)), 1); assert.equal(U.daysBetween("2025-12-31", new Date(2026, 0, 1)), 1);
  assert.equal(U.daysBetween("2024-02-28", new Date(2024, 2, 1)), 2, "2024 is a leap year"); assert.equal(U.daysBetween("2026-03-28", new Date(2026, 2, 28)), 0);
  assert.deepEqual([0, 1, 2, 59, 60, 400, 730, 2000].map(U.agoText), ["today", "yesterday", "2 days ago", "59 days ago", "about 2 months ago", "about 13 months ago", "about 2 years ago", "about 5 years ago"]);
});

test("hoursText rounds to minutes and never shows 60 min", () => {
  assert.equal(U.hoursText(0), "0 h 00 min"); assert.equal(U.hoursText(3599), "1 h 00 min"); assert.equal(U.hoursText(3600 * 117 + 41 * 60), "117 h 41 min"); assert.equal(U.hoursText(5429), "1 h 30 min"); assert.equal(U.hoursText(5430), "1 h 31 min", "half a minute rounds up");
});

test("groupByMonth + bulkTargets: a trip's dives in one month, only those without a place unless told to replace", () => {
  const r = [dive("2026-10-12T06:36:00", 60, "", "a"), dive("2026-10-17T08:26:00", 60, "Komodo", "b"), dive("2026-09-30T10:00:00", 60, "", "c"), dive("2026-10-01T10:00:00", 60, "", "d")];
  const g = U.groupByMonth(r);
  assert.deepEqual(g.map((x) => x.month), ["2026-10", "2026-09"], "newest month first");
  assert.deepEqual(g[0].recs.map((x) => x.fingerprint), ["b", "a", "d"]);
  assert.deepEqual(U.bulkTargets(g[0].recs, false), ["a", "d"], "keeps the place already set on b");
  assert.deepEqual(U.bulkTargets(g[0].recs, true), ["b", "a", "d"], "replace overwrites everything");
  assert.equal(U.monthKey(r[2]), "2026-09"); assert.deepEqual(U.groupByMonth([]), []);
});

test("asksByMonth: date rows grouped per month, oldest first", () => {
  const all = [dive("2026-09-30T10:00:00", 60, "", "c"), dive("2026-10-01T10:00:00", 60, "", "d"), dive("2026-10-12T06:36:00", 60, "", "a"), dive("2026-10-12T14:00:00", 60, "", "e")];
  const g = U.asksByMonth(U.locationAsks(all, all));
  assert.deepEqual(g.map((x) => [x.month, x.asks.map((a) => a.date)]), [["2026-09", ["2026-09-30"]], ["2026-10", ["2026-10-01", "2026-10-12"]]]);
});

test("regulatorCount: starting count + dives after 'since'; freedives never count; reset = 0 and only later dives add", () => {
  const dives = [dive("2025-01-01T10:00:00", 60, "", "a"), { ...dive("2025-02-01T10:00:00", 60, "", "f"), mode: "freedive" }, dive("2025-03-01T10:00:00", 60, "", "b"), { ...dive("2025-04-01T10:00:00", 60, "", "g"), mode: "gauge" }];
  assert.equal(U.regulatorCount(null, dives), 0);
  assert.equal(U.regulatorCount({ baseline: 0, since: "" }, dives), 3, "scuba + gauge count, the freedive does not");
  assert.equal(U.regulatorCount({ baseline: 40, since: "" }, dives), 43, "starting count is added");
  assert.equal(U.regulatorCount({ baseline: 5, since: "2025-02-15T00:00:00" }, dives), 5 + 2, "only dives after 'since'");
  assert.equal(U.regulatorCount({ baseline: 0, since: "2025-03-01T10:00:00" }, dives), 1, "a dive AT 'since' is not counted again");
  const reset = U.regulatorReset({ name: "X", type: "Y", baseline: 80, since: "2020-01-01T00:00:00" }, dives);
  assert.deepEqual(reset, { name: "X", type: "Y", baseline: 0, since: "2025-04-01T10:00:00" });
  assert.equal(U.regulatorCount(reset, dives), 0, "0 right after the reset");
  assert.equal(U.regulatorCount(reset, [...dives, dive("2025-05-01T10:00:00", 60, "", "n1"), dive("2025-05-02T10:00:00", 60, "", "n2")]), 2, "grows with every new dive");
  assert.equal(U.regulatorCount(reset, [...dives, { ...dive("2025-05-03T10:00:00", 60, "", "fd"), mode: "freedive" }]), 0, "a new freedive does not move it");
  assert.equal(U.regulatorReset({ name: "X", baseline: 3 }, []).since, "", "no dives yet: everything later counts");
});

test("regulatorLevel: green below 70, orange from 70, red from 90", () => {
  assert.deepEqual([0, 1, 69, 70, 71, 89, 90, 91, 200].map(U.regulatorLevel), ["ok", "ok", "ok", "orange", "orange", "orange", "red", "red", "red"]);
  assert.equal(U.REG_ORANGE, 70); assert.equal(U.REG_RED, 90);
});

test("latestCert: ranked by the date earned; dan documents are not certifications; undated ones only count when nothing is dated", () => {
  const c = (id, label, certifiedOn, createdAt, kind) => ({ id, label, certifiedOn, createdAt, ...(kind ? { kind } : {}) });
  assert.equal(U.latestCert([]), null); assert.equal(U.latestCert(null), null);
  assert.equal(U.latestCert([c(1, "OW", "2019-03-01", "2026-11-01"), c(2, "AOW", "2023-06-10", "2026-11-02"), c(3, "Nitrox", "2021-01-01", "2026-11-03")]).label, "AOW", "the newest date earned, not the newest upload");
  assert.equal(U.latestCert([c(1, "AOW", "2023-06-10", "2026-11-02"), c(2, "Old card, no date", "", "2026-11-20")]).label, "AOW", "an undated card uploaded today does not beat a dated one");
  assert.equal(U.latestCert([c(1, "A", "", "2026-01-05"), c(2, "B", "", "2026-03-09")]).label, "B", "nothing dated: the latest upload");
  assert.equal(U.latestCert([c(1, "DAN card", "2026-11-01", "2026-11-01", "dan"), c(2, "OW", "2019-03-01", "2019-03-01")]).label, "OW", "insurance documents are ignored");
  assert.equal(U.latestCert([c(1, "DAN card", "", "2026-11-01", "dan")]), null, "only an insurance document: no certification");
  assert.equal(U.latestCert([c(1, "X", "2024-01-01", "2024-02-01"), c(2, "Y", "2024-01-01", "2024-03-01")]).label, "Y", "same date: the later upload");
});

test("danStatus: ok / soon (within 60 days, including today) / expired; wording", () => {
  const today = new Date(2026, 10, 21, 15, 0);                                  // 21 Nov 2026
  assert.deepEqual(U.danStatus("", today), { state: "none", days: null }); assert.deepEqual(U.danStatus(null, today), { state: "none", days: null });
  assert.deepEqual(U.danStatus("2027-03-31", today), { state: "ok", days: 130 });
  assert.deepEqual(U.danStatus("2027-01-20", today), { state: "soon", days: 60 }, "exactly 60 days is already 'soon'");
  assert.deepEqual(U.danStatus("2027-01-21", today), { state: "ok", days: 61 });
  assert.deepEqual(U.danStatus("2026-11-21", today), { state: "soon", days: 0 }, "valid through the whole last day");
  assert.deepEqual(U.danStatus("2026-11-20", today), { state: "expired", days: -1 });
  assert.deepEqual(U.danStatus("2026-10-01", today), { state: "expired", days: -51 });
  assert.equal(U.danStatus("2026-12-25", today, 30).state, "ok", "the threshold can be changed"); assert.equal(U.danStatus("2026-12-25", today, 40).state, "soon");
  assert.deepEqual([null, -1, -51, 0, 1, 45, 130, 400].map(U.danText), ["", "expired yesterday", "expired 51 days ago", "expires today", "1 day left", "45 days left", "4 months left", "13 months left"]);
  assert.equal(U.daysUntil("2027-02-28", new Date(2026, 1, 28)), 365); assert.equal(U.daysUntil("2024-03-01", new Date(2024, 1, 28)), 2, "leap year");
});

test("latestCert: a certification you pinned always wins; a stale or non-certification pin is ignored", () => {
  const certs = [{ id: "a", kind: "cert", label: "Advance", certifiedOn: "2020-01-01", createdAt: "2026-01-01" }, { id: "b", kind: "cert", label: "Dive Master", certifiedOn: "2024-06-01", createdAt: "2025-01-01" },
    { id: "d", kind: "dan", label: "DAN card", certifiedOn: "2026-01-01", createdAt: "2026-02-01" }];
  assert.equal(U.latestCert(certs).id, "b", "by date when nothing is pinned");
  assert.equal(U.latestCert(certs, "a").id, "a", "pinned beats the newer date");
  assert.equal(U.latestCert(certs, "d").id, "b", "an insurance file cannot be pinned as a certification");
  assert.equal(U.latestCert(certs, "gone").id, "b", "pin of a deleted file falls back to the dates");
  // the user's real case: no dates at all, so upload order decided it
  const undated = [{ id: "1", label: "Dive Master", createdAt: "2026-05-01 10:00:00" }, { id: "2", label: "Advance Adventurer", createdAt: "2026-05-01 10:05:00" }];
  assert.equal(U.latestCert(undated).id, "2", "without dates the last upload wins (the bug)"); assert.equal(U.latestCert(undated, "1").id, "1", "...unless you choose");
});

test("uniqueDives: a dive recorded by two computers counts once; separate dives and same-computer dives never merge", () => {
  const d = (startedAt, durationSec, device, fp) => ({ fingerprint: fp || device + startedAt, startedAt, durationSec, ...(device ? { device } : {}) });
  const cosmiq = d("2026-05-02T09:30:00", 2700), peregrine = d("2026-05-02T09:34:00", 2640, "peregrine");
  assert.equal(U.uniqueDives([cosmiq, peregrine]).length, 1, "overlap = same dive");
  assert.equal(U.uniqueDives([peregrine, cosmiq]).length, 1, "order does not matter");
  assert.equal(U.uniqueDives([cosmiq, d("2026-05-02T11:00:00", 2400, "peregrine")]).length, 2, "a later dive is a different dive");
  assert.equal(U.uniqueDives([cosmiq, d("2026-05-02T09:40:00", 600, undefined, "c2")]).length, 2, "same computer never merges");
  assert.equal(U.uniqueDives([cosmiq, d("2026-05-02T10:15:00", 2400, "peregrine")]).length, 2, "starting exactly when the other ended is a new dive");
  assert.equal(U.uniqueDives([]).length, 0);
  // totals and the regulator use it
  assert.equal(U.summarize([cosmiq, peregrine]).count, 1); assert.equal(U.summarize([cosmiq, peregrine]).totalSec, 2700);
  assert.equal(U.regulatorCount({ baseline: 10, since: "" }, [cosmiq, peregrine]), 11);
  assert.equal(U.regulatorCount({ baseline: 0, since: "" }, [cosmiq, peregrine, d("2026-05-03T09:00:00", 3000, "peregrine")]), 2);
});

test("diveNumbers: the computer's own number, else the place in that computer's log; numbered per computer", () => {
  const recs = [{ fingerprint: "a", startedAt: "2026-05-03T09:00:00", device: "peregrine" }, { fingerprint: "b", startedAt: "2026-05-01T09:00:00", device: "peregrine" },
    { fingerprint: "c", startedAt: "2026-05-02T09:00:00", device: "peregrine", number: 41 }, { fingerprint: "x", startedAt: "2026-05-02T09:00:00", number: 106 }];
  const n = U.diveNumbers(recs);
  assert.equal(n.get("b"), 1); assert.equal(n.get("a"), 3); assert.equal(n.get("c"), 41, "own number wins"); assert.equal(n.get("x"), 106);
});

test("chart axes: round gridlines that always cover the data", () => {
  for (const [max, step, top] of [[7, 2, 8], [3.4, 1, 4], [28.4, 10, 30], [18, 5, 20], [40, 10, 40], [41, 10, 50], [12, 5, 15], [0.5, 0.1, 0.5], [1, 0.2, 1], [100, 20, 100]]) {
    const a = U.niceAxis(max, 5); assert.ok(a.max >= max - 1e-9, `covers ${max}`); assert.ok(Math.abs(a.step - step) < 1e-9 && Math.abs(a.max - top) < 1e-9, `${max}: ${JSON.stringify(a)}`);
    assert.ok(Math.round(a.max / a.step) <= 5, "at most 5 gridlines");
  }
  assert.deepEqual(U.timeTicks(23 * 60), { step: 300, ticks: [300, 600, 900, 1200] });
  assert.deepEqual(U.timeTicks(45 * 60).ticks, [600, 1200, 1800, 2400]); assert.ok(U.timeTicks(30).ticks.length <= 6);
  assert.ok(U.timeTicks(3 * 3600).ticks.every((t) => t < 3 * 3600)); assert.ok(U.timeTicks(86400).ticks.length <= 12);
});

test("two dive computers: the Cosmiq+ dive is the one kept, in every situation seen in a real log", () => {
  const d = (startedAt, durationSec, depth, device) => ({ fingerprint: (device || "cosmiq") + startedAt, startedAt, durationSec, maxDepthM: depth, ...(device ? { device } : {}) });
  const cosmiq = (a, b, c) => d(a, b, c), pere = (a, b, c) => d(a, b, c, "peregrine");
  const keptOf = (recs) => U.uniqueDives(recs).map((r) => r.fingerprint);
  // the Peregrine started first: still the Cosmiq record is used (it used to be the earlier one)
  assert.deepEqual(keptOf([pere("2026-05-02T09:28:00", 2760, 28.4), cosmiq("2026-05-02T09:30:00", 2700, 28.5)]), ["cosmiq2026-05-02T09:30:00"]);
  assert.deepEqual(keptOf([cosmiq("2026-05-02T09:30:00", 2700, 28.5), pere("2026-05-02T09:28:00", 2760, 28.4)]), ["cosmiq2026-05-02T09:30:00"], "order of the list does not matter");
  // clocks 12 minutes apart (September 2024 in the real log): they still overlap
  assert.equal(keptOf([cosmiq("2024-09-07T12:00:00", 3600, 21.76), pere("2024-09-07T12:12:00", 3600, 22)]).length, 1);
  // clocks exactly one hour apart (5 May 2022 in the real log): no overlap on the clock, but the same dive
  assert.equal(keptOf([cosmiq("2022-05-05T11:03:00", 3180, 14.54), pere("2022-05-05T10:03:00", 2903, 13.5)]).length, 1, "one hour apart, same length and depth");
  assert.equal(keptOf([cosmiq("2022-05-05T14:58:00", 3360, 20.77), pere("2022-05-05T13:58:00", 3120, 20.1)]).length, 1);
  assert.equal(keptOf([cosmiq("2022-05-05T11:03:00", 3180, 14.54), pere("2022-05-05T10:03:00", 1200, 13.5)]).length, 2, "an hour apart but a very different length: a different dive");
  assert.equal(keptOf([cosmiq("2022-05-05T11:03:00", 3180, 14.54), pere("2022-05-05T10:03:00", 3100, 30)]).length, 2, "an hour apart but a very different depth: a different dive");
  assert.equal(keptOf([cosmiq("2022-05-05T11:03:00", 3180, 14.54), pere("2022-05-05T10:25:00", 1800, 14.5)]).length, 2, "not a whole number of hours apart and no overlap: a different dive");
  assert.equal(keptOf([cosmiq("2022-05-05T11:03:00", 3180, 14.54), pere("2022-05-05T10:40:00", 3180, 14.5)]).length, 1, "overlapping on the clock = the same dive");
  // separate dives: a later one, and a Peregrine-only dive
  assert.equal(keptOf([cosmiq("2026-05-02T09:30:00", 2700, 28.5), pere("2026-05-02T13:30:00", 2700, 28.5)]).length, 2, "hours later, same numbers: a different dive");
  assert.equal(keptOf([cosmiq("2026-05-02T09:30:00", 2700, 28.5), pere("2026-05-02T13:30:00", 2700, 28.5)]).length, 2, "4 h apart is not a clock offset we trust");
  // a Cosmiq dive that already has its own Peregrine twin is not matched again by a look-alike an hour away
  assert.equal(keptOf([cosmiq("2026-05-02T11:00:00", 3000, 20), pere("2026-05-02T11:01:00", 3000, 20), pere("2026-05-02T10:00:00", 3000, 20)]).length, 2, "the look-alike stays a separate dive");
  const all = [cosmiq("2026-05-02T09:30:00", 2700, 28.5), pere("2026-05-02T09:31:00", 2640, 28.4), pere("2026-05-03T07:00:00", 3000, 20, "peregrine"), cosmiq("2026-05-04T07:00:00", 3000, 20)];
  const m = U.duplicateMap(all); assert.deepEqual([...m.entries()], [["peregrine2026-05-02T09:31:00", "cosmiq2026-05-02T09:30:00"]], "only the Peregrine copy is marked, and it points at the Cosmiq dive");
  assert.equal(U.uniqueDives(all).length, 3); const sm = U.summarize(all, new Date(2026, 10, 21)); assert.equal(sm.count, 3); assert.equal(sm.duplicates, 1); assert.equal(sm.totalSec, 2700 + 3000 + 3000, "the Cosmiq length is used, not the Peregrine's");
  // short surface blips on the Peregrine during a Cosmiq dive are not extra dives
  assert.equal(keptOf([cosmiq("2022-06-09T08:16:00", 3900, 16.89), pere("2022-06-09T08:20:00", 20, 2.4)]).length, 1);
  // same computer never merges with itself, and unknown computers are left alone
  assert.equal(keptOf([pere("2026-05-02T09:30:00", 2700, 28), pere("2026-05-02T09:40:00", 600, 5)]).length, 2);
  assert.equal(keptOf([cosmiq("2026-05-02T09:30:00", 2700, 28.5), { fingerprint: "x", startedAt: "2026-05-02T09:31:00", durationSec: 2600, maxDepthM: 28, device: "other" }]).length, 2);
  assert.equal(U.regulatorCount({ baseline: 0, since: "" }, all), 3, "the regulator counts a dive worn on both wrists once");
});

test("Places.suggest: parses Photon results, drops junk and duplicates, needs 3 letters, newest request wins", async () => {
  const P = createRequire(import.meta.url)("../public/places.js"); const calls = [];
  const feat = (name, lon, lat, props = {}) => ({ geometry: { coordinates: [lon, lat] }, properties: { name, state: "North Sulawesi", country: "Indonesia", ...props } });
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ features: [feat("Bunaken", 124.84, 1.55, { district: "Bunaken" }), feat("Bunaken", 124.78, 1.6), feat("Bunaken National Park", 124.76, 1.67, { city: "Manado" }), feat("", 1, 1), feat("Nowhere", 500, 1), feat("Bad", "x", 1), { properties: { name: "NoGeometry" } }, feat("Bunaken", 124.8401, 1.5501)] }) }; };
  assert.deepEqual(await P.suggest("bu"), [], "fewer than 3 letters: no request"); assert.equal(calls.length, 0);
  const r = await P.suggest("  bunak "); assert.equal(calls.length, 1); assert.match(calls[0].url, /photon\.komoot\.io\/api\/\?limit=8&lang=en&q=bunak$/); assert.equal(calls[0].opts.referrerPolicy, "origin");
  assert.deepEqual(r.map((x) => x.name), ["Bunaken", "Bunaken", "Bunaken National Park"], "empty names, impossible coordinates and a near-identical repeat are dropped; two different Bunakens stay");
  assert.deepEqual(r[0], { name: "Bunaken", region: "North Sulawesi, Indonesia", lat: 1.55, lon: 124.84 }, "region leaves out the name itself"); assert.equal(r[2].region, "Manado, North Sulawesi, Indonesia");
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) }); await assert.rejects(P.suggest("bunaken"), /busy/);
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) }); assert.deepEqual(await P.suggest("bunaken"), []);
  let aborted = 0; globalThis.fetch = (url, o) => new Promise((res, rej) => { o.signal.addEventListener("abort", () => { aborted++; rej(Object.assign(new Error("aborted"), { name: "AbortError" })); }); setTimeout(() => res({ ok: true, json: async () => ({ features: [] }) }), 20); });
  const first = P.suggest("bunak1"), second = P.suggest("bunak2"); await assert.rejects(first, /aborted/); await second; assert.equal(aborted, 1, "a newer request cancels the older one");
  delete globalThis.fetch;
});

test("app icons: a diver-down flag in every size, linked from the app and the sign-in pages", async () => {
  const fs = await import("node:fs"), root = new URL("../public/", import.meta.url);
  const png = (f) => { const b = fs.readFileSync(new URL(f, root)); assert.deepEqual([...b.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], f + " is a PNG"); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
  assert.deepEqual(png("icon-192.png"), { w: 192, h: 192 }); assert.deepEqual(png("icon-512.png"), { w: 512, h: 512 }); assert.deepEqual(png("apple-touch-icon.png"), { w: 180, h: 180 });
  for (const f of ["favicon.svg", "auth/favicon.svg"]) { const s = fs.readFileSync(new URL(f, root), "utf8"); assert.match(s, /^<svg [^>]*viewBox="0 0 64 64"/); assert.match(s, /#d94b3c/); assert.match(s, /<polygon[^>]*fill="#fff"/); assert.ok(!/<script|onload|href=/i.test(s), "no active content in the icon"); }
  assert.deepEqual(fs.readFileSync(new URL("auth/apple-touch-icon.png", root)), fs.readFileSync(new URL("apple-touch-icon.png", root)));
  const main = fs.readFileSync(new URL("index.html", root), "utf8"); assert.match(main, /rel="icon" href="favicon\.svg" type="image\/svg\+xml"/); assert.match(main, /rel="apple-touch-icon" href="apple-touch-icon\.png"/);
  for (const f of ["auth/login.html", "auth/mfa.html"]) { const h = fs.readFileSync(new URL(f, root), "utf8"); assert.match(h, /rel="icon" href="\/auth\/favicon\.svg"/, f); assert.match(h, /rel="apple-touch-icon" href="\/auth\/apple-touch-icon\.png"/, f); }
  const mf = JSON.parse(fs.readFileSync(new URL("manifest.webmanifest", root), "utf8")); for (const i of mf.icons) assert.ok(fs.existsSync(new URL(i.src, root)), i.src + " exists");
});

test("logo: a transparent PNG for each theme, shown in the app header and on both sign-in pages", async () => {
  const fs = await import("node:fs"), root = new URL("../public/", import.meta.url), zlib = await import("node:zlib");
  for (const f of ["auth/logo-light.png", "auth/logo-dark.png"]) {
    const b = fs.readFileSync(new URL(f, root)); assert.deepEqual([...b.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], f + " is a PNG");
    assert.ok(b.readUInt32BE(16) >= 700 && b.readUInt32BE(16) <= 900, "sharp enough for a phone screen: " + b.readUInt32BE(16)); assert.ok(b.length < 60_000, f + " stays small (" + b.length + " bytes)");
    assert.equal(b[25], 3, "a palette image"); assert.ok(b.includes(Buffer.from("tRNS")), "with transparency");
    let i = 8, trns = null; while (i < b.length) { const len = b.readUInt32BE(i), type = b.slice(i + 4, i + 8).toString(); if (type === "tRNS") trns = b.slice(i + 8, i + 8 + len); i += 12 + len; }
    assert.ok([...trns].some((v) => v === 0), "one palette entry is fully transparent (so there is no faint box around the logo)");
  }
  const main = fs.readFileSync(new URL("index.html", root), "utf8"); assert.match(main, /<h1 class="brand"><img class="logo logo-light" src="\/auth\/logo-light\.png" alt="Dive Manager"/); assert.match(main, /class="logo logo-dark" src="\/auth\/logo-dark\.png" alt="Dive Manager"/);
  for (const f of ["auth/login.html", "auth/mfa.html"]) { const h = fs.readFileSync(new URL(f, root), "utf8"); assert.match(h, /<h1 class="brand"><img class="logo logo-light" src="\/auth\/logo-light\.png"/, f); assert.match(h, /html\[data-theme="dark"\] \.brand \.logo-dark \{ display: inline-block; \}/, f); assert.ok(!/<h1>Dive Manager<\/h1>/.test(h), f + ": the plain text title is gone"); }
  assert.ok(fs.existsSync(new URL("../design/logo-source.png", root)), "the source artwork is kept so the logo can be regenerated");
});

test("fonts and tab icons: Geist and Geist Mono served from the app, tab icons as one-colour masks", async () => {
  const fs = await import("node:fs"), root = new URL("../public/", import.meta.url);
  for (const [f, min] of [["auth/fonts/Geist-Variable.woff2", 40000], ["auth/fonts/GeistMono-Variable.woff2", 40000]]) { const b = fs.readFileSync(new URL(f, root)); assert.equal(b.slice(0, 4).toString(), "wOF2", f + " is a WOFF2 font"); assert.ok(b.length > min && b.length < 120000, f + " " + b.length); }
  assert.match(fs.readFileSync(new URL("auth/fonts/LICENSE-Geist-OFL.txt", root), "utf8"), /OPEN FONT LICENSE/i, "the licence travels with the fonts");
  const css = fs.readFileSync(new URL("auth/fonts.css", root), "utf8"); assert.match(css, /font-family: "Geist";[^}]*Geist-Variable\.woff2[^}]*font-weight: 100 900/); assert.match(css, /font-family: "Geist Mono";[^}]*GeistMono-Variable\.woff2/); assert.ok(!/https?:\/\//.test(css.replace(/\/\*[\s\S]*?\*\//g, "")), "no font is loaded from another website");
  for (const f of ["auth/icon-summary.png", "auth/icon-log.png", "auth/icon-cert.png", "auth/icon-device.png"]) { const b = fs.readFileSync(new URL(f, root)); assert.deepEqual([...b.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]); assert.equal(b.readUInt32BE(16), 148); assert.equal(b.readUInt32BE(20), 148); assert.equal(b[25], 6, f + " has an alpha channel (the mask)"); }
  const main = fs.readFileSync(new URL("index.html", root), "utf8"); assert.match(main, /href="\/auth\/fonts\.css"/); assert.match(main, /rel="preload" href="\/auth\/fonts\/Geist-Variable\.woff2" as="font" type="font\/woff2" crossorigin/); assert.match(main, /--mono: "Geist Mono"/);
  for (const [id, cls] of [["navSummary", "ti-summary"], ["navLog", "ti-log"], ["navDevice", "ti-device"]]) assert.match(main, new RegExp(`id="${id}"[^>]*><i class="ti ${cls}" aria-hidden="true"></i><span>`));
  for (const f of ["auth/login.html", "auth/mfa.html"]) { const h = fs.readFileSync(new URL(f, root), "utf8"); assert.match(h, /<link rel="stylesheet" href="\/auth\/fonts\.css">/, f); assert.match(h, /font-family:"Geist"/, f); }
  assert.ok(fs.existsSync(new URL("../design/tab-icons-source.png", root)), "the source artwork is kept");
});

test("scuba and freedive: told apart in the totals and on the map, each dive counted once", () => {
  const d = (startedAt, durationSec, mode, location, device, depth = 20) => ({ fingerprint: (device || "c") + startedAt, startedAt, durationSec, mode, maxDepthM: depth, ...(location ? { location } : {}), ...(device ? { device } : {}) });
  const recs = [d("2026-05-01T09:00:00", 3000, "scuba", "Tulamben"), d("2026-05-01T13:00:00", 3300, "scuba", "Tulamben"), d("2026-05-02T09:00:00", 2700, "gauge", "Komodo"),
    d("2026-05-03T09:00:00", 45, "freedive", "Bunaken", undefined, 12), d("2026-05-03T09:10:00", 70, "freedive", "bunaken", undefined, 15), d("2026-05-03T14:00:00", 3000, "scuba", "Bunaken"), d("2026-05-04T08:00:00", 90, "freedive", "Raja Ampat", undefined, 14), d("2026-05-05T08:00:00", 600, "scuba")];
  assert.equal(U.kindOf({ mode: "freedive" }), "freedive"); assert.equal(U.kindOf({ mode: "scuba" }), "scuba"); assert.equal(U.kindOf({ mode: "gauge" }), "scuba", "a dive in gauge mode is a dive with a tank"); assert.equal(U.kindOf({}), "scuba");
  const k = U.byKind(recs); assert.deepEqual(k, { scuba: { count: 5, sec: 3000 + 3300 + 2700 + 3000 + 600 }, freedive: { count: 3, sec: 45 + 70 + 90 } });
  const sm = U.summarize(recs, new Date(2026, 10, 1)); assert.deepEqual(sm.byKind, k); assert.equal(sm.count, 8); assert.equal(sm.last.kind, "scuba"); assert.equal(sm.totalSec, k.scuba.sec + k.freedive.sec, "kinds add up to the total");
  assert.equal(U.summarize([d("2026-05-09T08:00:00", 50, "freedive")], new Date(2026, 10, 1)).last.kind, "freedive");
  // the same dive on both computers is one dive of one kind (the Cosmiq+ record decides)
  const twin = [d("2026-05-06T09:00:00", 3000, "scuba"), d("2026-05-06T09:02:00", 2940, "scuba", undefined, "peregrine"), d("2026-05-06T15:00:00", 60, "freedive", undefined, "peregrine")];
  assert.deepEqual(U.byKind(twin), { scuba: { count: 1, sec: 3000 }, freedive: { count: 1, sec: 60 } });
  // places: both kinds counted per place, Bunaken/bunaken is one place
  const ps = U.placeStats(recs), by = (n) => ps.find((e) => e.name.toLowerCase() === n.toLowerCase());
  assert.deepEqual(ps.map((e) => e.key), ["bunaken", "tulamben", "komodo", "raja ampat"].sort((a, b) => (by(b) || { count: 0 }).count - (by(a) || { count: 0 }).count || a.localeCompare(b)), "most dives first");
  assert.equal(by("Bunaken").count, 3); assert.deepEqual([by("Bunaken").by.scuba.count, by("Bunaken").by.freedive.count], [1, 2]); assert.equal(by("Bunaken").by.freedive.sec, 115); assert.equal(by("Tulamben").by.freedive.count, 0); assert.equal(by("Komodo").by.scuba.sec, 2700);
  assert.equal(by("Bunaken").by.freedive.first, "2026-05-03T09:00:00"); assert.equal(by("Bunaken").by.freedive.last, "2026-05-03T09:10:00");
  const fo = U.placeStats(recs, "freedive"); assert.deepEqual(fo.map((e) => [e.key, e.count]), [["bunaken", 2], ["raja ampat", 1]], "only places where you freedived, with the freedive count"); assert.equal(fo[0].last, "2026-05-03T09:10:00"); assert.equal(fo[0].by.scuba.count, 1, "`by` still has both kinds");
  const so = U.placeStats(recs, "scuba"); assert.deepEqual(so.map((e) => [e.key, e.count]), [["tulamben", 2], ["bunaken", 1], ["komodo", 1]]); assert.ok(!so.some((e) => e.key === "raja ampat"), "a freedive-only place is not on the scuba map");
  assert.deepEqual(U.pinsAndMissing(fo, { bunaken: { lat: 1, lon: 2 } }).missing.map((e) => e.key), ["raja ampat"]); assert.equal(U.pinsAndMissing(fo, { bunaken: { lat: 1, lon: 2 } }).pins[0].by.freedive.count, 2, "pins keep the breakdown");
  assert.deepEqual(U.placeStats([], "scuba"), []);
  // durations as text
  for (const [sec, txt] of [[0, "0 s"], [45, "45 s"], [193, "3 min 13 s"], [599, "9 min 59 s"], [600, "10 min"], [2520, "42 min"], [3599, "60 min"], [12000, "3 h 20 min"], [null, "0 s"]]) assert.equal(U.durText(sec), txt, String(sec));
});

test("theme: every colour variable the app uses is defined in the light and the dark palette", async () => {
  const fs = await import("node:fs"), root = new URL("../public/", import.meta.url), css = fs.readFileSync(new URL("auth/theme.css", root), "utf8");
  const light = css.slice(css.indexOf(":root"), css.indexOf('html[data-theme="dark"]')), dark = css.slice(css.indexOf('html[data-theme="dark"] {'), css.indexOf('html[data-theme="light"]'));
  const used = new Set(); for (const f of ["index.html", "dives.js", "account-area.js", "account.js", "places-ui.js", "api-keys.js", "dive-utils.js"]) for (const m of fs.readFileSync(new URL(f, root), "utf8").matchAll(/var\(--((?:bg|tx|bd)-[0-9a-f]{3,6})\)/g)) used.add(m[1]);
  assert.ok(used.size > 50, "found the colour variables: " + used.size);
  for (const v of used) { assert.ok(light.includes(`--${v}:`), "--" + v + " has a light value"); assert.ok(dark.includes(`--${v}:`), "--" + v + " has a dark value"); }
});

test("api access: the account page has the menu, the script and the endpoint information", async () => {
  const fs = await import("node:fs"), root = new URL("../public/", import.meta.url), main = fs.readFileSync(new URL("index.html", root), "utf8");
  assert.match(main, /<details class="card acc" data-sec="api">\s*<summary>API access/); assert.match(main, /<script src="api-keys\.js"><\/script>/); assert.match(main, /ApiKeys\.init\(\)/);
  for (const id of ["apiBase", "apiCurl", "apiExample", "apiDesc", "apiDays", "apiGen", "apiNew", "apiKeyText", "apiCopy", "apiHide", "apiList", "apiCount", "apiMsg", "apiUnlimitedWarn"]) assert.ok(main.includes(`id="${id}"`), id);
  assert.match(main, /<option value="7">7 days<\/option><option value="14">14 days<\/option><option value="30" selected>30 days<\/option><option value="0">Unlimited<\/option>/);
  for (const ep of ["/ping", "/summary", "/dives", "/dives/{id}"]) assert.ok(main.includes(`<code>${ep}</code>`), ep); for (const opt of ["limit", "cursor", "order", "from</code>, <code>to", "device", "kind", "location", "uploadedSince", "include"]) assert.ok(main.includes(`<code>${opt}</code>`), opt);
  const js = fs.readFileSync(new URL("api-keys.js", root), "utf8"); assert.ok(!/localStorage|sessionStorage/.test(js), "a key is never kept in browser storage");
  assert.ok(fs.readFileSync(new URL("sw.js", root), "utf8").includes('"api-keys.js"')); assert.ok(fs.existsSync(new URL("../migrations/0007_api_keys.sql", root)));
  assert.match(fs.readFileSync(new URL("../schema.sql", root), "utf8"), /CREATE TABLE IF NOT EXISTS api_keys[\s\S]*key_hash\s+TEXT NOT NULL UNIQUE/);
});

test("regulator reminders: by dives AND by time; either one turns it orange / red; limits can be switched off", () => {
  const dive = (i, mode) => ({ fingerprint: "f" + i, startedAt: `2026-05-${String(1 + (i % 28)).padStart(2, "0")}T${String(7 + (i % 12)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`, durationSec: 3000, mode: mode || "scuba" });
  const n = (k, mode) => Array.from({ length: k }, (_, i) => dive(i, mode)), T = (y, m, d) => new Date(y, m - 1, d || 15);
  // months since the service: whole calendar months, 0 in the same month
  assert.equal(U.monthsSince("2026-03", T(2026, 3, 31)), 0); assert.equal(U.monthsSince("2026-03", T(2026, 4, 1)), 1); assert.equal(U.monthsSince("2026-03", T(2026, 11, 22)), 8); assert.equal(U.monthsSince("2025-12", T(2026, 1, 1)), 1); assert.equal(U.monthsSince("2025-03", T(2027, 3, 1)), 24);
  // an existing regulator (no limits, no service month): exactly the old rules, 90 dives with the warning from 70, and no time reminder
  const old = { baseline: 0, since: "" };
  for (const [k, lvl] of [[0, "ok"], [69, "ok"], [70, "orange"], [89, "orange"], [90, "red"], [120, "red"]]) { const s = U.regulatorStatus(old, n(k), T(2026, 11)); assert.equal(s.level, lvl, k + " dives"); assert.equal(s.diveLevel, lvl); assert.equal(s.limitDives, 90); assert.equal(s.limitMonths, 12); assert.equal(s.monthLevel, "unknown"); assert.equal(s.months, null); }
  assert.equal(U.regulatorStatus(old, n(74), T(2026, 11)).divesLeft, 16); assert.equal(U.regulatorStatus(old, n(100), T(2026, 11)).divesLeft, 0, "never negative");
  assert.equal(U.regulatorLevel(69), "ok"); assert.equal(U.regulatorLevel(70), "orange"); assert.equal(U.regulatorLevel(90), "red"); assert.deepEqual([0, 69, 70, 90].map(U.regulatorLevel), ["ok", "ok", "orange", "red"], "safe to pass to map(): extra arguments are ignored");
  // by time: orange from 2 months before the limit, red at the limit
  const reg = { baseline: 0, since: "", serviced: "2026-03", limitDives: 90, limitMonths: 12 };
  for (const [today, months, lvl] of [[T(2026, 3), 0, "ok"], [T(2026, 11), 8, "ok"], [T(2026, 12), 9, "ok"], [T(2027, 1), 10, "orange"], [T(2027, 2), 11, "orange"], [T(2027, 3, 1), 12, "red"], [T(2028, 1), 22, "red"]]) {
    const s = U.regulatorStatus(reg, n(5), today); assert.equal(s.months, months); assert.equal(s.monthLevel, lvl, months + " months"); assert.equal(s.level, lvl, "only time is high: the regulator follows it"); assert.equal(s.diveLevel, "ok");
    assert.equal(s.dueBy, lvl === "ok" ? null : "time"); assert.equal(s.monthsLeft, Math.max(0, 12 - months));
  }
  // by dives only high; both high; the worse one wins
  assert.equal(U.regulatorStatus(reg, n(75), T(2026, 6)).dueBy, "dives"); assert.equal(U.regulatorStatus(reg, n(75), T(2027, 1)).dueBy, "dives+time", "both orange");
  const mixed = U.regulatorStatus(reg, n(95), T(2027, 1)); assert.deepEqual([mixed.diveLevel, mixed.monthLevel, mixed.level, mixed.dueBy], ["red", "orange", "red", "dives"], "red beats orange");
  assert.equal(U.regulatorStatus(reg, n(10), T(2027, 3, 1)).level, "red", "few dives but a year has passed: still due");
  // freedives do not count; a baseline does
  assert.equal(U.regulatorStatus({ ...reg, baseline: 60 }, n(15).concat(n(40, "freedive").map((d) => ({ ...d, fingerprint: "fd" + d.fingerprint }))), T(2026, 6)).dives, 75);
  // limits off: 0 switches a reminder off
  const noTime = U.regulatorStatus({ ...reg, limitMonths: 0 }, n(5), T(2030, 1)); assert.deepEqual([noTime.monthLevel, noTime.monthsLeft, noTime.level], ["off", null, "ok"], "time off: years pass, still ok");
  const noDives = U.regulatorStatus({ ...reg, limitDives: 0 }, n(500), T(2026, 6)); assert.deepEqual([noDives.diveLevel, noDives.divesLeft, noDives.level], ["off", null, "ok"], "dives off: 500 dives, still ok");
  // small limits warn earlier in proportion; custom limits
  assert.deepEqual([30, 39, 40, 100, 200].map((l) => U.regulatorStatus({ ...reg, limitDives: l }, [], T(2026, 3)).diveWarnAt), [22, 29, 20, 80, 180], "20 dives before the limit; for limits under 40, 75 %");
  assert.deepEqual([3, 5, 6, 12, 24].map((l) => U.regulatorStatus({ ...reg, limitMonths: l }, [], T(2026, 3)).monthWarnAt), [2, 4, 4, 10, 22], "2 months before the limit; for limits under 6, one month");
  assert.equal(U.regulatorStatus({ ...reg, limitDives: 150 }, n(100), T(2026, 6)).level, "ok", "a 150-dive limit: 100 dives is fine"); assert.equal(U.regulatorStatus({ ...reg, limitDives: 150 }, n(130), T(2026, 6)).level, "orange");
});

test("regulator messages: what is due, what is soon, how much is left", () => {
  const dive = (i) => ({ fingerprint: "m" + i, startedAt: `2026-05-01T${String(i % 24).padStart(2, "0")}:${String(Math.floor(i / 24)).padStart(2, "0")}:00`, durationSec: 3000, mode: "scuba" }), n = (k) => Array.from({ length: k }, (_, i) => dive(i));
  const reg = { baseline: 0, since: "", serviced: "2026-03", limitDives: 90, limitMonths: 12 }, msg = (r, k, today) => U.regulatorMessage(U.regulatorStatus(r, n(k), today), "en-US");
  assert.equal(msg(reg, 40, new Date(2026, 5, 15)), "Next service in 50 dives or 9 months"); assert.equal(msg(reg, 74, new Date(2026, 10, 15)), "Service soon: 16 dives to go"); assert.equal(msg(reg, 20, new Date(2027, 0, 15)), "Service soon: 2 months to go");
  assert.equal(msg(reg, 80, new Date(2027, 0, 15)), "Service soon: 10 dives or 2 months to go"); assert.equal(msg(reg, 89, new Date(2026, 5, 15)), "Service soon: 1 dive to go");
  assert.equal(msg(reg, 90, new Date(2026, 5, 15)), "Service now: 90 dives (limit 90)"); assert.equal(msg(reg, 20, new Date(2027, 2, 15)), "Service now: 12 months since Mar 2026 (limit 12)"); assert.equal(msg(reg, 95, new Date(2027, 3, 15)), "Service now: 95 dives (limit 90) and 13 months since Mar 2026 (limit 12)");
  assert.equal(msg({ ...reg, limitMonths: 0 }, 40, new Date(2026, 5, 15)), "Next service in 50 dives"); assert.equal(msg({ ...reg, limitDives: 0 }, 40, new Date(2026, 5, 15)), "Next service in 9 months");
  assert.equal(msg({ baseline: 0, since: "" }, 40, new Date(2026, 5, 15)), "Next service in 50 dives", "no service month yet: only the dive reminder");
  assert.equal(msg({ baseline: 0, since: "", limitDives: 0 }, 40, new Date(2026, 5, 15)), "Add the last service date to get a time reminder", "time reminder only, but no service month");
  assert.equal(U.monthLabel("2026-03", "en-US"), "Mar 2026");
});

test("regulator reset: counter back to 0, the service month recorded, history kept (newest first, at most 20)", () => {
  const dive = (i) => ({ fingerprint: "r" + i, startedAt: `2026-05-${String(1 + i).padStart(2, "0")}T09:00:00`, durationSec: 3000, mode: "scuba" }), recs = Array.from({ length: 12 }, (_, i) => dive(i));
  const reg = { name: "R", type: "", baseline: 70, since: "2026-04-01T00:00:00", serviced: "2025-03", limitDives: 90, limitMonths: 12, history: [{ m: "2025-03", dives: 88, at: "2025-03-20" }] }, today = new Date(2026, 5, 3);
  const legacy = U.regulatorReset(reg, recs); assert.equal(legacy.baseline, 0); assert.equal(legacy.since, "2026-05-12T09:00:00"); assert.equal(legacy.serviced, "2025-03", "without a service month nothing else changes"); assert.deepEqual(legacy.history, reg.history);
  const r = U.regulatorReset(reg, recs, { serviced: "2026-05", today }); assert.deepEqual([r.baseline, r.since, r.serviced], [0, "2026-05-12T09:00:00", "2026-05"]);
  assert.deepEqual(r.history, [{ m: "2026-05", dives: 82, at: "2026-06-03" }, { m: "2025-03", dives: 88, at: "2025-03-20" }], "the dives it had done (70 + 12) go into the history, newest first"); assert.equal(reg.history.length, 1, "the old object is not changed");
  let h = reg; for (let i = 0; i < 25; i++) h = U.regulatorReset(h, recs, { serviced: "2026-05", today }); assert.equal(h.history.length, 20, "at most 20 services are kept");
  assert.equal(U.regulatorReset({ name: "N", type: "", baseline: 3, since: "" }, recs, { serviced: "2026-05", today }).history.length, 1, "a regulator without a history starts one");
  assert.equal(U.regulatorStatus(r, recs, new Date(2026, 5, 3)).months, 1); assert.equal(U.regulatorStatus(r, recs, new Date(2026, 5, 3)).dives, 0, "after the reset: 0 dives, 1 month since the service month");
});
