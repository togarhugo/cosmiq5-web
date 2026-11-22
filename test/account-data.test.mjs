import test from "node:test";
import assert from "node:assert/strict";
import { call, googleSession, makeEnv, post } from "./harness.mjs";

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1], PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const WEBP = [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50], PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3];
const pad = (head, n) => [...head, ...new Array(Math.max(0, n - head.length)).fill(65)];
const send = (env, cookie, method, path, body, h = {}) => call(env, path, { method, headers: { cookie, "content-type": "application/json", ...h }, body: body === undefined ? undefined : JSON.stringify(body) });
async function two() { const env = makeEnv(); return { env, me: (await googleSession(env)).cookie, other: (await googleSession(env, { email: "other@example.com" })).cookie }; }

test("everything in the account area needs a signed-in user", async () => {
  const env = makeEnv();
  for (const [m, p] of [["GET", "/api/profile"], ["PUT", "/api/profile/avatar"], ["PUT", "/api/profile/name"], ["PUT", "/api/profile/dan"], ["PUT", "/api/profile/latest-cert"], ["DELETE", "/api/profile/dan"], ["DELETE", "/api/profile/avatar"], ["GET", "/api/regulator"], ["PUT", "/api/regulator"], ["GET", "/api/certs"], ["POST", "/api/certs"], ["GET", "/api/certs/0123456789abcdef"], ["DELETE", "/api/certs/0123456789abcdef"]])
    assert.equal((await call(env, p, { method: m, body: m === "GET" ? undefined : "{}" })).status, 401, m + " " + p);
});

test("profile picture: only small JPEGs; replace, read back, remove; private per user", async () => {
  const { env, me, other } = await two(); const url = "data:image/jpeg;base64,";
  assert.deepEqual(await (await send(env, me, "GET", "/api/profile")).json(), { avatar: null, fullName: "", latestCertId: "", dan: { number: "", plan: "", validUntil: "" } });
  const good = url + b64(pad(JPEG, 3000));
  assert.equal((await send(env, me, "PUT", "/api/profile/avatar", { dataUrl: good })).status, 200);
  assert.equal((await (await send(env, me, "GET", "/api/profile")).json()).avatar, good);
  assert.equal((await (await send(env, other, "GET", "/api/profile")).json()).avatar, null, "not visible to another user");
  const again = url + b64(pad(JPEG, 3100)); await send(env, me, "PUT", "/api/profile/avatar", { dataUrl: again });
  assert.equal((await (await send(env, me, "GET", "/api/profile")).json()).avatar, again, "replaced");
  for (const [name, dataUrl] of [["png", "data:image/png;base64," + b64(pad(PNG, 100))], ["not a jpeg inside", url + b64(pad(PNG, 100))], ["svg", "data:image/svg+xml;base64," + b64("<svg onload=alert(1)>")],
    ["not base64", url + "!!!not base64!!!"], ["too big", url + b64(pad(JPEG, 120_000))], ["empty", url], ["number", 5], ["javascript", "javascript:alert(1)"], ["wrong prefix but a valid JPEG body", "data:image/png;base64,A" + b64(pad(JPEG, 100))], ["extra prefix text", "x" + url + b64(pad(JPEG, 100))]])
    assert.equal((await send(env, me, "PUT", "/api/profile/avatar", { dataUrl })).status, 400, name);
  assert.equal((await send(env, me, "PUT", "/api/profile/avatar", {})).status, 400);
  assert.equal((await send(env, me, "DELETE", "/api/profile/avatar")).status, 200);
  assert.equal((await (await send(env, me, "GET", "/api/profile")).json()).avatar, null);
  assert.equal((await send(env, me, "PUT", "/api/profile/avatar", { dataUrl: good }, { origin: "https://evil.example" })).status, 403, "cross-origin");
});

