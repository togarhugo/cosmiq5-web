import test from "node:test";
import assert from "node:assert/strict";
import { sign, verifySigned } from "../src/auth.js";
import { VERSION } from "../src/version.js";
import { base, call, html, cookieOf, makeEnv, googleSession, post, ORIGIN } from "./harness.mjs";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function stubGoogle(claimsFn, { status = 200, body } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(init.body); stubGoogle.lastForm = form;
    return new Response(JSON.stringify(body || { id_token: `h.${b64(claimsFn(form))}.s` }), { status });
  };
  return () => { globalThis.fetch = real; };
}
async function beginLogin(env) {
  const res = await call(env, "/auth/google"); const loc = new URL(res.headers.get("location"));
  return { res, loc, oauth: cookieOf(res, "dc_oauth"), state: loc.searchParams.get("state"), nonce: loc.searchParams.get("nonce") };
}
const goodClaims = (nonce, over = {}) => () => ({ iss: "https://accounts.google.com", aud: base.GOOGLE_CLIENT_ID,
  exp: Math.floor(Date.now() / 1000) + 600, nonce, email: "me@example.com", email_verified: true, name: "Me", ...over });
const callback = (env, l, { state = l.state, oauth = l.oauth, code = "abc" } = {}) =>
  call(env, `/auth/callback?code=${code}&state=${state}`, { headers: { cookie: oauth ? "dc_oauth=" + oauth : "" } });

test("fails closed (503) until fully configured, for pages and API", async () => {
  for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET", "ALLOWED_EMAILS", "DATA_KEY"]) {
    assert.equal((await call(makeEnv({ [key]: "" }), "/", html)).status, 503, key);
  }
  assert.equal((await call(makeEnv({ SESSION_SECRET: "short" }), "/api/me")).status, 503);
  assert.equal((await call(makeEnv({ DATA_KEY: "short" }), "/api/me")).status, 503);
  assert.equal((await call(makeEnv({ GOOGLE_CLIENT_ID: "REPLACE_ME" }), "/", html)).status, 503);
});

test("signed-out: pages go to the login page; API/assets/POST get 401; only login assets are public", async () => {
  const env = makeEnv();
  const p = await call(env, "/", html); assert.equal(p.status, 302); assert.equal(new URL(p.headers.get("location")).pathname, "/auth/login");
  for (const path of ["/api/dives", "/api/me", "/api/account", "/icon-192.png", "/dives.js", "/index.html"]) assert.equal((await call(env, path)).status, 401, path);
  assert.equal((await call(env, "/api/dives", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await call(env, "/auth/login.js")).status, 200);
  assert.equal((await call(env, "/auth/kdf.js")).status, 200);
  assert.equal((await call(env, "/auth/mfa.js")).status, 200);
  assert.equal((await call(env, "/auth/mfa.html")).status, 404, "raw template not exposed");
  assert.equal((await call(env, "/auth/mfa", html)).status, 302, "the code page needs the password step first");
  assert.equal((await call(env, "/auth/login.html")).status, 404, "raw template not exposed");
  assert.equal((await call(env, "/auth/nothing")).status, 404);
});

test("first page is the login page: Google button and email + password only, version, strict CSP", async () => {
  const env = makeEnv();
  const r = await call(env, "/auth/login", html); assert.equal(r.status, 200);
  const t = await r.text();
  assert.match(t, /Continue with Google/); assert.match(t, /href="\/auth\/google"/);
  for (const id of ['id="email"', 'id="password"']) assert.ok(t.includes(id), id);
  assert.ok(!t.includes('id="code"') && !/authenticator code/i.test(t.split("<p class=\"hint\"")[0]), "no code field on the first screen");
  assert.equal((t.match(/<input /g) || []).length, 2, "only email + password inputs");
  assert.ok(t.includes("v" + VERSION) && !t.includes("__APP_VERSION__"), "version shown, token replaced");
  assert.match(r.headers.get("content-security-policy"), /script-src 'self'/); assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.doesNotMatch(t, /<script>[^<]/, "no inline scripts (CSP)");
  const { cookie } = await googleSession(env);
  const again = await call(env, "/auth/login", { headers: { cookie } }); assert.equal(again.status, 302);
  assert.equal(again.headers.get("location"), "/", "already signed in -> straight to the app");
});

test("Google start redirects with PKCE, state and nonce; oauth cookie is httpOnly/secure", async () => {
  const { res, loc, oauth } = await beginLogin(makeEnv());
  assert.equal(res.status, 302); assert.equal(loc.origin + loc.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(loc.searchParams.get("client_id"), base.GOOGLE_CLIENT_ID);
  assert.equal(loc.searchParams.get("redirect_uri"), ORIGIN + "/auth/callback");
  const payload = await verifySigned(oauth, base.SESSION_SECRET);
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload.verifier))).toString("base64url");
  assert.equal(loc.searchParams.get("code_challenge"), digest);
  const sc = res.headers.getSetCookie().find((c) => c.startsWith("dc_oauth="));
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Lax/);
});

