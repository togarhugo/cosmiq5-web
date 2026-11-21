import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { sign, verifySigned } from "../src/auth.js";
import { VERSION } from "../src/version.js";

const ORIGIN = "https://dive.example";
const base = { GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "gsecret",
  SESSION_SECRET: "x".repeat(48), ALLOWED_EMAILS: "Me@Example.com, other@example.com" };
const calls = [];
const DB = { prepare(sql) { return { bind(...a) { calls.push({ sql, a }); return { all: async () => ({ results: [] }), sql, a }; } }; },
  batch: async (st) => st.map(() => ({ meta: { changes: 1 } })) };
const env = { ...base, DB };
const call = (path, init = {}, e = env) => worker.fetch(new Request(ORIGIN + path, init), e);
const html = { headers: { accept: "text/html" } };
const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(name + "=")) || "").split(";")[0].slice(name.length + 1);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

// ---- sign-in helpers ---------------------------------------------------------
async function beginLogin() {
  const res = await call("/auth/login");
  const loc = new URL(res.headers.get("location"));
  const oauth = cookieOf(res, "dc_oauth");
  return { res, loc, oauth, state: loc.searchParams.get("state"), nonce: loc.searchParams.get("nonce") };
}
function stubGoogle(claimsFn, { status = 200, body } = {}) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(init.body);
    stubGoogle.lastForm = form;
    if (body) return new Response(JSON.stringify(body), { status });
    return new Response(JSON.stringify({ id_token: `h.${b64(claimsFn(form))}.s` }), { status });
  };
  return () => { globalThis.fetch = real; };
}
const goodClaims = (nonce, over = {}) => () => ({ iss: "https://accounts.google.com", aud: base.GOOGLE_CLIENT_ID,
  exp: Math.floor(Date.now() / 1000) + 600, nonce, email: "me@example.com", email_verified: true, name: "Me", ...over });
async function callback(l, { state = l.state, oauth = l.oauth, code = "abc" } = {}) {
  return call(`/auth/callback?code=${code}&state=${state}`, { headers: { cookie: oauth ? "dc_oauth=" + oauth : "" } });
}
async function signIn(over) {
  const l = await beginLogin(); const restore = stubGoogle(goodClaims(l.nonce, over));
  try { return { res: await callback(l), l }; } finally { restore(); }
}
async function sessionCookie() { const { res } = await signIn(); return "dc_session=" + cookieOf(res, "dc_session"); }

// ---- tests -------------------------------------------------------------------
test("fails closed (503) until configured, for pages and API", async () => {
  for (const key of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET", "ALLOWED_EMAILS"]) {
    const r = await call("/", html, { ...env, [key]: "" }); assert.equal(r.status, 503, key);
  }
  assert.equal((await call("/api/me", {}, { ...env, SESSION_SECRET: "short" })).status, 503);
  assert.equal((await call("/", html, { ...env, GOOGLE_CLIENT_ID: "REPLACE_ME" })).status, 503);
});

test("signed-out visitors: pages redirect to Google sign-in, API and POST get 401", async () => {
  const p = await call("/", html); assert.equal(p.status, 302); assert.equal(new URL(p.headers.get("location")).pathname, "/auth/login");
  assert.equal((await call("/api/dives")).status, 401);
  assert.equal((await call("/api/me")).status, 401);
  assert.equal((await call("/api/dives", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await call("/icon-192.png")).status, 401);
});

test("login redirects to Google with PKCE, state and nonce; oauth cookie is httpOnly/secure", async () => {
  const { res, loc, oauth } = await beginLogin();
  assert.equal(res.status, 302); assert.equal(loc.origin + loc.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(loc.searchParams.get("client_id"), base.GOOGLE_CLIENT_ID);
  assert.equal(loc.searchParams.get("redirect_uri"), ORIGIN + "/auth/callback");
  assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
  const payload = await verifySigned(oauth, base.SESSION_SECRET);
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload.verifier))).toString("base64url");
  assert.equal(loc.searchParams.get("code_challenge"), digest, "challenge = S256(verifier)");
  const sc = res.headers.getSetCookie().find((c) => c.startsWith("dc_oauth="));
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Lax/);
});

test("full sign-in: session works, app + assets served, version exposed, PKCE verifier sent to Google", async () => {
  const { res, l } = await signIn();
  assert.equal(res.status, 302); assert.equal(res.headers.get("location"), "/");
  assert.equal(stubGoogle.lastForm.get("code_verifier"), (await verifySigned(l.oauth, base.SESSION_SECRET)).verifier);
  assert.equal(stubGoogle.lastForm.get("client_secret"), "gsecret");
  const sc = res.headers.getSetCookie().find((c) => c.startsWith("dc_session="));
  assert.match(sc, /HttpOnly; Secure|Secure; SameSite|HttpOnly/); assert.match(sc, /Max-Age=2592000/);
  const cookie = "dc_session=" + cookieOf(res, "dc_session");
  const me = await (await call("/api/me", { headers: { cookie } })).json();
  assert.deepEqual(me, { email: "me@example.com", name: "Me", version: VERSION });
  const page = await call("/", { headers: { cookie, accept: "text/html" } });
  assert.equal(page.status, 200); assert.match(await page.text(), /Cosmiq Manager/);
  assert.equal(page.headers.get("x-app-version"), VERSION);
  const png = await call("/icon-192.png", { headers: { cookie } });
  assert.equal(new Uint8Array(await png.arrayBuffer())[1], 0x50, "PNG intact");
  assert.equal((await call("/version.js", { headers: { cookie } })).status, 200);
  assert.equal((await call("/nope", { headers: { cookie } })).status, 404);
});