test("regulator: validated, stored per user, updatable, removable", async () => {
  const { env, me, other } = await two();
  assert.deepEqual(await (await send(env, me, "GET", "/api/regulator")).json(), { regulator: null });
  const reg = { name: "  Apeks   XTX50 ", type: "Balanced piston", baseline: 12, since: "2026-10-17T08:26:00" };
  assert.equal((await send(env, me, "PUT", "/api/regulator", reg)).status, 200);
  assert.deepEqual((await (await send(env, me, "GET", "/api/regulator")).json()).regulator, { name: "Apeks XTX50", type: "Balanced piston", baseline: 12, since: "2026-10-17T08:26:00", serviced: "", limitDives: 90, limitMonths: 12, history: [] }, "an older page that sends none of the new fields still works: 90 dives, 12 months, no service month");
  assert.equal((await (await send(env, other, "GET", "/api/regulator")).json()).regulator, null, "private");
  assert.equal((await send(env, me, "PUT", "/api/regulator", { ...reg, baseline: 0, since: "" })).status, 200, "reset = baseline 0 and a new 'since'");
  assert.equal((await (await send(env, me, "GET", "/api/regulator")).json()).regulator.baseline, 0);
  for (const [name, change] of [["no name", { name: "   " }], ["name too long", { name: "x".repeat(61) }], ["type too long", { type: "x".repeat(41) }], ["negative", { baseline: -1 }],
    ["fraction", { baseline: 1.5 }], ["huge", { baseline: 100000 }], ["string count", { baseline: "5" }], ["bad date", { since: "yesterday" }], ["date injection", { since: "2026-10-17T08:26:00'; DROP TABLE dives;--" }], ["name not a string", { name: 5 }]])
    assert.equal((await send(env, me, "PUT", "/api/regulator", { ...reg, ...change })).status, 400, name);
  assert.equal((await send(env, other, "DELETE", "/api/regulator")).status, 200); assert.ok((await (await send(env, me, "GET", "/api/regulator")).json()).regulator, "another user's delete does not touch mine");
  assert.equal((await send(env, me, "DELETE", "/api/regulator")).status, 200); assert.equal((await (await send(env, me, "GET", "/api/regulator")).json()).regulator, null);
});

test("certification files: allowed types checked by content, size and count limits, private per user", async () => {
  const { env, me, other } = await two();
  const upload = (over = {}, cookie = me) => send(env, cookie, "POST", "/api/certs", { label: "PADI Open Water", number: "1234567", filename: "card.pdf", mime: "application/pdf", data: b64(pad(PDF, 5000)), ...over });
  const r = await upload(); assert.equal(r.status, 200); const { id } = await r.json(); assert.match(id, /^[0-9a-f]{16}$/);
  for (const [mime, head] of [["image/jpeg", JPEG], ["image/png", PNG], ["image/webp", WEBP]]) assert.equal((await upload({ mime, filename: "f." + mime.slice(6), data: b64(pad(head, 400)) })).status, 200, mime);
  // list = metadata only; one = metadata + data
  const list = (await (await send(env, me, "GET", "/api/certs")).json()).certs;
  assert.equal(list.length, 4); assert.ok(list.every((c) => !("data" in c) && c.size > 0), "no file bytes in the list");
  const one = (await (await send(env, me, "GET", "/api/certs/" + id)).json()).cert;
  assert.equal(one.data, b64(pad(PDF, 5000))); assert.equal(one.label, "PADI Open Water"); assert.equal(one.number, "1234567"); assert.equal(one.size, 5000);
  // refusals
  for (const [name, over, status] of [["unknown type", { mime: "text/html", data: b64("<script>alert(1)</script>") }, 400], ["svg", { mime: "image/svg+xml", filename: "x.svg", data: b64("<svg/>") }, 400],
    ["png bytes claiming pdf", { data: b64(pad(PNG, 100)) }, 400], ["html pretending to be a pdf", { data: b64("<html><script>alert(1)</script></html>") }, 400], ["not base64", { data: "%%%" }, 400], ["empty data", { data: "" }, 400],
    ["no label", { label: "  " }, 400], ["label too long", { label: "x".repeat(81) }, 400], ["number too long", { number: "9".repeat(41) }, 400], ["no filename", { filename: "" }, 400],
    ["over 1 MB", { data: b64(pad(PDF, 1_000_001)) }, 413], ["label is a number", { label: 5 }, 400]])
    assert.equal((await upload(over)).status, status, name);
  assert.equal((await upload({ data: b64(pad(PDF, 1_000_000)) })).status, 200, "exactly the limit is fine");
  // sanitising
  const s = await upload({ label: "  A\u0000B\n C ", filename: "../../etc/pass\\wd.pdf" }); const sid = (await s.json()).id;
  const sc = (await (await send(env, me, "GET", "/api/certs/" + sid)).json()).cert; assert.equal(sc.label, "A B C"); assert.ok(!/[\\/]/.test(sc.filename), sc.filename);
  // privacy
  assert.equal((await send(env, other, "GET", "/api/certs/" + id)).status, 404); assert.deepEqual(await (await send(env, other, "GET", "/api/certs")).json(), { certs: [] });
  assert.deepEqual(await (await send(env, other, "DELETE", "/api/certs/" + id)).json(), { deleted: 0 }); assert.equal((await send(env, me, "GET", "/api/certs/" + id)).status, 200, "still there");
  assert.equal((await send(env, me, "GET", "/api/certs/..%2F..%2Fsecret")).status, 404, "bad ids never reach the database"); assert.equal((await send(env, me, "GET", "/api/certs/' OR '1'='1")).status, 404);
  assert.deepEqual(await (await send(env, me, "DELETE", "/api/certs/" + id)).json(), { deleted: 1 }); assert.equal((await send(env, me, "GET", "/api/certs/" + id)).status, 404);
  assert.equal((await upload({}, me)).status, 200);
  assert.equal((await send(env, me, "POST", "/api/certs", { label: "x" }, { origin: "https://evil.example" })).status, 403, "cross-origin");
  assert.equal((await send(env, me, "POST", "/api/certs", "x".repeat(1_600_000))).status, 413, "body size cap");
});

