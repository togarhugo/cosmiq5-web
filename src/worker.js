import ASSETS from "./assets.generated.js";

// Cosmiq Manager API. Cloudflare Access (Google login) sits in front of the whole site;
// this Worker ALSO verifies the Access JWT, so the API stays closed even if Access is
// misconfigured or the *.workers.dev URL is hit directly. Fails closed.

const enc = new TextEncoder();
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

let jwksCache = { at: 0, keys: null };
async function getKeys(env) {
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetch(`https://${env.TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("cannot fetch Access certs");
  jwksCache = { at: Date.now(), keys: (await r.json()).keys };
  return jwksCache.keys;
}

/** Returns the authenticated email, or throws. */
export async function authenticate(request, env) {
  if (!env.TEAM_DOMAIN || env.TEAM_DOMAIN.startsWith("REPLACE") || !env.POLICY_AUD || env.POLICY_AUD.startsWith("REPLACE"))
    throw Object.assign(new Error("Access not configured"), { status: 503 });
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw Object.assign(new Error("missing token"), { status: 401 });
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw Object.assign(new Error("malformed token"), { status: 401 });
  const header = JSON.parse(new TextDecoder().decode(b64u(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64u(p)));
  if (header.alg !== "RS256") throw Object.assign(new Error("bad alg"), { status: 401 });
  const jwk = (await getKeys(env)).find((k) => k.kid === header.kid);
  if (!jwk) throw Object.assign(new Error("unknown key"), { status: 401 });
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), enc.encode(`${h}.${p}`));
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!ok || !aud.includes(env.POLICY_AUD) || payload.iss !== `https://${env.TEAM_DOMAIN}` || payload.exp * 1000 < Date.now())
    throw Object.assign(new Error("invalid token"), { status: 401 });
  const email = String(payload.email || "").toLowerCase();
  const allowed = (env.ALLOWED_EMAILS || "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  if (!email || (allowed.length && !allowed.includes(email))) throw Object.assign(new Error("not allowed"), { status: 403 });
  return email;
}

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
    headers: { "content-type": a.t, "cache-control": "private, no-cache", "x-content-type-options": "nosniff" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Everything (pages too) requires a valid Cloudflare Access login: fails closed.
    let email;
    try { email = await authenticate(request, env); }
    catch (e) { return json({ error: e.message }, e.status || 401); }

    if (!url.pathname.startsWith("/api/")) return serveAsset(request, url.pathname);

    if (url.pathname === "/api/me") return json({ email });

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
