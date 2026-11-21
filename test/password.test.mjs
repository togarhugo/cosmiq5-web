import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { base32Decode, hotp, otpauthUri, stepOf, verifyTotp } from "../src/totp.js";
import { authed, call, cookieOf, enroll, googleSession, kdf, login, makeEnv, post, totpNow } from "./harness.mjs";

const PW = "correct horse battery";
const withTime = async (offsetMs, fn) => { const real = Date.now; Date.now = () => real() + offsetMs; try { return await fn(); } finally { Date.now = real; } };
const at = (n, fn) => withTime(n * 30000, fn);
async function enrolled(over = {}) { const env = makeEnv(over); const { cookie } = await googleSession(env); const e = await enroll(env, cookie, PW); assert.equal(e.res.status, 200); return { env, cookie, ...e }; }
const del = (env, cookie, code) => call(env, "/api/account/password", { method: "DELETE", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ code }) });

test("TOTP matches RFC 6238 vectors and tolerates one step of clock drift", async () => {
  const sec = new TextEncoder().encode("12345678901234567890");
  assert.equal(await hotp(sec, 1, 8), "94287082"); assert.equal(await hotp(sec, Math.floor(1111111109 / 30), 8), "07081804");
  const now = 1_700_000_000_000, s = stepOf(now);
  for (const [off, ok] of [[0, true], [-1, true], [1, true], [-2, false], [2, false]])
    assert.equal((await verifyTotp(sec, await hotp(sec, s + off), 0, now)) !== null, ok, "offset " + off);
  assert.equal(await verifyTotp(sec, await hotp(sec, s), s, now), null, "replay of an already used step");
  assert.equal(await verifyTotp(sec, "12345", 0, now), null); assert.equal(await verifyTotp(sec, "abcdef", 0, now), null);
  assert.match(otpauthUri("ABC", "me@example.com"), /^otpauth:\/\/totp\/Cosmiq%20Dive:me%40example\.com\?secret=ABC&issuer=Cosmiq%20Dive&algorithm=SHA1&digits=6&period=30$/);
});

test("enrollment needs an existing session: no open sign-up", async () => {
  const env = makeEnv();
  assert.equal((await post(env, "/api/account/mfa/start", {})).status, 401);
  assert.equal((await post(env, "/api/account/password", { salt: "0".repeat(32), iter: 1000, key: "0".repeat(64), code: "123456" })).status, 401);
  assert.equal((await call(env, "/api/account")).status, 401);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) c FROM users").get().c, 0);
});

test("enroll -> sign in with email + password + code -> session works everywhere", async () => {
  const { env, secret, uri } = await enrolled();
  assert.match(uri, /^otpauth:\/\/totp\/Cosmiq%20Dive:me%40example\.com\?secret=[A-Z2-7]{32}&/);
  const res = await at(1, async () => login(env, "me@example.com", PW, await totpNow(secret)));
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), { ok: true });
  const sc = res.headers.getSetCookie().find((c) => c.startsWith("dc_session=")); assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/);
  const cookie = "dc_session=" + cookieOf(res, "dc_session");
  const acct = await (await call(env, "/api/account", { headers: { cookie } })).json();
  assert.equal(acct.via, "pwd+totp"); assert.equal(acct.password, true); assert.equal(acct.email, "me@example.com"); assert.equal(acct.kdfIter, 1000);
  assert.equal((await call(env, "/api/dives", { headers: { cookie } })).status, 200);
  assert.equal((await call(env, "/", { headers: { cookie, accept: "text/html" } })).status, 200);
  assert.equal((await at(2, async () => login(env, "ME@example.com", PW, await totpNow(secret)))).status, 200, "email is case-insensitive");
});