test("at most 12 files per user", async () => {
  const { env, me, other } = await two(); const up = (cookie, i) => send(env, cookie, "POST", "/api/certs", { label: "C" + i, filename: "a.pdf", mime: "application/pdf", data: b64(pad(PDF, 200)) });
  for (let i = 0; i < 12; i++) assert.equal((await up(me, i)).status, 200);
  const r = await up(me, 13); assert.equal(r.status, 409); assert.match((await r.json()).error, /up to 12/);
  assert.equal((await up(other, 1)).status, 200, "the limit is per user");
});

test("your name: stored cleaned, limited, private, and never disturbs the picture or DAN details", async () => {
  const { env, me, other } = await two(); const get = async (c) => (await send(env, c, "GET", "/api/profile")).json();
  const avatar = "data:image/jpeg;base64," + b64(pad(JPEG, 500)); await send(env, me, "PUT", "/api/profile/avatar", { dataUrl: avatar });
  await send(env, me, "PUT", "/api/profile/dan", { number: "12345678", plan: "Master", validUntil: "2027-03-31" });
  assert.equal((await send(env, me, "PUT", "/api/profile/name", { fullName: "  Togar \n  Hugo " })).status, 200);
  const p = await get(me); assert.equal(p.fullName, "Togar Hugo"); assert.equal(p.avatar, avatar, "picture untouched"); assert.equal(p.dan.number, "12345678", "DAN untouched");
  assert.equal((await get(other)).fullName, "", "private");
  assert.equal((await send(env, me, "PUT", "/api/profile/name", { fullName: "" })).status, 200); assert.equal((await get(me)).fullName, "", "an explicit empty string clears it");
  for (const [name, body] of [["too long", { fullName: "x".repeat(81) }], ["not a string", { fullName: 5 }], ["missing", {}]]) assert.equal((await send(env, me, "PUT", "/api/profile/name", body)).status, 400, name);
  assert.equal((await send(env, me, "PUT", "/api/profile/name", { fullName: "x" }, { origin: "https://evil.example" })).status, 403);
});