test("full Google sign-in: session works, app + assets served, version exposed, PKCE verifier sent", async () => {
  const env = makeEnv(); const l = await beginLogin(env); const restore = stubGoogle(goodClaims(l.nonce));
  let res; try { res = await callback(env, l); } finally { restore(); }
  assert.equal(res.status, 302); assert.equal(res.headers.get("location"), "/");
  assert.equal(stubGoogle.lastForm.get("code_verifier"), (await verifySigned(l.oauth, base.SESSION_SECRET)).verifier);
  const sc = res.headers.getSetCookie().find((c) => c.startsWith("dc_session="));
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /Max-Age=2592000/);
  const cookie = "dc_session=" + cookieOf(res, "dc_session");
  assert.deepEqual(await (await call(env, "/api/me", { headers: { cookie } })).json(), { email: "me@example.com", name: "Me", version: VERSION });
  const page = await call(env, "/", { headers: { cookie, accept: "text/html" } });
  assert.equal(page.status, 200); assert.match(await page.text(), /Cosmiq Manager/);
  assert.equal(page.headers.get("x-app-version"), VERSION); assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(new Uint8Array(await (await call(env, "/icon-192.png", { headers: { cookie } })).arrayBuffer())[1], 0x50, "PNG intact");
  for (const f of ["/version.js", "/account.js", "/vendor/qrcode.js"]) assert.equal((await call(env, f, { headers: { cookie } })).status, 200, f);
  assert.equal((await call(env, "/nope", { headers: { cookie } })).status, 404);
});

test("Google sign-in refused for: bad state, missing/tampered/expired cookie, wrong account, unverified, bad nonce/aud/iss/exp, Google error", async () => {
  const env = makeEnv(); const l = await beginLogin(env);
  const real = globalThis.fetch; let googleCalls = 0;
  globalThis.fetch = async () => { googleCalls++; throw new Error("Google must not be called"); };
  try {
    const expired = await sign({ typ: "oauth", state: l.state, nonce: l.nonce, verifier: "v", exp: 1 }, base.SESSION_SECRET);
    for (const [name, r] of [["bad state", await callback(env, l, { state: "evil" })], ["no cookie", await callback(env, l, { oauth: "" })],
      ["tampered", await callback(env, l, { oauth: l.oauth.slice(0, -2) + "xx" })], ["expired", await callback(env, l, { oauth: expired })],
      ["no code", await call(env, `/auth/callback?state=${l.state}`, { headers: { cookie: "dc_oauth=" + l.oauth } })]]) {
      assert.equal(r.status, 400, name); assert.match(await r.text(), /Sign-in expired/, name);
    }
  } finally { globalThis.fetch = real; }
  assert.equal(googleCalls, 0, "Google contacted for an invalid callback");
  for (const [name, over, status] of [["stranger", { email: "stranger@evil.com" }, 403], ["unverified", { email_verified: false }, 400],
    ["nonce", { nonce: "other" }, 400], ["aud", { aud: "other-client" }, 400], ["iss", { iss: "https://evil.com" }, 400], ["exp", { exp: 1 }, 400]]) {
    const lg = await beginLogin(env); const restore = stubGoogle(goodClaims(lg.nonce, over));
    try { const r = await callback(env, lg); assert.equal(r.status, status, name); assert.ok(!cookieOf(r, "dc_session"), name); } finally { restore(); }
  }
  const restore = stubGoogle(null, { status: 400, body: { error: "invalid_grant" } });
  try { assert.equal((await callback(env, await beginLogin(env))).status, 400); } finally { restore(); }
  assert.equal((await call(env, "/auth/callback?error=access_denied")).status, 400);
});

test("forged, tampered, expired sessions and de-listed users are rejected", async () => {
  const env = makeEnv(); const { cookie: good } = await googleSession(env);
  const me = (cookie, e = env) => call(e, "/api/me", { headers: { cookie } });
  assert.equal((await me(good)).status, 200);
  assert.equal((await me(good.slice(0, -3) + "AAA")).status, 401, "tampered");
  assert.equal((await me("dc_session=" + (await sign({ typ: "session", email: "me@example.com", exp: 9e9 }, "y".repeat(48))))).status, 401, "other key");
  assert.equal((await me("dc_session=" + (await sign({ typ: "session", email: "me@example.com", exp: 1 }, base.SESSION_SECRET)))).status, 401, "expired");
  assert.equal((await me("dc_session=" + (await sign({ typ: "oauth", email: "me@example.com", exp: 9e9 }, base.SESSION_SECRET)))).status, 401, "wrong type");
  assert.equal((await me(good, { ...env, ALLOWED_EMAILS: "someone@else.com" })).status, 401, "removed from allow-list");
});

