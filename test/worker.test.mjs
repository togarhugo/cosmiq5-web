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
  for (const [p, type] of [["/auth/favicon.svg", /image\/svg\+xml/], ["/auth/apple-touch-icon.png", /image\/png/], ["/auth/theme.js", /javascript/], ["/auth/theme.css", /text\/css/], ["/auth/logo-light.png", /image\/png/], ["/auth/logo-dark.png", /image\/png/], ["/auth/fonts.css", /text\/css/], ["/auth/fonts/Geist-Variable.woff2", /font\/woff2/], ["/auth/fonts/GeistMono-Variable.woff2", /font\/woff2/], ["/auth/fonts/LICENSE-Geist-OFL.txt", /text\/plain/], ["/auth/icon-summary.png", /image\/png/], ["/auth/icon-log.png", /image\/png/], ["/auth/icon-device.png", /image\/png/]]) { const r = await call(env, p); assert.equal(r.status, 200, p + " is public: the sign-in pages show the app icon"); assert.match(r.headers.get("content-type"), type); }
  const font = await call(env, "/auth/fonts/Geist-Variable.woff2"); assert.match(font.headers.get("cache-control"), /immutable/, "fonts are cached for a year"); assert.equal((await call(env, "/auth/icon-summary.png")).headers.get("cache-control"), "private, no-cache"); assert.equal((await call(env, "/auth/fonts/nope.woff2")).status, 404); assert.equal((await call(env, "/auth/fonts/../index.html")).status, 404, "no path tricks");
  const loginPage = await call(env, "/auth/login", html); assert.match(loginPage.headers.get("content-security-policy"), /font-src 'self'/); assert.match(loginPage.headers.get("content-security-policy"), /style-src 'self' 'unsafe-inline'/); assert.match(loginPage.headers.get("content-security-policy"), /default-src 'none'/, "everything else stays closed");
  for (const p of ["/favicon.svg", "/icon-192.png", "/apple-touch-icon.png", "/auth/icon-192.png"]) assert.notEqual((await call(env, p)).status, 200, p + " is not served without signing in");
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
  assert.equal(page.status, 200); assert.match(await page.text(), /Dive Manager/);
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