test("DAN details: validated, private, independent of the name and the picture, clearable", async () => {
  const { env, me, other } = await two(); const get = async (c) => (await send(env, c, "GET", "/api/profile")).json();
  await send(env, me, "PUT", "/api/profile/name", { fullName: "Togar" });
  const dan = { number: "  4412 3399-A ", plan: " DAN   Master ", validUntil: "2027-03-31" };
  assert.equal((await send(env, me, "PUT", "/api/profile/dan", dan)).status, 200);
  let p = await get(me); assert.deepEqual(p.dan, { number: "4412 3399-A", plan: "DAN Master", validUntil: "2027-03-31" }); assert.equal(p.fullName, "Togar", "name untouched");
  assert.deepEqual((await get(other)).dan, { number: "", plan: "", validUntil: "" }, "private");
  assert.equal((await send(env, me, "PUT", "/api/profile/dan", { number: "777" })).status, 200, "plan and validity are optional");
  p = await get(me); assert.deepEqual(p.dan, { number: "777", plan: "", validUntil: "" });
  for (const [name, change] of [["no number", { number: "  " }], ["number with markup", { number: "<script>1</script>" }], ["number too long", { number: "9".repeat(31) }], ["plan too long", { plan: "x".repeat(61) }],
    ["day-first date", { validUntil: "31/12/2026" }], ["month 13", { validUntil: "2026-13-01" }], ["Feb 30", { validUntil: "2026-02-30" }], ["too old", { validUntil: "1980-01-01" }], ["too far", { validUntil: "2101-01-01" }],
    ["datetime", { validUntil: "2026-12-31T00:00:00" }], ["date as number", { validUntil: 20261231 }], ["number as number", { number: 123 }]])
    assert.equal((await send(env, me, "PUT", "/api/profile/dan", { number: "777", ...change })).status, 400, name);
  assert.equal((await send(env, me, "PUT", "/api/profile/dan", { number: "777", validUntil: "2028-02-29" })).status, 200, "a real leap day is fine");
  assert.equal((await send(env, other, "DELETE", "/api/profile/dan")).status, 200); assert.equal((await get(me)).dan.number, "777", "another user's delete does not touch mine");
  assert.equal((await send(env, me, "DELETE", "/api/profile/dan")).status, 200); assert.deepEqual((await get(me)).dan, { number: "", plan: "", validUntil: "" }); assert.equal((await get(me)).fullName, "Togar");
  assert.equal((await send(env, me, "PUT", "/api/profile/dan", { number: "1" }, { origin: "https://evil.example" })).status, 403);
});

test("files have a kind (certification or DAN document) and a date certified; the file limit is per kind", async () => {
  const { env, me, other } = await two();
  const up = (over = {}, cookie = me) => send(env, cookie, "POST", "/api/certs", { label: "Doc", filename: "a.pdf", mime: "application/pdf", data: b64(pad(PDF, 200)), ...over });
  const a = await (await up({ label: "PADI Rescue Diver", number: "R-1", certifiedOn: "2024-05-17" })).json();
  const b = await (await up({ label: "DAN insurance card", kind: "dan" })).json();
  const c = await (await up({ label: "No date" })).json();
  const list = (await (await send(env, me, "GET", "/api/certs")).json()).certs, by = (id) => list.find((x) => x.id === id);
  assert.deepEqual([by(a.id).kind, by(a.id).certifiedOn], ["cert", "2024-05-17"]); assert.deepEqual([by(b.id).kind, by(b.id).certifiedOn], ["dan", ""]); assert.deepEqual([by(c.id).kind, by(c.id).certifiedOn], ["cert", ""], "defaults");
  const one = (await (await send(env, me, "GET", "/api/certs/" + a.id)).json()).cert; assert.equal(one.kind, "cert"); assert.equal(one.certifiedOn, "2024-05-17");
  for (const [name, over] of [["unknown kind", { kind: "passport" }], ["kind not a string", { kind: 5 }], ["bad date", { certifiedOn: "17-05-2024" }], ["impossible date", { certifiedOn: "2024-02-31" }], ["date as number", { certifiedOn: 2024 }]])
    assert.equal((await up(over)).status, 400, name);
  for (let i = 0; i < 10; i++) assert.equal((await up({ label: "C" + i })).status, 200);                  // 2 + 10 = 12 certifications already
  assert.equal((await up({ label: "one too many" })).status, 409, "13th certification refused");
  assert.equal((await up({ label: "second DAN doc", kind: "dan" })).status, 200, "DAN documents have their own allowance");
  assert.equal((await up({ label: "x", kind: "dan" }, other)).status, 200, "limits are per user");
});