test("all failure modes give the same generic 401 and never set a cookie", async () => {
  const { env, secret } = await enrolled();
  const code = await totpNow(secret, 1), badCode = code === "000000" ? "000001" : "000000";
  const cases = [["wrong password", () => login(env, "me@example.com", "wrong wrong wrong", code)],
    ["wrong code", () => login(env, "me@example.com", PW, badCode)],
    ["unknown email", () => login(env, "ghost@example.com", PW, code)],
    ["allowed but never enrolled", () => login(env, "other@example.com", PW, code)],
    ["bad key format", () => post(env, "/auth/password", { email: "me@example.com", key: "xyz", code })],
    ["bad code format", () => post(env, "/auth/password", { email: "me@example.com", key: "a".repeat(64), code: "12" })]];
  const bodies = new Set();
  for (const [name, fn] of cases) {
    const r = await fn(); assert.equal(r.status, 401, name); assert.ok(!cookieOf(r, "dc_session"), name + ": cookie");
    bodies.add((await r.json()).error);
  }
  assert.equal(bodies.size, 1, "identical error text for every failure: " + [...bodies].join(" | "));
  assert.equal((await post(env, "/auth/password", { nope: 1 })).status, 400);
  assert.equal((await post(env, "/auth/password", "x")).status, 400);
});

test("prelogin looks the same for known, unknown and not-allowed emails (no enumeration)", async () => {
  const { env } = await enrolled();
  const pre = async (email) => (await post(env, "/auth/prelogin", { email })).json();
  const known = await pre("me@example.com"), unknown = await pre("ghost@example.com"), notAllowed = await pre("x@evil.com");
  for (const r of [known, unknown, notAllowed]) { assert.match(r.salt, /^[0-9a-f]{32}$/); assert.equal(r.iter, 1000); }
  assert.deepEqual(await pre("ghost@example.com"), unknown, "fake salt is stable per email");
  assert.notEqual(unknown.salt, notAllowed.salt);
  assert.equal((await post(env, "/auth/prelogin", { email: "not-an-email" })).status, 400);
  assert.equal((await call(env, "/auth/prelogin")).status, 404, "GET is not a login route");
});

test("a TOTP code can be used only once (replay protection)", async () => {
  const { env, secret } = await enrolled();
  const code = await at(1, () => totpNow(secret));
  assert.equal((await at(1, () => login(env, "me@example.com", PW, code))).status, 200);
  assert.equal((await at(1, () => login(env, "me@example.com", PW, code))).status, 401, "same code again");
  assert.equal((await login(env, "me@example.com", PW, await totpNow(secret))).status, 401, "an older step than the last accepted one");
  assert.equal((await at(2, async () => login(env, "me@example.com", PW, await totpNow(secret)))).status, 200, "a later step is accepted");
});

test("lockout: 5 failures lock the email for 15 minutes, even for the right credentials; resets after", async () => {
  const { env, secret } = await enrolled();
  for (let i = 0; i < 5; i++) assert.equal((await login(env, "me@example.com", "wrong wrong wrong", "000000")).status, 401);
  const locked = await at(1, async () => login(env, "me@example.com", PW, await totpNow(secret)));
  assert.equal(locked.status, 429); assert.match((await locked.json()).error, /Too many/); assert.ok(!cookieOf(locked, "dc_session"));
  assert.equal(await withTime(16 * 60_000, async () => (await login(env, "me@example.com", PW, await totpNow(secret, 0))).status), 200, "after 15 min it works");
});

test("lockout also applies per IP across different emails, and a success clears the email counter", async () => {
  const { env, secret } = await enrolled();
  const ip = { "cf-connecting-ip": "203.0.113.9" };
  for (let i = 0; i < 20; i++) await login(env, `ghost${i}@example.com`, "x".repeat(12), "000000", ip);
  assert.equal((await at(1, async () => login(env, "me@example.com", PW, await totpNow(secret), ip))).status, 429, "IP locked");
  const other = { "cf-connecting-ip": "198.51.100.8" };
  const mine = "e:" + createHash("sha256").update("me@example.com").digest("hex").slice(0, 32);
  const counter = () => env.DB.raw.prepare("SELECT n FROM auth_attempts WHERE k = ?").get(mine);
  for (let i = 0; i < 4; i++) await login(env, "me@example.com", "wrong wrong wrong", "000000", other);
  assert.equal(counter().n, 4);
  assert.equal((await at(1, async () => login(env, "me@example.com", PW, await totpNow(secret), other))).status, 200);
  assert.equal(counter(), undefined, "email counter cleared on success");
});

