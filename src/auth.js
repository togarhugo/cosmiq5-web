// Google sign-in inside the Worker (authorization-code flow + PKCE), signed session cookie.
// Same pattern as the other thmlab apps. Fails closed when anything is unconfigured.

const enc = new TextEncoder(), dec = new TextDecoder();
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
export const SESSION_COOKIE = "dc_session", OAUTH_COOKIE = "dc_oauth", MFA_COOKIE = "dc_mfa";
export const MFA_SECONDS = 300;
const SESSION_SECONDS = 30 * 24 * 3600;

const now = () => Math.floor(Date.now() / 1000);
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const rand = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const hmacKey = (secret) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

export async function sign(payload, secret) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  return body + "." + b64u(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
}
export async function verifySigned(token, secret) {
  try {
    const [body, sig] = String(token).split(".");
    if (!body || !sig) return null;
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64u(sig), enc.encode(body)))) return null;
    const p = JSON.parse(dec.decode(unb64u(body)));
    return p.exp > now() ? p : null;
  } catch { return null; }
}

const cookieAttrs = (maxAge, path) => `Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const setCookie = (n, v, maxAge, path) => `${n}=${v}; ${cookieAttrs(maxAge, path)}`;
const clearCookie = (n, path) => `${n}=; ${cookieAttrs(0, path)}`;
export function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
function redirect(location, cookies = []) {
  const h = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(null, { status: 302, headers: h });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function page(title, message, cookies = [], status = 400) {
  const h = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:0 20px;text-align:center"><h2>${esc(title)}</h2><p>${esc(message)}</p>
<p><a href="/auth/login" style="display:inline-block;padding:12px 20px;background:#007bff;color:#fff;border-radius:8px;text-decoration:none">Sign in with Google</a></p>`, { status, headers: h });
}

export const allowedEmails = (env) => String(env.ALLOWED_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

/** Returns an error string if the Worker is not fully configured (fail closed). */
export function configError(env) {
  const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SESSION_SECRET", "ALLOWED_EMAILS", "DATA_KEY"]
    .filter((k) => !String(env[k] || "").trim() || String(env[k]).startsWith("REPLACE"));
  if (missing.length) return "Not configured: " + missing.join(", ");
  if (String(env.SESSION_SECRET).trim().length < 32) return "SESSION_SECRET must be at least 32 characters";
  if (String(env.DATA_KEY).trim().length < 32) return "DATA_KEY must be at least 32 characters";
  return null;
}

/** The signed-in user's email, or null. */
export async function currentUser(request, env) {
  const p = await verifySigned(readCookie(request, SESSION_COOKIE), env.SESSION_SECRET);
  if (!p || p.typ !== "session" || !allowedEmails(env).includes(p.email)) return null;
  return { email: p.email, name: p.name || "", amr: p.amr || "google" };
}

/** Set-Cookie values that start a session (also clears any pending OAuth / second-step cookies). */
export async function issueSession(env, { email, name, amr }) {
  const session = await sign({ typ: "session", email, name: name || "", amr, exp: now() + SESSION_SECONDS }, env.SESSION_SECRET);
  return [clearCookie(OAUTH_COOKIE, "/auth"), clearCookie(MFA_COOKIE, "/auth"), setCookie(SESSION_COOKIE, session, SESSION_SECONDS, "/")];
}

/** Cookie proving the password step succeeded: valid for 5 minutes, only usable on /auth/mfa. */
export async function issueMfaChallenge(env, email) {
  return setCookie(MFA_COOKIE, await sign({ typ: "mfa", email, exp: now() + MFA_SECONDS }, env.SESSION_SECRET), MFA_SECONDS, "/auth");
}
export const clearMfaChallenge = () => clearCookie(MFA_COOKIE, "/auth");
/** The email whose password was just verified, or null. */
export async function pendingMfaEmail(request, env) {
  const p = await verifySigned(readCookie(request, MFA_COOKIE), env.SESSION_SECRET);
  return p && p.typ === "mfa" && allowedEmails(env).includes(p.email) ? p.email : null;
}

async function startLogin(url, env) {
  const state = rand(), nonce = rand(), verifier = rand(48);
  const challenge = b64u(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + "/auth/callback", response_type: "code",
    scope: "openid email profile", state, nonce, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
  });
  const cookie = await sign({ typ: "oauth", state, nonce, verifier, exp: now() + 600 }, env.SESSION_SECRET);
  return redirect(GOOGLE_AUTH_URL + "?" + params, [setCookie(OAUTH_COOKIE, cookie, 600, "/auth")]);
}