test("latest certification: pin one of your own, clear it, deleting the pinned one unpins it, private per user", async () => {
  const { env, me, other } = await two();
  const upload = async (cookie, label, kind = "cert") => (await (await send(env, cookie, "POST", "/api/certs", { kind, label, mime: "application/pdf", filename: label + ".pdf", data: b64(pad(PDF, 300)) })).json()).id;
  const idA = await upload(me, "Advanced"), idB = await upload(me, "Dive Master"), idDan = await upload(me, "DAN card", "dan"), idOther = await upload(other, "Someone else");
  const pinned = async () => (await (await send(env, me, "GET", "/api/profile")).json()).latestCertId;
  assert.equal(await pinned(), "", "nothing pinned by default");
  assert.equal((await send(env, me, "PUT", "/api/profile/latest-cert", { id: idB })).status, 200); assert.equal(await pinned(), idB);
  assert.equal((await send(env, me, "PUT", "/api/profile/latest-cert", { id: idA })).status, 200); assert.equal(await pinned(), idA, "can be changed");
  for (const [name, id, status] of [["another user's file", idOther, 404], ["insurance file, not a certification", idDan, 404], ["unknown id", "0123456789abcdef", 404], ["malformed id", "../../x", 400], ["not a string", 5, 400], ["missing", undefined, 400]]) {
    assert.equal((await send(env, me, "PUT", "/api/profile/latest-cert", { id })).status, status, name); assert.equal(await pinned(), idA, name + ": pin unchanged");
  }
  assert.equal((await send(env, me, "PUT", "/api/profile/latest-cert", { id: idB }, { origin: "https://evil.example" })).status, 403, "cross-origin");
  assert.equal((await (await send(env, other, "GET", "/api/profile")).json()).latestCertId, "", "another user's profile is untouched");
  assert.equal((await send(env, me, "DELETE", "/api/certs/" + idA)).status, 200); assert.equal(await pinned(), "", "deleting the pinned file unpins it");
  await send(env, me, "PUT", "/api/profile/latest-cert", { id: idB }); assert.equal((await send(env, me, "PUT", "/api/profile/latest-cert", { id: "" })).status, 200); assert.equal(await pinned(), "", "cleared = automatic");
  assert.equal((await send(env, other, "DELETE", "/api/certs/" + idB)).status, 200, "another user's delete matches nothing");
  await send(env, me, "PUT", "/api/profile/latest-cert", { id: idB }); assert.equal(await pinned(), idB, "...and did not touch my pin");
});