test("imported dives (another computer): stored with their samples, listed with device, validated, capped", async () => {
  const env = makeEnv(); const { cookie: me } = await googleSession(env); const { cookie: other } = await googleSession(env, { email: "other@example.com" });
  const extra = JSON.stringify({ n: 7, t: 28.5, iv: 10, s: [[0, 0, 29], [10, 5.5, 28.5], [20, 12.1, 28.5]] });
  const imp = (o = {}) => ({ fingerprint: "0123456789ab", device: "peregrine", startedAt: "2026-05-02T09:30:00", mode: "scuba", durationSec: 2700, maxDepthM: 28.4, o2Percent: 32, headerHex: "", profileHex: "", extra, ...o });
  const send = (cookie, body, h = {}) => post(env, "/api/dives", body, { cookie, ...h });
  assert.equal((await (await send(me, { dives: [imp()] })).json()).stored, 1);
  const row = (await (await call(env, "/api/dives", { headers: { cookie: me } })).json()).dives[0];
  assert.equal(row.device, "peregrine"); assert.equal(row.extra, extra); assert.equal(row.maxDepthM, 28.4); assert.equal(row.headerHex, "");
  assert.equal((await (await send(me, { dives: [imp()] })).json()).stored, 0, "re-importing the same dive adds nothing");
  assert.equal((await (await call(env, "/api/dives", { headers: { cookie: other } })).json()).dives.length, 0, "private");
  // a Cosmiq dive still comes back as device 'cosmiq' with no extra
  await send(me, { dives: [{ fingerprint: "aaaaaaaaaaaa", headerHex: "00".repeat(36), profileHex: "", startedAt: "2025-03-14T09:30:00" }] });
  const rows = (await (await call(env, "/api/dives", { headers: { cookie: me } })).json()).dives, cosmiq = rows.find((r) => r.fingerprint === "aaaaaaaaaaaa");
  assert.equal(cosmiq.device, "cosmiq"); assert.equal(cosmiq.extra, null);
  for (const [name, d] of [["unknown device", imp({ device: "evil", fingerprint: "111111111111" })], ["no extra", imp({ fingerprint: "111111111111", extra: undefined })], ["extra not an object", imp({ fingerprint: "111111111111", extra: "[1,2]" })],
    ["extra too big", imp({ fingerprint: "111111111111", extra: '{"s":"' + "x".repeat(120_000) + '"}' })], ["extra not text", imp({ fingerprint: "111111111111", extra: { s: [] } })], ["bad start", imp({ fingerprint: "111111111111", startedAt: "yesterday" })],
    ["start with a zone", imp({ fingerprint: "111111111111", startedAt: "2026-05-02T09:30:00Z" })], ["bad mode", imp({ fingerprint: "111111111111", mode: "rebreather" })], ["negative depth", imp({ fingerprint: "111111111111", maxDepthM: -3 })],
    ["absurd depth", imp({ fingerprint: "111111111111", maxDepthM: 9000 })], ["text duration", imp({ fingerprint: "111111111111", durationSec: "long" })], ["raw bytes on an import", imp({ fingerprint: "111111111111", headerHex: "00".repeat(36) })],
    ["bad fingerprint", imp({ fingerprint: "../../../" })]])
    assert.equal((await send(me, { dives: [d] })).status, 400, name);
  assert.equal((await send(me, { dives: [imp({ fingerprint: "222222222222", location: "x".repeat(61) })] })).status, 400, "location still validated");
  assert.equal((await send(me, { dives: [imp({ fingerprint: "222222222222" })] }, { origin: "https://evil.example" })).status, 403, "cross-origin");
  assert.equal((await call(env, "/api/dives", { method: "POST", headers: { cookie: me, "content-type": "application/json", "content-length": "800000" }, body: JSON.stringify({ dives: [] }) })).status, 413, "oversized request refused before parsing");
  // the dive location API works for imported dives too
  assert.deepEqual(await (await post(env, "/api/dives/location", { items: [{ fingerprint: "0123456789ab", location: "Banda" }] }, { cookie: me })).json(), { updated: 1 });
});

test("old address: redirects to the new one only when CANONICAL_HOST is set", async () => {
  const { default: worker } = await import("../src/worker.js");
  const at = (host, env, path = "/api/dives?x=1", init = {}) => worker.fetch(new Request("https://" + host + path, init), env);
  assert.notEqual((await at("old.example.org", makeEnv())).status, 307, "no redirect while the setting is empty");
  const env = makeEnv({ CANONICAL_HOST: "new.example.org", LEGACY_HOSTS: "other.example.org, old.example.org" });
  const r = await at("old.example.org", env); assert.equal(r.status, 307); assert.equal(r.headers.get("location"), "https://new.example.org/api/dives?x=1", "path and query are kept");
  assert.equal((await at("old.example.org", env, "/api/dives", { method: "POST", body: "{}" })).status, 307, "the method is kept (307, not 301/302)");
  assert.notEqual((await at("new.example.org", env, "/auth/login")).status, 307, "the new host is not redirected to itself");
  assert.notEqual((await at("unlisted.example.org", env, "/auth/login")).status, 307, "only listed hosts are redirected");
});

