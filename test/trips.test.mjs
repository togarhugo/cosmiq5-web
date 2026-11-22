import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import { call, makeEnv, googleSession, post } from "./harness.mjs";
const T = createRequire(import.meta.url)("../public/trip-utils.js");

const mk = (over = {}) => ({ id: "trip1", title: "Banggai", destination: "Luwuk", start: "2026-12-12", end: "2026-12-19", limits: { dive: 23, carry: 7, total: null }, groups: [{ id: "grp1", name: "Core", items: [{ id: "itm1", name: "BCD", kg: 3.2, bag: "dive", packed: true }, { id: "itm2", name: "Computer", kg: 0.2, bag: "carry", packed: false }] }], ...over });

test("countdown: days to go, then the day of the trip, then ended; trips without dates say so", () => {
  const s = (over, today) => T.status(mk(over), today);
  assert.deepEqual([s({}, "2026-11-19").kind, s({}, "2026-11-19").big, s({}, "2026-11-19").text], ["upcoming", "23", "days to go"]);
  assert.equal(s({}, "2026-12-11").text, "day to go"); assert.equal(s({}, "2026-12-11").big, "1");
  assert.deepEqual([s({}, "2026-12-12").kind, s({}, "2026-12-12").big], ["ongoing", "1"], "the first day is already day 1");
  assert.equal(s({}, "2026-12-14").big, "3"); assert.match(s({}, "2026-12-14").text, /^of 8/); assert.equal(s({}, "2026-12-19").kind, "ongoing", "the last day is still on the trip");
  assert.equal(s({}, "2026-12-20").text, "Ended yesterday"); assert.equal(s({}, "2026-12-24").text, "Ended 5 days ago");
  assert.equal(s({ start: "", end: "" }, "2026-12-14").kind, "undated"); assert.equal(s({ end: "" }, "2026-12-12").kind, "ongoing", "no end date = a one day trip"); assert.equal(s({ end: "" }, "2026-12-13").kind, "ended");
  assert.equal(T.daysBetween("2026-02-27", "2026-03-02"), 3, "across a month end"); assert.equal(T.daysBetween("2027-12-30", "2028-01-02"), 3, "across a year end");
});

test("baggage weights: each bag, both together, packed count; limits give ok / warn / over and what is left", () => {
  const t = T.totals(mk()); assert.deepEqual(t, { dive: 3.2, carry: 0.2, total: 3.4, packed: 1, count: 2 });
  const d = T.totals({ groups: [{ id: "g", name: "x", items: [0.1, 0.2, 0.3].map((kg, i) => ({ id: "i" + i, name: "n", kg, bag: "dive", packed: false })) }] }); assert.equal(d.dive, 0.6, "no floating point dust");
  assert.equal(T.level(10, 23), "ok"); assert.equal(T.level(20.7, 23), "warn", "90 % and above warns"); assert.equal(T.level(23, 23), "warn", "exactly at the limit is still allowed"); assert.equal(T.level(23.01, 23), "over"); assert.equal(T.level(50, null), "none"); assert.equal(T.level(5, 0), "none");
  assert.equal(T.left(19.4, 23), 3.6); assert.equal(T.left(24, 23), -1); assert.equal(T.left(5, null), null);
  const std = T.newTrip("abc123"); const sums = T.totals(std); assert.ok(sums.dive > 5 && sums.carry > 4, "the standard list has weights in both bags"); assert.deepEqual(std.limits, { dive: 23, carry: 7, total: null });
  const ids = std.groups.flatMap((g) => [g.id, ...g.items.map((i) => i.id)]); assert.equal(new Set(ids).size, ids.length, "every list and item has its own id"); assert.ok(ids.every((x) => /^[a-z0-9]{4,24}$/.test(x)));
});

test("which trip the Overview shows, and the order of the list", () => {
  const a = mk({ id: "a1", start: "2026-12-12", end: "2026-12-19" }), b = mk({ id: "b1", start: "2027-04-03", end: "2027-04-05" }), c = mk({ id: "c1", start: "2026-06-03", end: "2026-06-09" }), u = mk({ id: "u1", start: "", end: "" });
  assert.equal(T.nextTrip([b, a, c, u], "2026-11-19").id, "a1", "the soonest trip to start"); assert.equal(T.nextTrip([b, a, c, u], "2026-12-15").id, "a1", "a trip that is on now");
  assert.equal(T.nextTrip([b, a, c], "2026-12-20").id, "b1"); assert.equal(T.nextTrip([a, c, u], "2026-12-20"), null, "only past or undated trips: nothing to show"); assert.equal(T.nextTrip([], "2026-12-20"), null);
  const s = T.sections([c, b, u, a], "2026-11-19"); assert.deepEqual([s.upcoming.map((t) => t.id), s.past.map((t) => t.id), s.undated.map((t) => t.id)], [["a1", "b1"], ["c1"], ["u1"]]);
  assert.equal(T.range("2026-12-12", "2026-12-19"), "12 – 19 Dec 2026"); assert.equal(T.range("2026-12-28", "2027-01-03"), "28 Dec 2026 – 3 Jan 2027"); assert.equal(T.range("2026-12-12", ""), "12 Dec 2026"); assert.equal(T.range("", ""), "");
});