async function finishLogin(request, url, env) {
  const clear = clearCookie(OAUTH_COOKIE, "/auth");
  if (url.searchParams.get("error")) return page("Sign-in cancelled", "Google sign-in was cancelled.", [clear]);
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  const pending = await verifySigned(readCookie(request, OAUTH_COOKIE), env.SESSION_SECRET);
  if (!code || !state || !pending || pending.typ !== "oauth" || pending.state !== state)
    return page("Sign-in expired", "Please try again.", [clear]);
  let tokens;
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: url.origin + "/auth/callback", grant_type: "authorization_code", code_verifier: pending.verifier }) });
    tokens = await res.json();
    if (!res.ok || !tokens.id_token) return page("Google rejected the sign-in", String(tokens.error || res.status), [clear]);
  } catch { return page("Could not reach Google", "Please try again.", [clear], 502); }
  // The ID token comes straight from Google's token endpoint over TLS, so claims are validated
  // (OIDC Core 3.1.3.7) rather than re-verifying the signature.
  let claims;
  try { claims = JSON.parse(dec.decode(unb64u(tokens.id_token.split(".")[1]))); }
  catch { return page("Sign-in failed", "Unreadable ID token.", [clear]); }
  if (!GOOGLE_ISSUERS.includes(claims.iss) || claims.aud !== env.GOOGLE_CLIENT_ID || !(claims.exp > now()) || claims.nonce !== pending.nonce)
    return page("Sign-in failed", "The Google ID token failed validation.", [clear]);
  const email = String(claims.email || "").toLowerCase();
  if (!email || claims.email_verified !== true) return page("Sign-in failed", "Your Google email is not verified.", [clear]);
  if (!allowedEmails(env).includes(email)) return page("Access denied", `${email} is not allowed to use this app.`, [clear], 403);
  return redirect("/", await issueSession(env, { email, name: claims.name, amr: "google" }));
}

const PUBLIC_ASSET = /^\/auth\/(favicon\.svg|apple-touch-icon\.png|theme\.(js|css)|fonts\.css|logo-(light|dark)\.png|icon-(summary|log|import|cert|device)\.png|fonts\/[A-Za-z-]+\.(woff2|txt))$/;
const LOGIN_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Handles the GET /auth/* routes; returns a Response, or null if the path is not one of them.
 *  (POST /auth/prelogin and /auth/password are handled in password.js.) */
export async function handleAuth(request, url, env, serveAsset) {
  if (!url.pathname.startsWith("/auth/") || request.method === "POST") return null;
  if (PUBLIC_ASSET.test(url.pathname)) return serveAsset(request, url.pathname);              // the look of the app (icons, logos, theme, fonts) is public: the sign-in pages use it too
  switch (url.pathname) {
    case "/auth/login": {                       // the first page: choose Google or email + password + authenticator
      if (await currentUser(request, env)) return redirect("/");
      const r = serveAsset(request, "/auth/login.html"); r.headers.set("content-security-policy", LOGIN_CSP); return r;
    }
    case "/auth/mfa": {                         // step 2: six boxes for the authenticator code
      if (await currentUser(request, env)) return redirect("/");
      if (!(await pendingMfaEmail(request, env))) return redirect("/auth/login");
      const r = serveAsset(request, "/auth/mfa.html"); r.headers.set("content-security-policy", LOGIN_CSP); return r;
    }
    case "/auth/login.js": case "/auth/mfa.js": case "/auth/kdf.js": return serveAsset(request, url.pathname);     // the sign-in pages show the app icon too
    case "/auth/google": return startLogin(url, env);
    case "/auth/callback": return finishLogin(request, url, env);
    case "/auth/logout": return page("Signed out", "You have been signed out.", [clearCookie(SESSION_COOKIE, "/")], 200);
    default: return page("Not found", "Unknown page.", [], 404);
  }
}