test("places on the map: validated, one per name (any capitalisation), updatable, removable, private per user", async () => {
  const { env, me, other } = await two();
  const list = async (c) => (await (await send(env, c, "GET", "/api/places")).json()).places;
  assert.deepEqual(await list(me), []);
  assert.equal((await send(env, me, "PUT", "/api/places", { name: "  Tulamben ", lat: -8.2767891, lon: 115.5922 })).status, 200);
  assert.deepEqual(await list(me), [{ name: "Tulamben", lat: -8.276789, lon: 115.5922 }], "trimmed, rounded to 6 decimals");
  await send(env, me, "PUT", "/api/places", { name: "tulamben", lat: -8.3, lon: 115.6 }); assert.deepEqual(await list(me), [{ name: "tulamben", lat: -8.3, lon: 115.6 }], "same place in another capitalisation = update, not a second place");
  await send(env, me, "PUT", "/api/places", { name: "Banda", lat: -4.52, lon: 129.9 }); await send(env, me, "PUT", "/api/places", { name: "Komodo", lat: -8.55, lon: 119.49 });
  assert.deepEqual((await list(me)).map((p) => p.name), ["Banda", "Komodo", "tulamben"], "sorted by name");
  assert.deepEqual(await list(other), [], "another user sees nothing");
  for (const [name, body] of [["no name", { lat: 1, lon: 1 }], ["blank name", { name: "  ", lat: 1, lon: 1 }], ["name too long", { name: "x".repeat(61), lat: 1, lon: 1 }], ["lat too big", { name: "A", lat: 91, lon: 1 }], ["lon too big", { name: "A", lat: 1, lon: 181 }],
    ["text coordinates", { name: "A", lat: "1", lon: "1" }], ["NaN", { name: "A", lat: null, lon: 1 }], ["missing lon", { name: "A", lat: 1 }], ["name not text", { name: 5, lat: 1, lon: 1 }]])
    assert.equal((await send(env, me, "PUT", "/api/places", body)).status, 400, name);
  assert.equal((await send(env, me, "PUT", "/api/places", { name: "Ban\u0000da\n", lat: 1, lon: 1 })).status, 200); assert.ok((await list(me)).some((p) => p.name === "Ban da"), "control characters become spaces");
  assert.equal((await send(env, me, "PUT", "/api/places", { name: "X", lat: 1, lon: 1 }, { origin: "https://evil.example" })).status, 403, "cross-origin");
  assert.equal((await send(env, other, "DELETE", "/api/places", { name: "Komodo" })).status, 200); assert.ok((await list(me)).some((p) => p.name === "Komodo"), "another user cannot delete my place");
  assert.deepEqual(await (await send(env, me, "DELETE", "/api/places", { name: "KOMODO" })).json(), { deleted: 1 }); assert.ok(!(await list(me)).some((p) => p.name === "Komodo"));
  assert.equal((await send(env, me, "DELETE", "/api/places", {})).status, 400);
  assert.equal((await call(env, "/api/places", { method: "GET" })).status, 401, "signed-out");
  // the limit: 500 places
  for (let i = 0; i < 500; i++) await env.DB.prepare("INSERT OR IGNORE INTO places (user_email, k, name, lat, lon) VALUES (?,?,?,?,?)").bind("me@example.com", "fill" + i, "fill" + i, 0, 0).run();
  const full = await send(env, me, "PUT", "/api/places", { name: "One too many", lat: 1, lon: 1 }); assert.equal(full.status, 409);
  assert.equal((await send(env, me, "PUT", "/api/places", { name: "Banda", lat: -4.6, lon: 129.95 })).status, 200, "an existing place can still be moved when full");
});