test("nothing secret is stored in the clear: no password, no derived key, no TOTP secret", async () => {
  const { env, secret, key } = await enrolled();
  const dump = JSON.stringify(["users", "enrollments", "auth_attempts"].flatMap((t) => env.DB.raw.prepare(`SELECT * FROM ${t}`).all()));
  const secretHex = [...base32Decode(secret)].map((b) => b.toString(16).padStart(2, "0")).join("");
  for (const [name, needle] of [["password", PW], ["derived key", key], ["totp secret", secret], ["totp secret bytes", secretHex]])
    assert.ok(!dump.includes(needle), name + " must not be in the database");
  const row = env.DB.raw.prepare("SELECT * FROM users").get();
  assert.match(row.pw_hash, /^[0-9a-f]{64}$/); assert.notEqual(row.pw_hash, key, "stored value is a keyed hash, not the derived key");
  assert.equal((await login({ ...env, DATA_KEY: "z".repeat(48) }, "me@example.com", PW, await totpNow(secret, 1))).status, 401,
    "a stolen database without the DATA_KEY secret cannot authenticate");
});

test("the browser KDF binds the key to the salt, email and iteration count", async () => {
  const a = await kdf.deriveKey(PW, "00".repeat(16), 1000, "me@example.com");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, await kdf.deriveKey(PW, "01" + "00".repeat(15), 1000, "me@example.com"), "salt");
  assert.notEqual(a, await kdf.deriveKey(PW, "00".repeat(16), 1001, "me@example.com"), "iterations");
  assert.notEqual(a, await kdf.deriveKey(PW, "00".repeat(16), 1000, "other@example.com"), "email");
  assert.equal(a, await kdf.deriveKey(PW, "00".repeat(16), 1000, " ME@example.com "), "email normalised");
  assert.equal(await kdf.deriveKey("é", "00".repeat(16), 1000, "a@b.c"), await kdf.deriveKey("é", "00".repeat(16), 1000, "a@b.c"), "unicode NFKC");
});

test("enrollment hardening: wrong/expired code, weak iterations, malformed input all refused; nothing is created", async () => {
  const env = makeEnv(); const { cookie } = await googleSession(env);
  const start = await (await post(env, "/api/account/mfa/start", {}, authed(cookie))).json();
  const salt = kdf.randomSalt(), key = await kdf.deriveKey(PW, salt, 1000, "me@example.com"), code = await totpNow(start.secret);
  const fin = (b) => post(env, "/api/account/password", b, authed(cookie));
  assert.equal((await fin({ salt, iter: 1000, key, code: code === "000000" ? "000001" : "000000" })).status, 400, "wrong code");
  assert.equal((await fin({ salt, iter: 10, key, code })).status, 400, "iterations below server minimum");
  assert.equal((await fin({ salt: "zz", iter: 1000, key, code })).status, 400, "bad salt");
  assert.equal((await fin({ salt, iter: 1000, key: "abc", code })).status, 400, "bad key");
  assert.equal((await fin({ salt, iter: 1000, key, code: "12" })).status, 400, "bad code format");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) c FROM users").get().c, 0);
  const expired = await withTime(11 * 60_000, async () => fin({ salt, iter: 1000, key, code: await totpNow(start.secret) }));
  assert.equal(expired.status, 400); assert.match((await expired.json()).error, /expired/i);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) c FROM users").get().c, 0);
});