test("Garmin dives are stored like other imported dives (scuba, gauge, freedive), come back with their device, and the API can filter on them", async () => {
  const env = makeEnv(); const { cookie } = await googleSession(env);
  const extra = JSON.stringify({ n: 57, t: 26, iv: 1, s: [[0, 0, 28], [300, 25.3, 27], [600, 0, 26]] });
  const g = (o) => ({ fingerprint: "a1b2c3d4e5f6", device: "garmin", startedAt: "2025-02-04T09:30:00", mode: "scuba", durationSec: 600, maxDepthM: 25.3, o2Percent: 32, headerHex: "", profileHex: "", extra, ...o });
  const send = (body) => post(env, "/api/dives", body, { cookie });
  assert.equal((await (await send({ dives: [g(), g({ fingerprint: "a1b2c3d4e5f7", mode: "gauge", o2Percent: null }), g({ fingerprint: "a1b2c3d4e5f8", mode: "freedive", o2Percent: null })] })).json()).stored, 3);
  const rows = (await (await call(env, "/api/dives", { headers: { cookie } })).json()).dives;
  assert.deepEqual(rows.map((r) => [r.device, r.mode]).sort(), [["garmin", "freedive"], ["garmin", "gauge"], ["garmin", "scuba"]]);
  assert.equal((await send({ dives: [g({ fingerprint: "a1b2c3d4e5f9", device: "suunto" })] })).status, 400, "other devices are still refused");
});

test("the Bluetooth lab page is private like the rest of the app, and is served as a page with its script", async () => {
  const env = makeEnv(); const { cookie } = await googleSession(env);
  const anon = await call(env, "/bluetooth-lab.html", html); assert.notEqual(anon.status, 200, "not served without signing in");
  const page = await call(env, "/bluetooth-lab.html", { headers: { cookie, accept: "text/html" } });
  assert.equal(page.status, 200); assert.match(page.headers.get("content-type"), /text\/html/); const body = await page.text(); assert.match(body, /Bluetooth lab/); assert.match(body, /bluetooth-lab\.js/);
  const js = await call(env, "/bluetooth-lab.js", { headers: { cookie } }); assert.equal(js.status, 200); assert.match(js.headers.get("content-type"), /javascript/); assert.match(await js.text(), /requestLEScan/);
});

test("Bluetooth reports: saved to your own account, listed, read back, deleted; private; size and kind checked; only the newest 30 kept", async () => {
  const env = makeEnv(); const { cookie: me } = await googleSession(env); const { cookie: other } = await googleSession(env, { email: "other@example.com" });
  const send = (cookie, o) => post(env, "/api/bt-reports", o, { cookie }), get = (cookie, p = "") => call(env, "/api/bt-reports" + p, { headers: { cookie } });
  assert.equal((await call(env, "/api/bt-reports")).status, 401, "signed-out requests are refused");
  const r1 = await send(me, { kind: "lab", body: "== Browser ==\nWeb Bluetooth: available\n== Shearwater handshake ==\n{\"serial\":\"12345678\"}" }); assert.equal(r1.status, 201); const id1 = (await r1.json()).id; assert.ok(id1 > 0);
  const id2 = (await (await send(me, { kind: "download", body: "=== Download: Peregrine ===\nResult: FAILED - timeout" })).json()).id;
  const list = await (await get(me)).json(); assert.deepEqual(list.reports.map((r) => [r.id, r.kind]), [[id2, "download"], [id1, "lab"]], "newest first"); assert.ok(list.reports.every((r) => r.size > 10 && !("body" in r)), "the list has sizes, not the texts");
  const one = (await (await get(me, "/" + id1)).json()).report; assert.equal(one.kind, "lab"); assert.match(one.body, /Web Bluetooth: available/);
  assert.equal((await get(other, "/" + id1)).status, 404, "another person cannot read it"); assert.equal((await (await get(other)).json()).reports.length, 0); assert.equal((await call(env, "/api/bt-reports/" + id1, { method: "DELETE", headers: { cookie: other } })).status, 404, "nor delete it");
  for (const [name, body] of [["unknown kind", { kind: "evil", body: "x" }], ["no body", { kind: "lab" }], ["empty body", { kind: "lab", body: "   " }], ["body not text", { kind: "lab", body: { a: 1 } }]]) assert.equal((await send(me, body)).status, 400, name);
  assert.equal((await send(me, { kind: "lab", body: "x".repeat(200_001) })).status, 413, "too long"); assert.equal((await send(me, { kind: "lab", body: "x".repeat(200_000) })).status, 201, "exactly the limit is fine");
  assert.equal((await post(env, "/api/bt-reports", { kind: "lab", body: "x" }, { cookie: me, origin: "https://evil.example" })).status, 403, "cross-site posts are refused");
  assert.equal((await call(env, "/api/bt-reports/" + id1, { method: "DELETE", headers: { cookie: me } })).status, 200); assert.equal((await get(me, "/" + id1)).status, 404);
  for (let i = 0; i < 34; i++) await send(me, { kind: "download", body: "run " + i });
  const kept = (await (await get(me)).json()).reports; assert.equal(kept.length, 30, "only the newest 30 are kept"); assert.equal((await get(me, "/" + id2)).status, 404, "the oldest were dropped");
});

