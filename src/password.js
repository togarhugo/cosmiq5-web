// Email + password + authenticator (TOTP) sign-in.
//  - The browser stretches the password (PBKDF2, see public/auth/kdf.js); the server never sees it
//    and only stores HMAC(pepper, derivedKey), so verifying a login costs almost no CPU (free plan).
//  - Login is two steps: (1) email + password -> a short-lived signed "password ok" cookie, then
//    (2) the 6-digit authenticator code on its own page -> the session. Failures in both steps count
//    towards the same lockout.
//  - Accounts can only be created from an already signed-in session (no open sign-up).
import { allowedEmails, issueMfaChallenge, issueSession, pendingMfaEmail } from "./auth.js";
import { base32Decode, base32Encode, otpauthUri, verifyTotp } from "./totp.js";

const enc = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
export const kdfIter = (env) => Number(env.KDF_ITER) || 600000;
const GENERIC = "Invalid email or password.";
const LOCKED = "Too many failed attempts. Try again in 15 minutes.";
const MAX_FAILS_EMAIL = 5, MAX_FAILS_IP = 20, LOCK_SECONDS = 900;

// ---- keyed helpers --------------------------------------------------------------------------
async function pepper(env) {
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode("pepper|" + env.DATA_KEY)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
const mac = async (env, text) => hex(await crypto.subtle.sign("HMAC", await pepper(env), enc.encode(text)));
const hashPw = (env, email, key) => mac(env, `pw|${email}|${key}`);
const fakeSalt = async (env, email) => (await mac(env, "fake-salt|" + email)).slice(0, 32);
function safeEqual(a, b) { // constant-time for equal-length strings
  if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}
async function aesKey(env) { return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode("totp|" + env.DATA_KEY)), "AES-GCM", false, ["encrypt", "decrypt"]); }
async function encryptSecret(env, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return hex(out);
}
async function decryptSecret(env, h) {
  const b = Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, await aesKey(env), b.slice(12)));
}

// ---- lockout --------------------------------------------------------------------------------
async function attemptKeys(request, email, scope = "e") {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const h = hex(await crypto.subtle.digest("SHA-256", enc.encode(email))).slice(0, 32);
  return [{ k: `${scope}:${h}`, max: MAX_FAILS_EMAIL }, { k: "i:" + ip, max: MAX_FAILS_IP }];
}
async function isLocked(env, keys) {
  for (const { k } of keys) { const r = await env.DB.prepare("SELECT until FROM auth_attempts WHERE k = ?").bind(k).first(); if (r && r.until > now()) return true; }
  return false;
}
async function recordFailure(env, keys) {
  for (const { k, max } of keys) {
    const r = await env.DB.prepare("SELECT n, updated FROM auth_attempts WHERE k = ?").bind(k).first();
    const n = r && now() - r.updated < LOCK_SECONDS ? r.n + 1 : 1;
    await env.DB.prepare("INSERT OR REPLACE INTO auth_attempts (k, n, until, updated) VALUES (?,?,?,?)").bind(k, n, n >= max ? now() + LOCK_SECONDS : 0, now()).run();
  }
}
const clearFailures = (env, keys) => env.DB.prepare("DELETE FROM auth_attempts WHERE k = ?").bind(keys[0].k).run();

// ---- request parsing ------------------------------------------------------------------------
async function body(request) { try { const b = await request.json(); return b && typeof b === "object" ? b : null; } catch { return null; } }
const validEmail = (e) => typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(e);
const validKey = (k) => typeof k === "string" && /^[0-9a-f]{64}$/.test(k);
const validSalt = (s) => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);

