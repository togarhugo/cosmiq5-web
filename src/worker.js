import ASSETS from "./assets.generated.js";
import { configError, currentUser, handleAuth } from "./auth.js";
import { handleAccount, handlePasswordAuth } from "./password.js";
import { handlePlaces } from "./places.js";
import { handleApiV1, handleKeys } from "./apikeys.js";
import { handleAccountData } from "./account-data.js";
import { VERSION } from "./version.js";
import { IMPORTED_DEVICES } from "./devices.js";

// Dive Manager: static app + dive-log API. Sign-in is Google OAuth inside this Worker
// (see auth.js). Everything except /auth/* requires a valid session: fails closed.

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-app-version": VERSION } });

const HEX = /^[0-9a-f]*$/;
/** Dive area label: trimmed, single-spaced, no control characters, at most 60 chars. Returns null for "none", false if invalid. */
function cleanLocation(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || /[\u0000-\u001f\u007f]/.test(v)) return false;
  const t = v.replace(/\s+/g, " ").trim();
  return t.length > 60 ? false : t || null;
}
const STARTED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const MAX_EXTRA_CHARS = 120_000;                     // decoded samples of one imported dive, as JSON text
const num = (v, max) => v === undefined || v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max);
function validDive(d) {
  if (!d || typeof d.fingerprint !== "string" || !/^[0-9a-f]{12}$/.test(d.fingerprint) || typeof d.startedAt !== "string") return false;
  if (d.device !== undefined && d.device !== null && d.device !== "cosmiq") {            // imported dive: decoded values, no raw device bytes
    // The JSON text is stored as is (parsing up to 120 KB per dive would eat the free plan's CPU budget); only the browser reads it back.
    return IMPORTED_DEVICES.includes(d.device) && STARTED.test(d.startedAt) && !d.headerHex && !d.profileHex &&
      typeof d.extra === "string" && d.extra.length <= MAX_EXTRA_CHARS && d.extra.startsWith("{") && d.extra.endsWith("}") &&
      typeof d.mode === "string" && ["scuba", "gauge", "freedive"].includes(d.mode) &&
      num(d.durationSec, 86400) && num(d.maxDepthM, 400) && num(d.o2Percent, 100);
  }
  return typeof d.headerHex === "string" && d.headerHex.length === 72 && HEX.test(d.headerHex) &&
    typeof d.profileHex === "string" && d.profileHex.length <= 400_000 && HEX.test(d.profileHex) && d.profileHex.length % 2 === 0 &&
    d.startedAt.length <= 32;
}