test("sharing a dive log: you copy your OWN dives into the other person's account; only on the allow-list; idempotent; labelled; removable; nothing leaks or bounces back", async () => {
  const env = makeEnv(); const { cookie: me } = await googleSession(env); const { cookie: other } = await googleSession(env, { email: "other@example.com" });
  const send = (cookie, dives) => post(env, "/api/dives", { dives }, { cookie }), api = (cookie, path, body) => body === undefined ? call(env, path, { headers: { cookie } }) : post(env, path, body, { cookie }), list = async (cookie) => (await (await call(env, "/api/dives", { headers: { cookie } })).json()).dives;
  const imp = (device, fp, startedAt, extra = {}) => ({ fingerprint: fp, device, startedAt, mode: "scuba", durationSec: 2400, maxDepthM: 18, o2Percent: 32, headerHex: "", profileHex: "", extra: JSON.stringify({ n: 1, t: 27, iv: 10, s: [[0, 0, 28]] }), ...extra });
  const raw = { fingerprint: "aaaaaaaaaaaa", headerHex: "00".repeat(36), profileHex: "ab".repeat(40), startedAt: "2021-06-11T14:10:00", location: "Tulamben" };
  await send(me, [raw, imp("peregrine", "bbbbbbbbbbbb", "2022-05-05T10:03:00"), imp("peregrine", "cccccccccccc", "2025-03-14T09:00:00", { location: "Komodo" })]); await send(other, [imp("garmin", "dddddddddddd", "2025-03-14T09:05:00")]);
  assert.equal((await call(env, "/api/share")).status, 401, "signed out: refused");
  // who can I share with, and what has been shared with me
  const info = await (await api(me, "/api/share")).json(); assert.deepEqual(info, { targets: ["other@example.com"], received: [] });
  // preview: only MY dives, by year, nothing from the other account
  const pv = await (await api(me, "/api/share/preview", { to: "other@example.com" })).json(); assert.deepEqual(pv, { total: 3, byYear: [{ year: "2021", count: 1 }, { year: "2022", count: 1 }, { year: "2025", count: 1 }] });
  assert.deepEqual(await (await api(me, "/api/share/preview", { to: "other@example.com", from: "2025-01-01" })).json(), { total: 1, byYear: [{ year: "2025", count: 1 }] }, "a start date");
  assert.deepEqual((await (await api(me, "/api/share/preview", { to: "other@example.com", from: "2022-01-01", until: "2022-12-31" })).json()).total, 1, "a date range");
  // rules: another person on the allow-list, real dates
  for (const [name, body] of [["yourself", { to: "me@example.com" }], ["someone not allowed", { to: "stranger@example.com" }], ["nobody", {}], ["bad date", { to: "other@example.com", from: "2025-13-40" }], ["dates the wrong way round", { to: "other@example.com", from: "2025-06-01", until: "2025-01-01" }], ["text date", { to: "other@example.com", from: "last year" }]])
    for (const p of ["/api/share/preview", "/api/share/copy"]) assert.equal((await api(me, p, body)).status, 400, name + " " + p);
  assert.equal((await call(env, "/api/share/copy", { method: "POST", headers: { cookie: me, "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ to: "other@example.com" }) })).status, 403, "cross-site posts are refused");
  // copy from 2022 on: the 2021 Cosmiq+ dive stays behind
  const c1 = await (await api(me, "/api/share/copy", { to: "other@example.com", from: "2022-01-01" })).json(); assert.equal(c1.copied, 2);
  const theirs = await list(other); assert.equal(theirs.length, 3, "her own Garmin dive plus the two copies");
  const copy = theirs.find((d) => d.fingerprint === "cccccccccccc"); assert.equal(copy.sharedFrom, "me@example.com"); assert.equal(copy.device, "peregrine"); assert.equal(copy.location, "Komodo"); assert.equal(copy.startedAt, "2025-03-14T09:00:00"); assert.ok(JSON.parse(copy.extra).s, "the depth samples came along");
  assert.equal(theirs.find((d) => d.fingerprint === "dddddddddddd").sharedFrom, "", "her own dive is not marked"); assert.ok(!theirs.some((d) => d.fingerprint === "aaaaaaaaaaaa"), "the dive before the start date was not copied");
  assert.ok((await list(me)).every((d) => d.sharedFrom === ""), "my own rows are untouched"); assert.equal((await list(me)).length, 3);
  // again: only what is new is added (here: everything else, now without a start date)
  assert.equal((await (await api(me, "/api/share/copy", { to: "other@example.com", from: "2022-01-01" })).json()).copied, 0, "idempotent"); assert.equal((await (await api(me, "/api/share/copy", { to: "other@example.com" })).json()).copied, 1, "the 2021 dive is added now, the rest skipped");
  const raw2 = (await list(other)).find((d) => d.fingerprint === "aaaaaaaaaaaa"); assert.equal(raw2.headerHex, "00".repeat(36)); assert.equal(raw2.profileHex, "ab".repeat(40), "a Cosmiq+ dive keeps its raw bytes"); assert.equal(raw2.location, "Tulamben");
  // what she sees about it, and that nothing bounces back: sharing from her side copies only HER own dives
  const info2 = await (await api(other, "/api/share")).json(); assert.deepEqual(info2.targets, ["me@example.com"]); assert.deepEqual(info2.received.map((r) => [r.from, r.count, r.first, r.last]), [["me@example.com", 3, "2021-06-11T14:10:00", "2025-03-14T09:00:00"]]);
  assert.equal((await (await api(other, "/api/share/preview", { to: "me@example.com" })).json()).total, 1, "only her own Garmin dive, not the three copies");
  assert.equal((await (await api(other, "/api/share/copy", { to: "me@example.com" })).json()).copied, 1); assert.equal((await list(me)).filter((d) => d.sharedFrom === "other@example.com").length, 1); assert.equal((await list(me)).filter((d) => d.sharedFrom === "me@example.com").length, 0, "my own dives did not come back marked as shared");
  // she can remove what was shared with her, and only that
  assert.equal((await api(other, "/api/share/remove", { from: "other@example.com" })).status, 400, "not from yourself"); assert.equal((await api(other, "/api/share/remove", {})).status, 400);
  assert.equal((await (await api(other, "/api/share/remove", { from: "me@example.com" })).json()).removed, 3); const left = await list(other); assert.deepEqual(left.map((d) => d.fingerprint), ["dddddddddddd"], "her own dive stays"); assert.equal((await list(me)).filter((d) => d.sharedFrom === "").length, 3, "and my own dives were not touched");
  assert.equal((await (await api(me, "/api/share/copy", { to: "other@example.com" })).json()).copied, 3, "after a removal the dives can be shared again");
});