test("sign-in is rejected for: bad state, missing/tampered oauth cookie, wrong account, unverified email, bad nonce/aud/iss/expired token, Google error", async () => {
  const l = await beginLogin();
  // These must be refused BEFORE Google is contacted at all (a counter proves it).
  const real = globalThis.fetch; let googleCalls = 0;
  globalThis.fetch = async () => { googleCalls++; throw new Error("Google must not be called"); };
  try {
    const expired = await sign({ typ: "oauth", state: l.state, nonce: l.nonce, verifier: "v", exp: 1 }, base.SESSION_SECRET);
    for (const [name, r] of [["bad state", await callback(l, { state: "evil" })], ["no oauth cookie", await callback(l, { oauth: "" })],
      ["tampered cookie", await callback(l, { oauth: l.oauth.slice(0, -2) + "xx" })], ["expired oauth cookie", await callback(l, { oauth: expired })],
      ["no code", await call(`/auth/callback?state=${l.state}`, { headers: { cookie: "dc_oauth=" + l.oauth } })]]) {
      assert.equal(r.status, 400, name); assert.match(await r.text(), /Sign-in expired/, name);
    }
  } finally { globalThis.fetch = real; }
  assert.equal(googleCalls, 0, "Google was contacted for an invalid callback");
  const cases = [["stranger@evil.com", { email: "stranger@evil.com" }, 403], ["unverified", { email_verified: false }, 400],
    ["nonce", { nonce: "other" }, 400], ["aud", { aud: "other-client" }, 400], ["iss", { iss: "https://evil.com" }, 400], ["expired token", { exp: 1 }, 400]];
  for (const [name, over, status] of cases) {
    const lg = await beginLogin(); const restore = stubGoogle(goodClaims(lg.nonce, over));
    try { const r = await callback(lg); assert.equal(r.status, status, name); assert.ok(!cookieOf(r, "dc_session"), name + ": no session cookie"); }
    finally { restore(); }
  }
  const restore = stubGoogle(null, { status: 400, body: { error: "invalid_grant" } });
  try { assert.equal((await callback(await beginLogin())).status, 400); } finally { restore(); }
  assert.equal((await call("/auth/callback?error=access_denied")).status, 400);
});

test("forged, tampered, expired sessions and de-listed users are rejected", async () => {
  const good = await sessionCookie();
  assert.equal((await call("/api/me", { headers: { cookie: good } })).status, 200);
  assert.equal((await call("/api/me", { headers: { cookie: good.slice(0, -3) + "AAA" } })).status, 401, "tampered");
  const forged = "dc_session=" + (await sign({ typ: "session", email: "me@example.com", exp: 9e9 }, "y".repeat(48)));
  assert.equal((await call("/api/me", { headers: { cookie: forged } })).status, 401, "signed with other key");
  const expired = "dc_session=" + (await sign({ typ: "session", email: "me@example.com", exp: 1 }, base.SESSION_SECRET));
  assert.equal((await call("/api/me", { headers: { cookie: expired } })).status, 401, "expired");
  const wrongType = "dc_session=" + (await sign({ typ: "oauth", email: "me@example.com", exp: 9e9 }, base.SESSION_SECRET));
  assert.equal((await call("/api/me", { headers: { cookie: wrongType } })).status, 401, "oauth cookie can't be used as session");
  assert.equal((await call("/api/me", { headers: { cookie: good } }, { ...env, ALLOWED_EMAILS: "someone@else.com" })).status, 401, "removed from allow-list");
});

test("dive API: scoped to the signed-in user, validates input, refuses cross-origin writes", async () => {
  const cookie = await sessionCookie();
  calls.length = 0;
  assert.equal((await call("/api/dives", { headers: { cookie } })).status, 200);
  assert.deepEqual(calls.at(-1).a, ["me@example.com"], "query scoped to user");
  const dive = { fingerprint: "e90903091e00", headerHex: "00".repeat(36), profileHex: "0102", startedAt: "2025-03-14T09:30:00" };
  const post = (body, hdr = {}) => call("/api/dives", { method: "POST", headers: { cookie, "content-type": "application/json", ...hdr }, body: JSON.stringify(body) });
  assert.equal((await post({ dives: [dive] }, { origin: ORIGIN })).status, 200);
  assert.equal((await post({ dives: [dive] }, { origin: "https://evil.example" })).status, 403, "cross-origin");
  assert.equal((await post({ dives: [{ ...dive, headerHex: "zz" }] })).status, 400, "invalid dive");
  assert.equal((await post({ dives: [{ ...dive, fingerprint: "../../" }] })).status, 400);
  assert.equal((await post({ dives: Array(51).fill(dive) })).status, 413);
  assert.deepEqual(calls.filter((c) => c.sql.startsWith("INSERT")).every((c) => c.a[0] === "me@example.com"), true);
});

test("logout clears the session cookie", async () => {
  const r = await call("/auth/logout");
  assert.equal(r.status, 200);
  assert.match(r.headers.getSetCookie().find((c) => c.startsWith("dc_session=")), /Max-Age=0/);
});
