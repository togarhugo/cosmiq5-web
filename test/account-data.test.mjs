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
  for (const [m, p] of [["GET", "/api/profile"], ["PUT", "/api/profile/avatar"], ["DELETE", "/api/profile/avatar"], ["GET", "/api/regulator"], ["PUT", "/api/regulator"], ["GET", "/api/certs"], ["POST", "/api/certs"], ["GET", "/api/certs/0123456789abcdef"], ["DELETE", "/api/certs/0123456789abcdef"]])
    assert.equal((await call(env, p, { method: m, body: m === "GET" ? undefined : "{}" })).status, 401, m + " " + p);
});

test("profile picture: only small JPEGs; replace, read back, remove; private per user", async () => {
  const { env, me, other } = await two(); const url = "data:image/jpeg;base64,";
  assert.deepEqual(await (await send(env, me, "GET", "/api/profile")).json(), { avatar: null });
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
  assert.deepEqual(await (await send(env, me, "GET", "/api/profile")).json(), { avatar: null });
  assert.equal((await send(env, me, "PUT", "/api/profile/avatar", { dataUrl: good }, { origin: "https://evil.example" })).status, 403, "cross-origin");
});

test("regulator: validated, stored per user, updatable, removable", async () => {
  const { env, me, other } = await two();
  assert.deepEqual(await (await send(env, me, "GET", "/api/regulator")).json(), { regulator: null });
  const reg = { name: "  Apeks   XTX50 ", type: "Balanced piston", baseline: 12, since: "2026-10-17T08:26:00" };
  assert.equal((await send(env, me, "PUT", "/api/regulator", reg)).status, 200);
  assert.deepEqual((await (await send(env, me, "GET", "/api/regulator")).json()).regulator, { name: "Apeks XTX50", type: "Balanced piston", baseline: 12, since: "2026-10-17T08:26:00" });
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