// ---- public endpoints: /auth/prelogin, /auth/password ----------------------------------------
export async function handlePasswordAuth(request, url, env) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (url.pathname === "/auth/mfa") return handleMfa(request, env);
  const b = await body(request);
  if (!b || !validEmail(b.email)) return json({ error: "bad request" }, 400);
  const email = b.email.trim().toLowerCase();

  if (url.pathname === "/auth/prelogin") {   // tells the browser which salt/iterations to use; same shape for unknown emails
    const u = allowedEmails(env).includes(email) ? await env.DB.prepare("SELECT salt, kdf_iter FROM users WHERE email = ?").bind(email).first() : null;
    return json({ salt: u ? u.salt : await fakeSalt(env, email), iter: u ? u.kdf_iter : kdfIter(env) });
  }

  // /auth/password (step 1)
  if (!validKey(b.key)) return json({ error: GENERIC }, 401);
  const keys = await attemptKeys(request, email);
  if (await isLocked(env, keys)) return json({ error: LOCKED }, 429);
  const allowed = allowedEmails(env).includes(email);
  const u = allowed ? await env.DB.prepare("SELECT pw_hash FROM users WHERE email = ?").bind(email).first() : null;
  const pwOk = safeEqual(await hashPw(env, email, b.key), u ? u.pw_hash : await mac(env, "dummy|" + email));
  if (!(u && pwOk)) { await recordFailure(env, keys); return json({ error: GENERIC }, 401); }
  const h = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  h.append("set-cookie", await issueMfaChallenge(env, email));
  return new Response(JSON.stringify({ next: "/auth/mfa" }), { headers: h });
}

// ---- public endpoint: POST /auth/mfa (step 2) ---------------------------------------------------
export async function handleMfa(request, env) {
  const b = await body(request);
  const email = await pendingMfaEmail(request, env);
  if (!email) return json({ error: "Your sign-in expired. Please start again.", restart: true }, 401);
  if (!b || !/^\d{6}$/.test(String(b.code))) return json({ error: "Enter all 6 digits." }, 400);
  const keys = await attemptKeys(request, email);
  if (await isLocked(env, keys)) return json({ error: LOCKED }, 429);
  const u = await env.DB.prepare("SELECT totp_secret_enc, totp_last_step FROM users WHERE email = ?").bind(email).first();
  let step = null;
  if (u) { try { step = await verifyTotp(await decryptSecret(env, u.totp_secret_enc), b.code, u.totp_last_step); } catch { step = null; } }
  if (step === null) { await recordFailure(env, keys); return json({ error: "That code is not valid. Check your authenticator app and try again." }, 401); }
  await env.DB.prepare("UPDATE users SET totp_last_step = ? WHERE email = ?").bind(step, email).run();
  await clearFailures(env, keys);
  const cookies = await issueSession(env, { email, name: "", amr: "pwd+totp" });
  const h = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(JSON.stringify({ ok: true }), { headers: h });
}