function serveAsset(request, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);
  const a = ASSETS[pathname === "/" ? "/index.html" : pathname];
  if (!a) return json({ error: "not found" }, 404);
  const raw = atob(a.b), bin = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bin[i] = raw.charCodeAt(i);                       // a plain loop: far cheaper than Uint8Array.from(callback) for the 70 KB fonts
  return new Response(request.method === "HEAD" ? null : bin, {
    headers: { "content-type": a.t, "cache-control": pathname.startsWith("/auth/fonts/") ? "public, max-age=31536000, immutable" : "private, no-cache", "x-content-type-options": "nosniff", "x-app-version": VERSION, "x-frame-options": "DENY", "referrer-policy": "no-referrer" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const bad = configError(env);
    if (bad) return json({ error: bad }, 503);

    // Optional move to a new address: when CANONICAL_HOST is set, requests that arrive on a host listed in LEGACY_HOSTS (comma separated)
    // are sent to the same path there. 307 (temporary, keeps the method) so a mistake is never cached for good.
    if (env.CANONICAL_HOST && url.hostname !== env.CANONICAL_HOST && String(env.LEGACY_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean).includes(url.hostname))
      return Response.redirect("https://" + env.CANONICAL_HOST + url.pathname + url.search, 307);

    // The read-only API for other tools: authenticated by a key in a header (never a cookie), so it comes before the cookie checks below.
    if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) return handleApiV1(request, url, env);

    // Same-origin check for every state-changing request (cookies are SameSite=Lax as well).
    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({ error: "cross-origin request refused" }, 403);
    }
    if (request.method === "POST" && (url.pathname === "/auth/prelogin" || url.pathname === "/auth/password" || url.pathname === "/auth/mfa"))
      return handlePasswordAuth(request, url, env);
    const auth = await handleAuth(request, url, env, serveAsset);
    if (auth) return auth;

    const user = await currentUser(request, env);
    if (!user) {
      const wantsPage = request.method === "GET" && (request.headers.get("accept") || "").includes("text/html");
      return wantsPage ? Response.redirect(url.origin + "/auth/login", 302) : json({ error: "not signed in" }, 401);
    }
    const email = user.email;

    if (!url.pathname.startsWith("/api/")) return serveAsset(request, url.pathname);

    if (url.pathname === "/api/me") return json({ email, name: user.name, version: VERSION });
    if (url.pathname === "/api/account" || url.pathname.startsWith("/api/account/")) return handleAccount(request, url, env, user);
    if (url.pathname === "/api/profile" || url.pathname.startsWith("/api/profile/") || url.pathname === "/api/regulator" || url.pathname === "/api/certs" || url.pathname.startsWith("/api/certs/")) {
      const r = await handleAccountData(request, url, env, email);
      if (r) return r;
    }

    if (url.pathname === "/api/places") return handlePlaces(request, url, env, email);
    if (url.pathname === "/api/keys" || url.pathname.startsWith("/api/keys/")) { const r = await handleKeys(request, url, env, email); if (r) return r; }

    // Set (or clear) the dive area of existing dives. Only the signed-in user's own dives can be touched.
    if (url.pathname === "/api/dives/location" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const items = Array.isArray(body.items) ? body.items : [];
      if (items.length > 200) return json({ error: "max 200 dives per request" }, 413);
      if (!items.every((i) => i && typeof i.fingerprint === "string" && /^[0-9a-f]{12}$/.test(i.fingerprint) && cleanLocation(i.location) !== false))
        return json({ error: "invalid location update" }, 400);
      const stmt = env.DB.prepare("UPDATE dives SET location = ? WHERE user_email = ? AND fingerprint = ?");
      const res = await env.DB.batch(items.map((i) => stmt.bind(cleanLocation(i.location), email, i.fingerprint)));
      return json({ updated: res.reduce((n, r) => n + (r.meta.changes || 0), 0) });
    }

    if (url.pathname === "/api/dives" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT fingerprint, device_mac AS deviceMac, started_at AS startedAt, mode, duration_sec AS durationSec, max_depth_m AS maxDepthM, o2_percent AS o2Percent, header_hex AS headerHex, profile_hex AS profileHex, location, device, extra FROM dives WHERE user_email = ? ORDER BY started_at DESC LIMIT 2000"
      ).bind(email).all();
      return json({ dives: results });
    }

    if (url.pathname === "/api/dives" && request.method === "POST") {
      if (Number(request.headers.get("content-length") || 0) > 700_000) return json({ error: "too much data in one request: send fewer dives" }, 413);   // keeps JSON parsing inside the free plan's CPU budget
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const dives = Array.isArray(body.dives) ? body.dives : [];
      if (dives.length > 50) return json({ error: "max 50 dives per request" }, 413);
      if (!dives.every(validDive) || !dives.every((d) => cleanLocation(d.location) !== false)) return json({ error: "invalid dive record" }, 400);
      const stmt = env.DB.prepare(
        "INSERT OR IGNORE INTO dives (user_email, fingerprint, device_mac, started_at, mode, duration_sec, max_depth_m, o2_percent, header_hex, profile_hex, location, device, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
      );
      const res = await env.DB.batch(dives.map((d) => stmt.bind(email, d.fingerprint, d.deviceMac ?? null, d.startedAt,
        d.mode ?? null, d.durationSec ?? null, d.maxDepthM ?? null, d.o2Percent ?? null, d.headerHex || "", d.profileHex || "", cleanLocation(d.location),
        d.device || "cosmiq", d.device && d.device !== "cosmiq" ? d.extra : null)));
      return json({ stored: res.reduce((n, r) => n + (r.meta.changes || 0), 0), received: dives.length });
    }

    return json({ error: "not found" }, 404);
  },
};