test("dive API: per-user isolation, validation, cross-origin writes refused", async () => {
  const env = makeEnv(); const { cookie: me } = await googleSession(env);
  const dive = { fingerprint: "e90903091e00", headerHex: "00".repeat(36), profileHex: "0102", startedAt: "2025-03-14T09:30:00" };
  const put = (cookie, body, h = {}) => post(env, "/api/dives", body, { cookie, ...h });
  assert.equal((await put(me, { dives: [dive] }, { origin: ORIGIN })).status, 200);
  assert.equal((await put(me, { dives: [dive] }, { origin: "https://evil.example" })).status, 403, "cross-origin");
  assert.equal((await put(me, { dives: [{ ...dive, headerHex: "zz" }] })).status, 400);
  assert.equal((await put(me, { dives: [{ ...dive, fingerprint: "../../" }] })).status, 400);
  assert.equal((await put(me, { dives: Array(51).fill(dive) })).status, 413);
  assert.equal((await (await call(env, "/api/dives", { headers: { cookie: me } })).json()).dives.length, 1);
  // a different allowed user never sees it, and duplicate uploads are ignored
  const { cookie: other } = await googleSession(env, { email: "other@example.com" });
  assert.equal((await (await call(env, "/api/dives", { headers: { cookie: other } })).json()).dives.length, 0, "isolation");
  assert.equal((await (await put(me, { dives: [dive] })).json()).stored, 0, "duplicate ignored");
});

test("logout clears the session cookie", async () => {
  const r = await call(makeEnv(), "/auth/logout");
  assert.equal(r.status, 200); assert.match(r.headers.getSetCookie().find((c) => c.startsWith("dc_session=")), /Max-Age=0/);
});

test("dive locations: stored cleaned, returned, updatable, clearable, validated, and private to each user", async () => {
  const env = makeEnv(); const { cookie: me } = await googleSession(env); const { cookie: other } = await googleSession(env, { email: "other@example.com" });
  const dive = (fp, extra = {}) => ({ fingerprint: fp, headerHex: "00".repeat(36), profileHex: "", startedAt: "2025-03-14T09:30:00", ...extra });
  const send = (cookie, path, body, h = {}) => post(env, path, body, { cookie, ...h });
  const list = async (cookie) => (await (await call(env, "/api/dives", { headers: { cookie } })).json()).dives;
  assert.equal((await send(me, "/api/dives", { dives: [dive("aaaaaaaaaaaa", { location: "  Komodo   National  Park " }), dive("bbbbbbbbbbbb")] })).status, 200);
  let rows = await list(me); const byFp = (fp) => rows.find((r) => r.fingerprint === fp);
  assert.equal(byFp("aaaaaaaaaaaa").location, "Komodo National Park", "trimmed and single-spaced"); assert.equal(byFp("bbbbbbbbbbbb").location, null, "no location = null");
  // update several at once, including clearing one
  assert.deepEqual(await (await send(me, "/api/dives/location", { items: [{ fingerprint: "aaaaaaaaaaaa", location: null }, { fingerprint: "bbbbbbbbbbbb", location: "Banda" }] })).json(), { updated: 2 });
  rows = await list(me); assert.equal(byFp("aaaaaaaaaaaa").location, null); assert.equal(byFp("bbbbbbbbbbbb").location, "Banda");
  assert.equal((await send(me, "/api/dives/location", { items: [{ fingerprint: "bbbbbbbbbbbb", location: "   " }] })).status, 200);
  assert.equal(byFp((rows = await list(me), "bbbbbbbbbbbb")).location, null, "blank clears");
  // validation
  for (const [name, items] of [["too long", [{ fingerprint: "aaaaaaaaaaaa", location: "x".repeat(61) }]], ["control char", [{ fingerprint: "aaaaaaaaaaaa", location: "Ban\u0000da" }]],
    ["newline", [{ fingerprint: "aaaaaaaaaaaa", location: "a\nb" }]], ["not a string", [{ fingerprint: "aaaaaaaaaaaa", location: 5 }]],
    ["bad fingerprint", [{ fingerprint: "../../../..", location: "Banda" }]], ["missing fingerprint", [{ location: "Banda" }]]])
    assert.equal((await send(me, "/api/dives/location", { items })).status, 400, name);
  assert.equal((await send(me, "/api/dives/location", { items: Array(201).fill({ fingerprint: "aaaaaaaaaaaa", location: "x" }) })).status, 413);
  assert.equal((await send(me, "/api/dives", { dives: [dive("cccccccccccc", { location: "x".repeat(61) })] })).status, 400, "also validated on upload");
  // another user can neither read nor change my dives' locations
  await send(me, "/api/dives/location", { items: [{ fingerprint: "aaaaaaaaaaaa", location: "Tulamben" }] });
  assert.deepEqual(await (await send(other, "/api/dives/location", { items: [{ fingerprint: "aaaaaaaaaaaa", location: "HACKED" }] })).json(), { updated: 0 });
  assert.equal(byFp((rows = await list(me), "aaaaaaaaaaaa")).location, "Tulamben"); assert.equal((await list(other)).length, 0);
  // not signed in / cross-origin
  assert.equal((await post(env, "/api/dives/location", { items: [] })).status, 401);
  assert.equal((await send(me, "/api/dives/location", { items: [] }, { origin: "https://evil.example" })).status, 403);
});