test("regulator service: last service month, two reminder limits and a history; validated; older pages do not wipe them", async () => {
  const { env, me, other } = await two(); const get = async (c = me) => (await (await send(env, c, "GET", "/api/regulator")).json()).regulator, put = (body, c = me) => send(env, c, "PUT", "/api/regulator", body);
  const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, now = new Date(), thisMonth = ym(now), nextMonth = ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))), twoAhead = ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)));
  const reg = { name: "Tecline R4", type: "Balanced piston", baseline: 0, since: "2026-10-17T08:26:00" };
  const full = { ...reg, serviced: "2026-03", limitDives: 100, limitMonths: 18, history: [{ m: "2026-03", dives: 88, at: "2026-03-20" }, { m: "2025-02", dives: 91, at: "2025-02-11" }] };
  assert.equal((await put(full)).status, 200); assert.deepEqual(await get(), { ...full, since: reg.since }, "everything is stored and returned");
  // an older page (no new fields) saves the regulator: the service data is kept
  assert.equal((await put({ ...reg, name: "Tecline R4 (renamed)", baseline: 5 })).status, 200); const kept = await get(); assert.equal(kept.name, "Tecline R4 (renamed)"); assert.deepEqual([kept.serviced, kept.limitDives, kept.limitMonths, kept.history.length], ["2026-03", 100, 18, 2], "unchanged");
  // limits: the dive reminder or the time reminder can be switched off (0), but not both
  assert.equal((await put({ ...full, limitDives: 0 })).status, 200); assert.equal((await get()).limitDives, 0); assert.equal((await put({ ...full, limitMonths: 0 })).status, 200); assert.equal((await get()).limitMonths, 0);
  const both = await put({ ...full, limitDives: 0, limitMonths: 0 }); assert.equal(both.status, 400); assert.match((await both.json()).error, /at least one reminder/);
  // a service month: real, not before 1990, not in the future (next month is allowed for a phone in another time zone)
  assert.equal((await put({ ...full, serviced: "" })).status, 200); assert.equal((await get()).serviced, "", "not set is fine"); assert.equal((await put({ ...full, serviced: thisMonth })).status, 200); assert.equal((await put({ ...full, serviced: nextMonth })).status, 200);
  for (const [name, change] of [["two months ahead", { serviced: twoAhead }], ["year 3000", { serviced: "3000-01" }], ["month 13", { serviced: "2026-13" }], ["month 00", { serviced: "2026-00" }], ["before 1990", { serviced: "1989-12" }], ["a date, not a month", { serviced: "2026-03-15" }],
    ["text", { serviced: "March 2026" }], ["number", { serviced: 202603 }], ["null", { serviced: null }], ["injection", { serviced: "2026-03'; DROP TABLE regulators;--" }],
    ["dives below 10", { limitDives: 9 }], ["dives above 1000", { limitDives: 1001 }], ["fractional dives", { limitDives: 90.5 }], ["text dives", { limitDives: "90" }], ["negative dives", { limitDives: -1 }],
    ["months below 3", { limitMonths: 2 }], ["months above 60", { limitMonths: 61 }], ["fractional months", { limitMonths: 12.5 }], ["text months", { limitMonths: "12" }], ["negative months", { limitMonths: -3 }],
    ["history not a list", { history: "x" }], ["history of 21", { history: Array.from({ length: 21 }, () => ({ m: "2026-03", dives: 1, at: "2026-03-01" })) }], ["history entry without a month", { history: [{ dives: 1, at: "2026-03-01" }] }], ["history blank month", { history: [{ m: "", dives: 1, at: "2026-03-01" }] }],
    ["history negative dives", { history: [{ m: "2026-03", dives: -1, at: "2026-03-01" }] }], ["history bad date", { history: [{ m: "2026-03", dives: 1, at: "soon" }] }], ["history entry not an object", { history: ["x"] }], ["history null entry", { history: [null] }]])
    assert.equal((await put({ ...full, ...change })).status, 400, name);
  assert.deepEqual((await get()).history.map((h) => h.m), ["2026-03", "2025-02"], "refused updates changed nothing");
  assert.equal((await put({ ...full, history: [] })).status, 200); assert.deepEqual((await get()).history, [], "an empty history is fine"); assert.equal((await put({ ...full, history: Array.from({ length: 20 }, (_, i) => ({ m: "2025-0" + (1 + (i % 9)), dives: i, at: "2025-01-0" + (1 + (i % 9)) })) })).status, 200, "20 entries are the limit");
  assert.equal((await put({ ...full, history: [{ m: "2026-03", dives: 88, at: "2026-03-20", extra: "x".repeat(9999) }] })).status, 200); assert.deepEqual(Object.keys((await get()).history[0]).sort(), ["at", "dives", "m"], "only the three known fields are stored");
  // private per user, and removing the regulator removes all of it
  assert.equal(await get(other), null); assert.equal((await put({ ...reg, serviced: "2024-01" }, other)).status, 200); assert.equal((await get(other)).serviced, "2024-01"); assert.equal((await get()).serviced, "2026-03", "mine is not touched by theirs");
  assert.equal((await send(env, me, "DELETE", "/api/regulator")).status, 200); assert.equal(await get(), null); assert.equal((await put(reg)).status, 200); assert.deepEqual([(await get()).serviced, (await get()).limitDives, (await get()).limitMonths], ["", 90, 12], "a new regulator starts from the defaults");
  assert.equal((await put(full, null)).status, 401, "signed-out");
});