test("trips API: saved, listed, updated, deleted; private to each user; cleaned and validated; limited in number and size", async () => {
  const env = makeEnv(); const { cookie: me } = await googleSession(env); const { cookie: other } = await googleSession(env, { email: "other@example.com" });
  const put = (cookie, id, body, extra = {}) => call(env, "/api/trips/" + id, { method: "PUT", headers: { cookie, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const list = async (cookie) => (await call(env, "/api/trips", { headers: { cookie } })).json();
  assert.equal((await call(env, "/api/trips")).status, 401, "signed out"); assert.equal((await call(env, "/api/trips/abcd1234", { method: "PUT", body: "{}" })).status, 401);
  assert.deepEqual((await list(me)).trips, []);
  const r = await put(me, "abcd1234", mk({ id: "ignored", title: "  Banggai   Dive  ", groups: [{ id: "grp1", name: "Core", items: [{ id: "itm1", name: "BCD", kg: "3.456", bag: "dive", packed: 1 }] }] })); assert.equal(r.status, 200);
  const saved = (await r.json()).trip; assert.equal(saved.id, "abcd1234", "the id comes from the address"); assert.equal(saved.title, "Banggai Dive", "spaces tidied"); assert.equal(saved.groups[0].items[0].kg, 3.46, "two decimals"); assert.equal(saved.groups[0].items[0].packed, false, "only true counts as packed");
  const got = (await list(me)).trips; assert.equal(got.length, 1); assert.equal(got[0].title, "Banggai Dive"); assert.deepEqual(got[0].limits, { dive: 23, carry: 7, total: null });
  assert.equal((await put(me, "abcd1234", mk({ title: "Renamed", limits: { dive: 20, carry: 8, total: 28 } }))).status, 200); const again = (await list(me)).trips; assert.equal(again.length, 1, "an update, not a second trip"); assert.deepEqual([again[0].title, again[0].limits.total], ["Renamed", 28]);
  assert.deepEqual((await list(other)).trips, [], "nobody else sees it"); assert.equal((await call(env, "/api/trips/abcd1234", { method: "DELETE", headers: { cookie: other } })).status, 200); assert.equal((await list(me)).trips.length, 1, "another person's delete does nothing");
  for (const [name, body] of [["no title", mk({ title: " " })], ["bad date", mk({ start: "2026-13-40" })], ["ends before it starts", mk({ end: "2026-12-01" })], ["weight too big", mk({ limits: { dive: 999 } })], ["negative item", mk({ groups: [{ id: "grp1", name: "x", items: [{ id: "itm1", name: "a", kg: -1, bag: "dive" }] }] })], ["bad bag", mk({ groups: [{ id: "grp1", name: "x", items: [{ id: "itm1", name: "a", kg: 1, bag: "hold" }] }] })], ["nameless item", mk({ groups: [{ id: "grp1", name: "x", items: [{ id: "itm1", name: "", kg: 1, bag: "dive" }] }] })], ["duplicate ids", mk({ groups: [{ id: "grp1", name: "x", items: [{ id: "grp1", name: "a", kg: 1, bag: "dive" }] }] })], ["not an object", "[]"], ["not json", "nope"]])
    assert.equal((await put(me, "abcd1234", body)).status, 400, name);
  assert.equal((await put(me, "abcd1234", mk(), { origin: "https://evil.example" })).status, 403, "cross-origin writes are refused"); assert.equal((await put(me, "no", mk())).status, 404, "a bad id is not a trip address");
  assert.equal((await list(me)).trips[0].title, "Renamed", "nothing invalid was stored");
  const items = Array.from({ length: 130 }, (_, i) => ({ id: "item" + i + "xx", name: "a", kg: 0.1, bag: "dive" })); assert.equal((await put(me, "abcd1234", mk({ groups: [{ id: "grp1", name: "x", items }] }))).status, 400, "too many items");
  for (let i = 0; i < 59; i++) assert.equal((await put(me, "trip" + String(i).padStart(4, "0"), mk({ title: "T" + i }))).status, 200);
  assert.equal((await put(me, "trip9999", mk())).status, 400, "60 trips at most"); assert.equal((await put(me, "abcd1234", mk({ title: "Still editable" }))).status, 200, "an existing trip can still be saved");
  assert.equal((await (await call(env, "/api/trips/abcd1234", { method: "DELETE", headers: { cookie: me } })).json()).deleted, 1); assert.equal((await list(me)).trips.length, 59);
});
