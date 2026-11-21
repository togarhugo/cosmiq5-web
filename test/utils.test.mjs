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
  assert.deepEqual(s.last, { date: "2026-10-17", startedAt: "2026-10-17T08:26:00", location: "Komodo", daysAgo: 35 });
  assert.deepEqual(U.summarize([], new Date()), { count: 0, totalSec: 0, last: null });
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
