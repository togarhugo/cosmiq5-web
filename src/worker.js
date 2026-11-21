import ASSETS from "./assets.generated.js";
import { configError, currentUser, handleAuth } from "./auth.js";
import { VERSION } from "./version.js";

// Cosmiq Manager: static app + dive-log API. Sign-in is Google OAuth inside this Worker
// (see auth.js). Everything except /auth/* requires a valid session: fails closed.

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-app-version": VERSION } });

const HEX = /^[0-9a-f]*$/;
function validDive(d) {
  return d && typeof d.fingerprint === "string" && /^[0-9a-f]{12}$/.test(d.fingerprint) &&
    typeof d.headerHex === "string" && d.headerHex.length === 72 && HEX.test(d.headerHex) &&
    typeof d.profileHex === "string" && d.profileHex.length <= 400_000 && HEX.test(d.profileHex) && d.profileHex.length % 2 === 0 &&
    typeof d.startedAt === "string" && d.startedAt.length <= 32;
}

function serveAsset(request, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "method not allowed" }, 405);
  const a = ASSETS[pathname === "/" ? "/index.html" : pathname];
  if (!a) return json({ error: "not found" }, 404);
  const bin = Uint8Array.from(atob(a.b), (c) => c.charCodeAt(0));
  return new Response(request.method === "HEAD" ? null : bin, {
    headers: { "content-type": a.t, "cache-control": "private, no-cache", "x-content-type-options": "nosniff", "x-app-version": VERSION },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const bad = configError(env);
    if (bad) return json({ error: bad }, 503);

    const auth = await handleAuth(request, url, env);
    if (auth) return auth;

    const user = await currentUser(request, env);
    if (!user) {
      const wantsPage = request.method === "GET" && (request.headers.get("accept") || "").includes("text/html");
      return wantsPage ? Response.redirect(url.origin + "/auth/login", 302) : json({ error: "not signed in" }, 401);
    }
    const email = user.email;

    // CSRF defence in depth (cookie is SameSite=Lax): state-changing calls must be same-origin.
    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return json({ error: "cross-origin request refused" }, 403);
    }

    if (!url.pathname.startsWith("/api/")) return serveAsset(request, url.pathname);

    if (url.pathname === "/api/me") return json({ email, name: user.name, version: VERSION });

    if (url.pathname === "/api/dives" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT fingerprint, device_mac AS deviceMac, started_at AS startedAt, mode, duration_sec AS durationSec, max_depth_m AS maxDepthM, o2_percent AS o2Percent, header_hex AS headerHex, profile_hex AS profileHex FROM dives WHERE user_email = ? ORDER BY started_at DESC LIMIT 2000"
      ).bind(email).all();
      return json({ dives: results });
    }

    if (url.pathname === "/api/dives" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const dives = Array.isArray(body.dives) ? body.dives : [];
      if (dives.length > 50) return json({ error: "max 50 dives per request" }, 413);
      if (!dives.every(validDive)) return json({ error: "invalid dive record" }, 400);
      const stmt = env.DB.prepare(
        "INSERT OR IGNORE INTO dives (user_email, fingerprint, device_mac, started_at, mode, duration_sec, max_depth_m, o2_percent, header_hex, profile_hex) VALUES (?,?,?,?,?,?,?,?,?,?)"
      );
      const res = await env.DB.batch(dives.map((d) => stmt.bind(email, d.fingerprint, d.deviceMac ?? null, d.startedAt,
        d.mode ?? null, d.durationSec ?? null, d.maxDepthM ?? null, d.o2Percent ?? null, d.headerHex, d.profileHex)));
      return json({ stored: res.reduce((n, r) => n + (r.meta.changes || 0), 0), received: dives.length });
    }

    return json({ error: "not found" }, 404);
  },
};