// ---- authenticated endpoints: /api/account ---------------------------------------------------
export async function handleAccount(request, url, env, user) {
  const email = user.email;
  const existing = await env.DB.prepare("SELECT totp_secret_enc, totp_last_step FROM users WHERE email = ?").bind(email).first();

  if (url.pathname === "/api/account" && request.method === "GET")
    return json({ email, via: user.amr || "google", google: true, password: !!existing, kdfIter: kdfIter(env) });

  // A missing body is fine (e.g. mfa/start); the endpoints that need fields validate them below.
  const b = request.method === "GET" ? {} : (await body(request)) || {};
  const keys = await attemptKeys(request, email, "a");           // code guesses on account changes are rate limited too
  const checkCode = async (secretEnc, lastStep, code) => {
    if (await isLocked(env, keys)) return { locked: true };
    let step = null; try { step = await verifyTotp(await decryptSecret(env, secretEnc), code, lastStep); } catch {}
    if (step === null) await recordFailure(env, keys);
    return { step };
  };

  if (url.pathname === "/api/account/mfa/start" && request.method === "POST") {
    const secret = crypto.getRandomValues(new Uint8Array(20));
    await env.DB.prepare("INSERT OR REPLACE INTO enrollments (email, secret_enc, expires) VALUES (?,?,?)").bind(email, await encryptSecret(env, secret), now() + 600).run();
    const b32 = base32Encode(secret);
    return json({ secret: b32, uri: otpauthUri(b32, email) });
  }

  if (url.pathname === "/api/account/password" && request.method === "POST") {
    if (!validSalt(b.salt) || !validKey(b.key) || !(Number.isInteger(b.iter) && b.iter >= kdfIter(env) && b.iter <= 2_000_000) || !/^\d{6}$/.test(String(b.code)))
      return json({ error: "bad request" }, 400);
    const pend = await env.DB.prepare("SELECT secret_enc, expires FROM enrollments WHERE email = ?").bind(email).first();
    if (!pend || pend.expires < now()) return json({ error: "Setup expired. Start again." }, 400);
    if (existing) {                                              // changing an existing login needs a current code
      const cur = await checkCode(existing.totp_secret_enc, existing.totp_last_step, b.currentCode);
      if (cur.locked) return json({ error: "Too many failed attempts. Try again in 15 minutes." }, 429);
      if (cur.step === null) return json({ error: "Current authenticator code is wrong." }, 403);
    }
    const nw = await checkCode(pend.secret_enc, 0, b.code);
    if (nw.locked) return json({ error: "Too many failed attempts. Try again in 15 minutes." }, 429);
    if (nw.step === null) return json({ error: "That code is wrong. Check the time on your phone and try again." }, 400);
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO users (email, salt, kdf_iter, pw_hash, totp_secret_enc, totp_last_step) VALUES (?,?,?,?,?,?)")
        .bind(email, b.salt, b.iter, await hashPw(env, email, b.key), pend.secret_enc, nw.step),
      env.DB.prepare("DELETE FROM enrollments WHERE email = ?").bind(email),
    ]);
    return json({ ok: true });
  }

  // Change the password only: needs the CURRENT password and a CURRENT authenticator code, keeps the same authenticator.
  if (url.pathname === "/api/account/password/change" && request.method === "POST") {
    if (!existing) return json({ error: "Email login is not set up yet." }, 400);
    if (!validSalt(b.salt) || !validKey(b.key) || !validKey(b.currentKey) || !(Number.isInteger(b.iter) && b.iter >= kdfIter(env) && b.iter <= 2_000_000) || !/^\d{6}$/.test(String(b.currentCode)))
      return json({ error: "bad request" }, 400);
    if (await isLocked(env, keys)) return json({ error: LOCKED }, 429);
    const u = await env.DB.prepare("SELECT pw_hash, totp_secret_enc, totp_last_step FROM users WHERE email = ?").bind(email).first();
    const pwOk = safeEqual(await hashPw(env, email, b.currentKey), u.pw_hash);
    let step = null; try { step = await verifyTotp(await decryptSecret(env, u.totp_secret_enc), b.currentCode, u.totp_last_step); } catch {}
    if (!(pwOk && step !== null)) { await recordFailure(env, keys); return json({ error: "Your current password or authenticator code is not right." }, 403); }
    await env.DB.prepare("UPDATE users SET salt = ?, kdf_iter = ?, pw_hash = ?, totp_last_step = ? WHERE email = ?").bind(b.salt, b.iter, await hashPw(env, email, b.key), step, email).run();
    await clearFailures(env, keys);
    return json({ ok: true });
  }

  if (url.pathname === "/api/account/password" && request.method === "DELETE") {
    if (!existing) return json({ ok: true });
    const cur = await checkCode(existing.totp_secret_enc, existing.totp_last_step, b.code);
    if (cur.locked) return json({ error: "Too many failed attempts. Try again in 15 minutes." }, 429);
    if (cur.step === null) return json({ error: "Authenticator code is wrong." }, 403);
    await env.DB.prepare("DELETE FROM users WHERE email = ?").bind(email).run();
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}