test("changing or removing email login requires the CURRENT authenticator code", async () => {
  const { env, cookie, secret } = await enrolled();
  // Start a change at `n` steps from now; `cur` is undefined, "bad", or "good" (the current authenticator code).
  const again = (pw, cur, n = 0) => at(n, async () => {
    const st = await (await post(env, "/api/account/mfa/start", {}, authed(cookie))).json();
    const salt = kdf.randomSalt(), key = await kdf.deriveKey(pw, salt, 1000, "me@example.com");
    const currentCode = cur === "good" ? await totpNow(secret) : cur === "bad" ? "000000" : undefined;
    return { st, res: await post(env, "/api/account/password", { salt, iter: 1000, key, code: await totpNow(st.secret), currentCode }, authed(cookie)) };
  });
  assert.equal((await again("new password here!", undefined)).res.status, 403, "no current code");
  assert.equal((await again("new password here!", "bad")).res.status, 403, "wrong current code");
  assert.equal((await at(1, async () => login(env, "me@example.com", PW, await totpNow(secret)))).status, 200, "old credentials still work: nothing changed");
  const ok = await again("new password here!", "good", 2);
  assert.equal(ok.res.status, 200);
  const loginNew = (pw, n) => at(n, async () => login(env, "me@example.com", pw, await totpNow(ok.st.secret)));
  assert.equal((await loginNew(PW, 3)).status, 401, "old password is dead");
  assert.equal((await loginNew("new password here!", 3)).status, 200);
  assert.equal((await del(env, cookie, "000000")).status, 403);
  assert.equal((await at(4, async () => del(env, cookie, await totpNow(ok.st.secret)))).status, 200);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) c FROM users").get().c, 0);
  assert.equal((await loginNew("new password here!", 5)).status, 401, "removed account can no longer sign in");
  assert.equal((await call(env, "/api/me", { headers: { cookie } })).status, 200, "Google session unaffected");
});

test("code guessing on account changes is rate limited too", async () => {
  const { env, cookie } = await enrolled();
  await post(env, "/api/account/mfa/start", {}, authed(cookie));
  const salt = kdf.randomSalt(), key = await kdf.deriveKey("another password!", salt, 1000, "me@example.com");
  const attempt = () => post(env, "/api/account/password", { salt, iter: 1000, key, code: "000000", currentCode: "000000" }, authed(cookie));
  for (let i = 0; i < 5; i++) assert.equal((await attempt()).status, 403);
  assert.equal((await attempt()).status, 429);
});

test("cross-origin POST to the login endpoints is refused", async () => {
  const env = makeEnv();
  assert.equal((await post(env, "/auth/password", { email: "me@example.com", key: "a".repeat(64), code: "123456" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post(env, "/auth/prelogin", { email: "me@example.com" }, { origin: "https://evil.example" })).status, 403);
});

test("removing someone from ALLOWED_EMAILS also disables their email + password login", async () => {
  const { env, secret } = await enrolled();
  assert.equal((await at(1, async () => login(env, "me@example.com", PW, await totpNow(secret)))).status, 200, "allowed: works");
  const delisted = { ...env, ALLOWED_EMAILS: "other@example.com" };
  const real = await (await post(env, "/auth/prelogin", { email: "me@example.com" })).json();
  const fake = await (await post(delisted, "/auth/prelogin", { email: "me@example.com" })).json();
  assert.notEqual(fake.salt, real.salt, "de-listed account looks like an unknown one (prelogin layer)");
  // Second layer: even an attacker who kept the REAL salt and key cannot get in through /auth/password.
  const key = await kdf.deriveKey(PW, real.salt, real.iter, "me@example.com");
  const r = await at(2, async () => post(delisted, "/auth/password", { email: "me@example.com", key, code: await totpNow(secret) }));
  assert.equal(r.status, 401); assert.ok(!cookieOf(r, "dc_session"));
  const ok = await at(2, async () => post(env, "/auth/password", { email: "me@example.com", key, code: await totpNow(secret) }));
  assert.equal(ok.status, 200, "control: same request with the user still allowed succeeds");
});

test("regression: the Account tab calls mfa/start with no body (and DELETE/GET shapes it really sends)", async () => {
  const env = makeEnv(); const { cookie } = await googleSession(env);
  const bare = await call(env, "/api/account/mfa/start", { method: "POST", headers: { cookie, "content-type": "application/json" } });
  assert.equal(bare.status, 200); assert.match((await bare.json()).secret, /^[A-Z2-7]{32}$/);
  const garbage = await call(env, "/api/account/mfa/start", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "not json" });
  assert.equal(garbage.status, 200, "start needs no input at all");
  assert.equal((await post(env, "/api/account/password", {}, authed(cookie))).status, 400, "finish still validates its fields");
  assert.equal((await del(env, cookie, undefined)).status, 200, "removing when nothing is set up is a no-op");
});
