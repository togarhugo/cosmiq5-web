// Shared test harness: a real SQLite-backed D1 stand-in, Google stub, sign-in helpers.
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { totpNow } from "./totp-helper.mjs";
export { totpNow };
export const kdf = createRequire(import.meta.url)("../public/auth/kdf.js");

export const ORIGIN = "https://dive.example";
export const base = { GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "gsecret",
  SESSION_SECRET: "s".repeat(48), DATA_KEY: "d".repeat(48), ALLOWED_EMAILS: "Me@Example.com, other@example.com", KDF_ITER: "1000" };

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, a = []) => ({
    bind: (...args) => stmt(sql, args),
    first: async () => db.prepare(sql).get(...a) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...a) }),
    run: async () => { const r = db.prepare(sql).run(...a); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return { prepare: (sql) => stmt(sql), batch: async (sts) => { const o = []; for (const s of sts) o.push(await s.run()); return o; }, raw: db };
}
export const makeEnv = (over = {}) => ({ ...base, DB: makeD1(), ...over });
export const call = (env, path, init = {}) => worker.fetch(new Request(ORIGIN + path, init), env);
export const html = { headers: { accept: "text/html" } };
export const cookieOf = (res, name) => (res.headers.getSetCookie().find((c) => c.startsWith(name + "=")) || "").split(";")[0].slice(name.length + 1);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

// ---- Google sign-in with a stubbed token endpoint -------------------------------------------------
export async function googleSession(env, over = {}) {
  const res = await call(env, "/auth/google");
  const loc = new URL(res.headers.get("location")); const oauth = cookieOf(res, "dc_oauth");
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://oauth2.googleapis.com/token");
    return new Response(JSON.stringify({ id_token: "h." + b64({ iss: "https://accounts.google.com", aud: base.GOOGLE_CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 600, nonce: loc.searchParams.get("nonce"), email: "me@example.com", email_verified: true, name: "Me", ...over }) + ".s" }));
  };
  try {
    const r = await call(env, `/auth/callback?code=c&state=${loc.searchParams.get("state")}`, { headers: { cookie: "dc_oauth=" + oauth } });
    return { res: r, cookie: "dc_session=" + cookieOf(r, "dc_session") };
  } finally { globalThis.fetch = real; }
}

export const post = (env, path, body, headers = {}) => call(env, path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
export const authed = (cookie) => ({ cookie });

/** Full enrollment through the HTTP API, exactly as the Account tab does it. Returns secret + derived key. */
export async function enroll(env, cookie, password = "correct horse battery", email = "me@example.com") {
  const start = await (await post(env, "/api/account/mfa/start", {}, authed(cookie))).json();
  const salt = kdf.randomSalt(), iter = Number(env.KDF_ITER);
  const key = await kdf.deriveKey(password, salt, iter, email);
  const code = await totpNow(start.secret);
  const res = await post(env, "/api/account/password", { salt, iter, key, code }, authed(cookie));
  return { res, secret: start.secret, key, salt, uri: start.uri };
}
/** Step 1: email + password. Returns the raw response (200 sets the dc_mfa challenge cookie). */
export async function loginStep1(env, email, password, extraHeaders = {}) {
  const pre = await (await post(env, "/auth/prelogin", { email })).json();
  const key = await kdf.deriveKey(password, pre.salt, pre.iter, email);
  return post(env, "/auth/password", { email, key }, extraHeaders);
}
export const mfaCookie = (step1) => "dc_mfa=" + cookieOf(step1, "dc_mfa");
/** Step 2: the 6-digit code, sent with the challenge cookie from step 1. */
export const submitCode = (env, step1, code, extraHeaders = {}) => post(env, "/auth/mfa", { code }, { cookie: mfaCookie(step1), ...extraHeaders });
/** Both steps; resolves to the step-1 response if it failed, else the step-2 response (200 = signed in). */
export async function login(env, email, password, code, extraHeaders = {}) {
  const s1 = await loginStep1(env, email, password, extraHeaders);
  return s1.ok ? submitCode(env, s1, code, extraHeaders) : s1;
}
