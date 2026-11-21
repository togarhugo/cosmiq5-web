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
