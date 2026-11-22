import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { call, googleSession, makeEnv } from "./harness.mjs";
import { pnfDive } from "./peregrine-sim.mjs";
const P = createRequire(import.meta.url)("../public/dive-protocol.js");

// ---------- helpers ----------
const sess = async (env, email = "me@example.com") => (await googleSession(env, { email })).cookie;
const send = (env, cookie, method, path, body, h = {}) => call(env, path, { method, headers: { cookie, "content-type": "application/json", ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
const create = async (env, cookie, description = "Home dashboard", days = 30) => { const r = await send(env, cookie, "POST", "/api/keys", { description, days }); return { status: r.status, ...(await r.json()) }; };
const get = (env, key, path, h = {}) => call(env, path, { headers: { authorization: "Bearer " + key, ...h } });
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
/** A valid Cosmiq+ dive: 36-byte header + matching 4-byte samples (temperature in 0.1 C, pressure in mbar). */
function cosmiq({ y = 2025, mo = 3, d = 14, h = 9, mi = 30, dur = 42, mode = 2, o2 = 32, number = 7, n = 40, minT = 270, maxRaw = 1013 + 1800, page = 0 } = {}) {
  const b = new Array(36).fill(0); b[0] = number; b[2] = mode; b[3] = o2; b[4] = 0xf5; b[5] = 0xa3; b[6] = y & 255; b[7] = y >> 8; b[8] = d; b[9] = mo; b[10] = mi; b[11] = h; b[12] = dur & 255; b[13] = dur >> 8;
  b[22] = maxRaw & 255; b[23] = maxRaw >> 8; b[24] = minT & 255; b[25] = minT >> 8; b[26] = 10; b[28] = n & 255; b[29] = n >> 8; b[30] = page & 255; b[31] = page >> 8; b[32] = (page + 1) & 255; b[33] = (page + 1) >> 8;
  const prof = []; for (let i = 0; i < n; i++) { const t = minT + (i % 5), depth = 1013 + Math.round((maxRaw - 1013) * Math.sin((n > 1 ? i / (n - 1) : 0.5) * Math.PI)); prof.push(t & 255, t >> 8, depth & 255, depth >> 8); }
  const hex = (a) => a.map((x) => x.toString(16).padStart(2, "0")).join("");
  return { fingerprint: hex(b.slice(6, 12)), headerHex: hex(b), profileHex: hex(prof), startedAt: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00`, mode: { 2: "scuba", 3: "gauge", 4: "freedive" }[mode], dur: mode === 4 ? dur : dur * 60 };
}
const putCosmiq = (env, email, c, extra = {}) => env.DB.prepare("INSERT INTO dives (user_email, fingerprint, started_at, mode, duration_sec, max_depth_m, o2_percent, header_hex, profile_hex, location, device, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'cosmiq',?)")
  .bind(email, c.fingerprint, c.startedAt, c.mode, c.dur, 18.1, c.mode === "scuba" ? 32 : null, extra.headerHex || c.headerHex, extra.profileHex ?? c.profileHex, extra.location ?? null, extra.createdAt || "2025-04-01 10:00:00").run();
const putPere = (env, email, o) => env.DB.prepare("INSERT INTO dives (user_email, fingerprint, started_at, mode, duration_sec, max_depth_m, o2_percent, header_hex, profile_hex, location, device, extra, created_at) VALUES (?,?,?,?,?,?,?,'','',?,'peregrine',?,?)")
  .bind(email, o.id, o.startedAt, o.mode || "scuba", o.dur || 3000, o.depth || 25.5, o.mode === "freedive" ? null : 32, o.location ?? null, JSON.stringify({ n: o.n ?? 41, t: 27.5, iv: 10, s: [[10, 0, 29], [20, 12.4, 28], [30, 25.5, 27.5]] }), o.createdAt || "2025-04-02 10:00:00").run();
const id12 = (n) => (0xabc000000000 + n).toString(16).padStart(12, "0");

// ---------- key management ----------
test("keys: made once, shown once, stored only as a hash; description and lifetime validated", async () => {
  const env = makeEnv(), cookie = await sess(env);
  assert.equal((await call(env, "/api/keys")).status, 401, "signed-out");
  for (const [name, body] of [["no description", { days: 7 }], ["blank", { description: "   ", days: 7 }], ["too long", { description: "x".repeat(61), days: 7 }], ["not text", { description: 5, days: 7 }], ["no lifetime", { description: "a" }],
    ["1 day", { description: "a", days: 1 }], ["365 days", { description: "a", days: 365 }], ["text days", { description: "a", days: "7" }], ["negative", { description: "a", days: -1 }], ["null", { description: "a", days: null }]])
    assert.equal((await send(env, cookie, "POST", "/api/keys", body)).status, 400, name);
  assert.equal((await send(env, cookie, "POST", "/api/keys", { description: "x", days: 7 }, { origin: "https://evil.example" })).status, 403, "cross-origin");
  const k = await create(env, cookie, "  Home   dashboard ", 14);
  assert.equal(k.status, 200); assert.match(k.key, /^dm_[A-Za-z0-9_-]{43}$/, "256 random bits"); assert.equal(k.item.description, "Home dashboard"); assert.equal(k.item.status, "active"); assert.equal(k.item.lifetimeDays, 14); assert.equal(k.item.prefix, k.key.slice(0, 10));
  const row = env.DB.raw.prepare("SELECT * FROM api_keys").get(); assert.equal(row.key_hash, sha(k.key), "only the SHA-256 is stored"); assert.ok(!Object.values(row).some((v) => String(v).includes(k.key)), "the key itself is nowhere in the database");
  const list = await (await send(env, cookie, "GET", "/api/keys")).json(); assert.equal(list.keys.length, 1); assert.equal(list.max, 10); assert.ok(!JSON.stringify(list).includes(k.key) && !JSON.stringify(list).includes(row.key_hash), "the list never shows the key or its hash");
  assert.match(list.keys[0].expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/); const days = (Date.parse(list.keys[0].expiresAt) - Date.now()) / 86400000; assert.ok(days > 13.9 && days < 14.1, "14 days: " + days);
  for (const [d, expect] of [[7, 7], [30, 30], [0, null]]) { const x = await create(env, cookie, "k" + d, d); const it = x.item; if (expect === null) assert.equal(it.expiresAt, null, "unlimited"); else assert.ok(Math.abs((Date.parse(it.expiresAt) - Date.now()) / 86400000 - expect) < 0.1, d + " days"); assert.equal(it.lifetimeDays, expect); }
  assert.notEqual((await create(env, cookie, "two", 7)).key, k.key, "every key is different");
});

test("keys: at most 10 active; revoked and expired ones do not count", async () => {
  const env = makeEnv(), cookie = await sess(env); const made = [];
  for (let i = 0; i < 10; i++) made.push(await create(env, cookie, "k" + i, 30));
  const r = await send(env, cookie, "POST", "/api/keys", { description: "eleven", days: 30 }); assert.equal(r.status, 409); assert.match((await r.json()).error, /10 active keys/);
  await send(env, cookie, "POST", `/api/keys/${made[0].item.id}/revoke`); assert.equal((await create(env, cookie, "after revoke", 30)).status, 200, "a revoked key frees a place");
  env.DB.raw.prepare("UPDATE api_keys SET expires_at = datetime('now', '-1 hour') WHERE id = ?").run(made[1].item.id); assert.equal((await create(env, cookie, "after expiry", 30)).status, 200, "an expired key frees a place");
  assert.equal((await send(env, cookie, "POST", "/api/keys", { description: "again", days: 30 })).status, 409);
});

test("keys: revoke, rotate and delete; private to each user; the old key stops working at once", async () => {
  const env = makeEnv(), me = await sess(env), other = await sess(env, "other@example.com");
  const a = await create(env, me, "Dashboard", 30), b = await create(env, me, "Script", 0);
  assert.equal((await get(env, a.key, "/api/v1/ping")).status, 200);
  // another user can neither see, rotate, revoke nor delete my key (it looks like a missing one)
  assert.deepEqual((await (await send(env, other, "GET", "/api/keys")).json()).keys, []);
  for (const [m, p] of [["POST", `/api/keys/${a.item.id}/rotate`], ["POST", `/api/keys/${a.item.id}/revoke`], ["DELETE", `/api/keys/${a.item.id}`]]) assert.equal((await send(env, other, m, p)).status, 404, m + " " + p);
  assert.equal((await get(env, a.key, "/api/v1/ping")).status, 200, "still fine after the attempts");
  // rotate: a new key, same description and lifetime; the old one is dead immediately
  const rot = await (await send(env, me, "POST", `/api/keys/${a.item.id}/rotate`)).json();
  assert.notEqual(rot.key, a.key); assert.equal(rot.item.description, "Dashboard"); assert.equal(rot.item.lifetimeDays, 30); assert.equal(rot.item.rotatedFrom, a.item.id); assert.equal(rot.item.status, "active");
  assert.equal((await get(env, a.key, "/api/v1/ping")).status, 401, "the old key no longer works"); assert.equal((await (await get(env, a.key, "/api/v1/ping")).json()).error, "key_revoked"); assert.equal((await get(env, rot.key, "/api/v1/ping")).status, 200);
  const list = (await (await send(env, me, "GET", "/api/keys")).json()).keys; assert.equal(list.find((k) => k.id === a.item.id).status, "revoked"); assert.equal(list.length, 3, "the old key stays listed as revoked");
  assert.equal((await send(env, me, "POST", `/api/keys/${a.item.id}/rotate`)).status, 409, "a revoked key cannot be rotated");
  // an unlimited key stays unlimited when rotated; an expired key can be rotated back to life
  assert.equal((await (await send(env, me, "POST", `/api/keys/${b.item.id}/rotate`)).json()).item.expiresAt, null);
  const c = await create(env, me, "Short", 7); env.DB.raw.prepare("UPDATE api_keys SET expires_at = datetime('now', '-1 day') WHERE id = ?").run(c.item.id); assert.equal((await get(env, c.key, "/api/v1/ping")).status, 401);
  const rc = await (await send(env, me, "POST", `/api/keys/${c.item.id}/rotate`)).json(); assert.equal((await get(env, rc.key, "/api/v1/ping")).status, 200, "rotating an expired key gives a working one"); assert.ok(Math.abs((Date.parse(rc.item.expiresAt) - Date.now()) / 86400000 - 7) < 0.1, "with a fresh 7 days");
  // revoke and delete
  assert.deepEqual(await (await send(env, me, "POST", `/api/keys/${rc.item.id}/revoke`)).json(), { ok: true }); assert.equal((await get(env, rc.key, "/api/v1/ping")).status, 401); assert.equal((await send(env, me, "POST", `/api/keys/${rc.item.id}/revoke`)).status, 200, "revoking twice is fine");
  assert.equal((await send(env, me, "DELETE", `/api/keys/${rot.item.id}`)).status, 200); assert.equal((await get(env, rot.key, "/api/v1/ping")).status, 401, "deleting an active key also ends it");
  assert.equal((await send(env, me, "DELETE", `/api/keys/${rot.item.id}`)).status, 404); assert.equal((await send(env, me, "GET", "/api/keys/zzzz")).status, 404); assert.equal((await send(env, me, "PUT", `/api/keys/${b.item.id}`)).status, 405);
});

// ---------- the read-only API: authentication ----------
test("api v1: needs a valid, unexpired, unrevoked key of a user who is still allowed; a session cookie is not enough", async () => {
  const env = makeEnv(), me = await sess(env), k = await create(env, me, "t", 30);
  const err = async (res, status, code) => { assert.equal(res.status, status); const b = await res.json(); assert.equal(b.error, code); assert.ok(b.message, "says what to do"); assert.ok(!res.headers.getSetCookie().length, "never sets a cookie"); };
  await err(await call(env, "/api/v1/ping"), 401, "missing_key"); await err(await call(env, "/api/v1/ping", { headers: { cookie: me } }), 401, "missing_key");           // the signed-in cookie does not open the API
  for (const bad of ["Bearer", "Bearer abc", "Bearer dm_" + "A".repeat(42), "Bearer dm_" + "A".repeat(44), "Basic " + k.key, "dm_" + "x".repeat(43), "Bearer dm_" + "é".repeat(43)])
    await err(await call(env, "/api/v1/ping", { headers: { authorization: bad } }), 401, /^Bearer dm_[A-Za-z0-9_-]{43}$/.test(bad) ? "invalid_key" : bad.startsWith("Bearer") && bad.length > 7 ? "invalid_key" : "missing_key");
  await err(await get(env, "dm_" + "A".repeat(43), "/api/v1/ping"), 401, "invalid_key");
  const ok = await get(env, k.key, "/api/v1/ping"); assert.equal(ok.status, 200); const body = await ok.json(); assert.deepEqual([body.ok, body.apiVersion, body.key.description], [true, "1", "t"]);
  assert.equal((await call(env, "/api/v1/ping", { headers: { "x-api-key": k.key } })).status, 200, "X-API-Key works too"); assert.equal((await call(env, "/api/v1/ping?key=" + k.key)).status, 401, "a key in the address is refused (it would end up in logs)");
  assert.equal((await call(env, "/api/v1/ping", { headers: { authorization: "bearer   " + k.key + "  " } })).status, 200, "scheme is case-insensitive");
  env.DB.raw.prepare("UPDATE api_keys SET expires_at = datetime('now', '-1 second')").run(); await err(await get(env, k.key, "/api/v1/ping"), 401, "key_expired");
  env.DB.raw.prepare("UPDATE api_keys SET expires_at = NULL").run(); assert.equal((await get(env, k.key, "/api/v1/ping")).status, 200, "unlimited never expires");
  const removed = await call({ ...env, ALLOWED_EMAILS: "someone@else.com" }, "/api/v1/ping", { headers: { authorization: "Bearer " + k.key } }); await err(removed, 401, "invalid_key");          // the owner was taken off the allow-list: all their keys stop
  assert.equal((await get(env, k.key, "/api/keys")).status, 401, "a key cannot manage keys");
  assert.equal((await get(env, k.key, "/api/dives")).status, 401, "a key cannot use the app's own endpoints"); assert.equal((await get(env, k.key, "/api/account")).status, 401);
});

test("api v1: read-only, CORS for header-authenticated calls, no HTML or cookies", async () => {
  const env = makeEnv(), me = await sess(env), k = await create(env, me, "t", 30);
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) { const r = await call(env, "/api/v1/dives", { method: m, headers: { authorization: "Bearer " + k.key, "content-type": "application/json", origin: "https://tool.example" }, body: "{}" }); assert.equal(r.status, 405, m); assert.equal((await r.json()).error, "method_not_allowed"); }
  const pre = await call(env, "/api/v1/dives", { method: "OPTIONS", headers: { origin: "https://tool.example", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } }); assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*"); assert.match(pre.headers.get("access-control-allow-headers"), /authorization/); assert.equal(pre.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  for (const res of [await get(env, k.key, "/api/v1/ping", { origin: "https://tool.example" }), await call(env, "/api/v1/ping"), await get(env, k.key, "/api/v1/nope")]) { assert.equal(res.headers.get("access-control-allow-origin"), "*"); assert.equal(res.headers.get("cache-control"), "no-store"); assert.match(res.headers.get("content-type"), /application\/json/); assert.deepEqual(res.headers.getSetCookie(), []); }
  assert.equal((await get(env, k.key, "/api/v1/nope")).status, 404); assert.equal((await get(env, k.key, "/api/v1/ping/")).status, 200, "trailing slash");
});

// ---------- the read-only API: data ----------
async function seeded() {
  const env = makeEnv(), me = await sess(env), other = await sess(env, "other@example.com"), k = await create(env, me, "t", 30), ko = await create(env, other, "o", 30);
  const c1 = cosmiq({ d: 14, number: 7 }), c2 = cosmiq({ d: 15, h: 8, mi: 5, dur: 1, mode: 4, n: 1, minT: 260, maxRaw: 1013 + 1500, number: 8 }), c3 = cosmiq({ d: 16, mode: 3, number: 9, o2: 0 });
  await putCosmiq(env, "me@example.com", c1, { location: "Tulamben", createdAt: "2025-04-01 10:00:00" }); await putCosmiq(env, "me@example.com", c2, { createdAt: "2025-04-01 10:00:01" }); await putCosmiq(env, "me@example.com", c3, { location: "Komodo", createdAt: "2025-05-01 12:00:00" });
  await putPere(env, "me@example.com", { id: id12(1), startedAt: "2025-03-14T09:33:00", location: "tulamben", n: 41, createdAt: "2025-06-01 08:00:00" }); await putPere(env, "me@example.com", { id: id12(2), startedAt: "2025-03-20T10:00:00", mode: "freedive", dur: 75, depth: 12.1, location: "Bunaken", createdAt: "2025-06-01 08:00:01" });
  await putPere(env, "other@example.com", { id: id12(9), startedAt: "2025-03-14T09:00:00", location: "Secret reef" }); await putCosmiq(env, "other@example.com", cosmiq({ d: 1 }));
  for (const [n, lat, lon] of [["Tulamben", -8.29, 115.59], ["Komodo", -8.55, 119.49]]) await env.DB.prepare("INSERT INTO places (user_email, k, name, lat, lon) VALUES (?,?,?,?,?)").bind("me@example.com", n.toLowerCase(), n, lat, lon).run();
  await env.DB.prepare("INSERT INTO places (user_email, k, name, lat, lon) VALUES (?,?,?,?,?)").bind("other@example.com", "secret reef", "Secret reef", 1, 2).run();
  return { env, me, other, k: k.key, ko: ko.key, c1, c2, c3 };
}
const list = async (env, key, qs = "") => { const r = await get(env, key, "/api/v1/dives" + qs); return { status: r.status, ...(await r.json()) }; };

test("api v1: dives list: both computers, decoded fields, kind, map position, only the key owner's dives", async () => {
  const { env, k, ko, c1 } = await seeded(); const r = await list(env, k);
  assert.equal(r.status, 200); assert.equal(r.count, 5); assert.equal(r.nextCursor, null); assert.deepEqual(r.dives.map((d) => d.startedAt), ["2025-03-20T10:00:00", "2025-03-16T09:30:00", "2025-03-15T08:05:00", "2025-03-14T09:33:00", "2025-03-14T09:30:00"], "newest first");
  const by = (id) => r.dives.find((d) => d.id === id);
  assert.deepEqual(by(c1.fingerprint), { id: c1.fingerprint, device: "cosmiq", kind: "scuba", mode: "scuba", startedAt: "2025-03-14T09:30:00", durationSec: 2520, maxDepthM: 18.1, minTempC: 27, o2Percent: 32, diveNumber: 7, location: "Tulamben", position: { lat: -8.29, lon: 115.59 }, uploadedAt: "2025-04-01T10:00:00Z" }, "Cosmiq+: number and minimum temperature come from the header");
  assert.deepEqual(by(id12(1)), { id: id12(1), device: "peregrine", kind: "scuba", mode: "scuba", startedAt: "2025-03-14T09:33:00", durationSec: 3000, maxDepthM: 25.5, minTempC: 27.5, o2Percent: 32, diveNumber: 41, location: "tulamben", position: { lat: -8.29, lon: 115.59 }, uploadedAt: "2025-06-01T08:00:00Z" }, "Peregrine: from the stored values; the position matches in any capitalisation");
  assert.equal(by(id12(2)).kind, "freedive"); assert.equal(by(id12(2)).position, null, "a place not on the map has no position"); assert.equal(r.dives.find((d) => d.mode === "gauge").kind, "scuba", "gauge counts as scuba");
  assert.ok(r.dives.every((d) => !("samples" in d) && !("raw" in d) && !("headerHex" in d)), "no samples or raw bytes unless asked for"); assert.ok(!r.dives.some((d) => /secret/i.test(JSON.stringify(d))), "only my dives");
  const o = await list(env, ko); assert.equal(o.count, 2); assert.ok(o.dives.every((d) => d.id !== c1.fingerprint)); assert.deepEqual(o.dives.find((d) => d.device === "peregrine").position, { lat: 1, lon: 2 }, "each user sees only the positions of their own places");
});

test("api v1: dives list: filters, order, pagination (cursor walks every dive exactly once), validation", async () => {
  const { env, k } = await seeded();
  assert.deepEqual((await list(env, k, "?device=peregrine")).dives.map((d) => d.id), [id12(2), id12(1)]); assert.equal((await list(env, k, "?device=cosmiq")).count, 3); assert.equal((await list(env, k, "?device=garmin")).count, 0, "garmin is a valid filter, there are none yet"); assert.equal((await call(env, "/api/v1/dives?device=suunto", { headers: { authorization: "Bearer " + k } })).status, 400);
  assert.deepEqual((await list(env, k, "?kind=freedive")).dives.map((d) => d.mode), ["freedive", "freedive"], "freedives from both computers"); assert.equal((await list(env, k, "?kind=scuba")).count, 3, "scuba includes gauge");
  assert.deepEqual((await list(env, k, "?from=2025-03-15&to=2025-03-16")).dives.map((d) => d.startedAt.slice(0, 10)), ["2025-03-16", "2025-03-15"], "from and to are whole days, both included"); assert.equal((await list(env, k, "?from=2025-03-21")).count, 0);
  assert.deepEqual((await list(env, k, "?location=TULAMBEN")).dives.map((d) => d.location).sort(), ["Tulamben", "tulamben"], "location: any capitalisation"); assert.equal((await list(env, k, "?location=" + encodeURIComponent("' OR 1=1 --"))).count, 0, "quotes are just text");
  assert.deepEqual((await list(env, k, "?uploadedSince=2025-05-01")).dives.map((d) => d.id).length, 3, "uploaded since: the Komodo dive and the two Peregrine dives"); assert.equal((await list(env, k, "?uploadedSince=2025-06-01T08:00:01Z")).count, 1);
  assert.deepEqual((await list(env, k, "?order=asc")).dives.map((d) => d.startedAt)[0], "2025-03-14T09:30:00");
  // pagination, both directions, page sizes 1 and 2
  for (const order of ["desc", "asc"]) for (const size of [1, 2, 4]) {
    const seen = []; let cursor = null, pages = 0;
    do { const r = await list(env, k, `?limit=${size}&order=${order}` + (cursor ? "&cursor=" + cursor : "")); assert.equal(r.status, 200); assert.ok(r.count <= size); seen.push(...r.dives.map((d) => d.id)); cursor = r.nextCursor; pages++; assert.ok(pages < 10, "ends"); } while (cursor);
    assert.equal(seen.length, 5, `${order}/${size}: every dive`); assert.equal(new Set(seen).size, 5, `${order}/${size}: no dive twice`); const all = (await list(env, k, `?order=${order}`)).dives.map((d) => d.id); assert.deepEqual(seen, all, `${order}/${size}: same order as one big page`);
  }
  // two dives with the same start time still page correctly (ties are broken by id)
  await putPere(env, "me@example.com", { id: id12(3), startedAt: "2025-03-20T10:00:00" }); const tie = []; let c = null; do { const r = await list(env, k, "?limit=1" + (c ? "&cursor=" + c : "")); tie.push(...r.dives.map((d) => d.id)); c = r.nextCursor; } while (c); assert.equal(tie.length, 6); assert.equal(new Set(tie).size, 6, "ties: nothing skipped or repeated");
  for (const qs of ["?limit=0", "?limit=501", "?limit=abc", "?limit=1.5", "?device=x", "?kind=x", "?from=2025-13-01", "?from=yesterday", "?to=2025-02-30x", "?order=up", "?cursor=garbage", "?cursor=" + Buffer.from("x|y").toString("base64url"), "?uploadedSince=soon", "?include=everything", "?location=" + "x".repeat(61)])
    { const r = await list(env, k, qs); assert.equal(r.status, 400, qs); assert.equal(r.error, "bad_request"); assert.ok(r.message); }
  assert.equal((await list(env, k, "?limit=500")).status, 200); assert.equal((await list(env, k, "?limit=11&include=samples")).status, 400, "with samples a page is at most 10 dives"); assert.equal((await list(env, k, "?limit=10&include=samples")).status, 200);
});

test("api v1: one dive with its depth samples (Cosmiq+ only when the profile really belongs to it), raw bytes on request", async () => {
  const { env, k, c1, c2 } = await seeded();
  const d = await (await get(env, k, "/api/v1/dives/" + c1.fingerprint)).json(); assert.equal(d.profileStatus, "complete"); assert.equal(d.samples.length, 40); assert.deepEqual(Object.keys(d.samples[0]), ["t", "depthM", "tempC"]); assert.equal(d.samples[0].t, 10);
  assert.ok(Math.abs(Math.max(...d.samples.map((s) => s.depthM)) - 17.5) < 1, "depth in metres, seawater"); assert.ok(d.samples.every((s) => s.tempC >= 26.9 && s.tempC <= 27.5)); assert.ok(!("raw" in d));
  const raw = await (await get(env, k, "/api/v1/dives/" + c1.fingerprint + "?include=raw")).json(); assert.deepEqual(raw.raw, { headerHex: c1.headerHex, profileHex: c1.profileHex }); assert.equal(raw.samples.length, 40);
  // a profile that belongs to another dive is NOT shown as this dive's
  const wrong = cosmiq({ d: 17, n: 40, maxRaw: 1013 + 3000 }); await putCosmiq(env, "me@example.com", cosmiq({ d: 18 }), { profileHex: wrong.profileHex }); const bad = await (await get(env, k, "/api/v1/dives/" + cosmiq({ d: 18 }).fingerprint)).json();
  assert.equal(bad.profileStatus, "unavailable"); assert.equal(bad.samples, null, "never another dive's depths"); assert.equal(bad.durationSec, 2520, "the summary is still there");
  // a profile cut short is shown as partial; an empty one is unavailable
  const part = cosmiq({ d: 19 }); await putCosmiq(env, "me@example.com", part, { profileHex: part.profileHex.slice(0, 4 * 2 * 30) }); const p = await (await get(env, k, "/api/v1/dives/" + part.fingerprint)).json(); assert.equal(p.profileStatus, "partial"); assert.equal(p.samples.length, 30);
  const none = cosmiq({ d: 20 }); await putCosmiq(env, "me@example.com", none, { profileHex: "" }); assert.equal((await (await get(env, k, "/api/v1/dives/" + none.fingerprint)).json()).profileStatus, "unavailable");
  const pere = await (await get(env, k, "/api/v1/dives/" + id12(1))).json(); assert.equal(pere.profileStatus, "complete"); assert.equal(pere.sampleIntervalSec, 10); assert.deepEqual(pere.samples, [{ t: 10, depthM: 0, tempC: 29 }, { t: 20, depthM: 12.4, tempC: 28 }, { t: 30, depthM: 25.5, tempC: 27.5 }]); assert.ok(!("raw" in pere));
  assert.equal((await get(env, k, "/api/v1/dives/" + id12(9))).status, 404, "another user's dive"); for (const bad of ["zzzz", "ABCDEF123456", id12(77), "../x", "1".repeat(13)]) assert.equal((await get(env, k, "/api/v1/dives/" + bad)).status, 404, bad);
  // include=samples on a list: decoded, limited to 10, same rules
  const withS = await list(env, k, "?include=samples&limit=10"); const c1s = withS.dives.find((x) => x.id === c1.fingerprint); assert.equal(c1s.samples.length, 40); assert.equal(withS.dives.find((x) => x.id === c2.fingerprint).profileStatus, "complete", "a one-sample freedive");
});

test("api v1: summary, and last_used is recorded at most once an hour", async () => {
  const { env, k, me } = await seeded(); const s = await (await get(env, k, "/api/v1/summary")).json();
  assert.deepEqual(s.total, { dives: 5, seconds: 5040 + 1 + 3000 + 75 }, "totals");
  assert.deepEqual(s.byDevice.cosmiq, { scuba: { dives: 2, seconds: 5040 }, freedive: { dives: 1, seconds: 1 } }); assert.deepEqual(s.byDevice.peregrine, { scuba: { dives: 1, seconds: 3000 }, freedive: { dives: 1, seconds: 75 } }); assert.equal(s.lastDiveAt, "2025-03-20T10:00:00"); assert.match(s.note, /counted once per computer/);
  const row = () => env.DB.raw.prepare("SELECT last_used_at AS t FROM api_keys WHERE user_email = 'me@example.com'").get().t;
  assert.ok(row(), "set by the calls above"); env.DB.raw.prepare("UPDATE api_keys SET last_used_at = '2000-01-01 00:00:00'").run(); await get(env, k, "/api/v1/ping"); const t1 = row(); assert.ok(t1 > "2020", "an old value is refreshed");
  await get(env, k, "/api/v1/ping"); await get(env, k, "/api/v1/ping"); assert.equal(row(), t1, "calls within the hour do not write again");
  const listed = (await (await send(env, me, "GET", "/api/keys")).json()).keys[0]; assert.match(listed.lastUsedAt, /Z$/);
});
