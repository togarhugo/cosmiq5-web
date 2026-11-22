// API keys and the read-only dive log API.
//   /api/keys*   : manage keys (you must be signed in; used by the Account page)
//   /api/v1/*    : read your dives with a key (Authorization: Bearer <key>); no cookies, no writes
// A key is "dm_" + 43 random URL-safe characters (256 bits). Only its SHA-256 is stored, so a leaked database does not leak keys,
// and the key is shown once. Because the key is random, hashing it once (no slow KDF) is enough and keeps the Worker's CPU low.
import CosmiqDive from "../public/dive-protocol.js";        // the same decoder the app uses for the Cosmiq+ bytes
import { allowedEmails } from "./auth.js";
import { VERSION } from "./version.js";

const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const KEY_RE = /^dm_[A-Za-z0-9_-]{43}$/, ID_RE = /^[0-9a-f]{16}$/, DIVE_RE = /^[0-9a-f]{12}$/;
export const MAX_ACTIVE_KEYS = 10, LIFETIMES = [7, 14, 30, 0];           // days; 0 = unlimited
const MAX_PAGE = 500, MAX_PAGE_WITH_DATA = 10, DEFAULT_PAGE = 100;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (s) => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
const newKey = () => "dm_" + b64url(crypto.getRandomValues(new Uint8Array(32)));
const iso = (t) => (t ? t.replace(" ", "T") + "Z" : null);                // SQLite "YYYY-MM-DD HH:MM:SS" (UTC) -> ISO
const clean = (v, max) => { if (typeof v !== "string") return false; const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim(); return t && t.length <= max ? t : false; };

// ---------------------------------------------------------------------------------------------------------------------------
// key management (signed-in user)
// ---------------------------------------------------------------------------------------------------------------------------
const publicKey = (r) => ({ id: r.id, description: r.description, prefix: r.prefix, lifetimeDays: r.ttl_days ?? null, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), lastUsedAt: iso(r.last_used_at), revokedAt: iso(r.revoked_at),
  status: r.revoked_at ? "revoked" : r.expired ? "expired" : "active", rotatedFrom: r.rotated_from || null });
const COLS = "id, description, prefix, ttl_days, created_at, expires_at, last_used_at, revoked_at, rotated_from, (expires_at IS NOT NULL AND expires_at <= datetime('now')) AS expired";

async function insertKey(env, email, description, days, rotatedFrom) {
  const key = newKey(), id = hex(crypto.getRandomValues(new Uint8Array(8)));
  const expires = days ? `datetime('now', '+${days} days')` : "NULL";                  // days comes from the allow-list above, never from the request text
  const stmt = env.DB.prepare(`INSERT INTO api_keys (id, user_email, description, prefix, key_hash, ttl_days, expires_at, rotated_from) VALUES (?,?,?,?,?,?,${expires},?)`)
    .bind(id, email, description, key.slice(0, 10), await sha256(key), days || null, rotatedFrom || null);
  return { key, id, stmt };
}

export async function handleKeys(request, url, env, email) {
  const m = request.method, path = url.pathname;
  if (path === "/api/keys" && m === "GET") {
    const { results } = await env.DB.prepare(`SELECT ${COLS} FROM api_keys WHERE user_email = ? ORDER BY created_at DESC, id`).bind(email).all();
    return json({ keys: results.map(publicKey), max: MAX_ACTIVE_KEYS });
  }
  if (path === "/api/keys" && m === "POST") {
    let b; try { b = await request.json(); } catch { b = null; }
    const description = b && clean(b.description, 60);
    if (!description) return json({ error: "Describe what the key is for (up to 60 characters)." }, 400);
    if (!b || !LIFETIMES.includes(b.days)) return json({ error: "Choose how long the key works: 7, 14 or 30 days, or unlimited." }, 400);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE user_email = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))").bind(email).first();
    if (n.n >= MAX_ACTIVE_KEYS) return json({ error: `You can have ${MAX_ACTIVE_KEYS} active keys. Revoke one first.` }, 409);
    const k = await insertKey(env, email, description, b.days); await k.stmt.run();
    const row = await env.DB.prepare(`SELECT ${COLS} FROM api_keys WHERE id = ?`).bind(k.id).first();
    return json({ key: k.key, item: publicKey(row) });                                 // the only time the key is ever returned
  }
  const one = path.match(/^\/api\/keys\/([0-9a-f]{16})(?:\/(rotate|revoke))?$/);
  if (!one) return null;
  const id = one[1], action = one[2];
  const row = await env.DB.prepare(`SELECT ${COLS} FROM api_keys WHERE user_email = ? AND id = ?`).bind(email, id).first();      // someone else's key looks like a missing one
  if (!row) return json({ error: "That key does not exist." }, 404);
  if (action === "rotate" && m === "POST") {
    if (row.revoked_at) return json({ error: "A revoked key cannot be rotated. Make a new key." }, 409);
    const k = await insertKey(env, email, row.description, row.ttl_days || 0, row.id);
    await env.DB.batch([env.DB.prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE user_email = ? AND id = ?").bind(email, id), k.stmt]);      // the old key stops working at once
    const fresh = await env.DB.prepare(`SELECT ${COLS} FROM api_keys WHERE id = ?`).bind(k.id).first();
    return json({ key: k.key, item: publicKey(fresh) });
  }
  if (action === "revoke" && m === "POST") {
    await env.DB.prepare("UPDATE api_keys SET revoked_at = COALESCE(revoked_at, datetime('now')) WHERE user_email = ? AND id = ?").bind(email, id).run();
    return json({ ok: true });
  }
  if (!action && m === "DELETE") { await env.DB.prepare("DELETE FROM api_keys WHERE user_email = ? AND id = ?").bind(email, id).run(); return json({ ok: true }); }
  return json({ error: "method not allowed" }, 405);
}

// ---------------------------------------------------------------------------------------------------------------------------
// the read-only API
// ---------------------------------------------------------------------------------------------------------------------------
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, x-api-key, content-type", "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "86400", "vary": "origin" };
const api = (o, status = 200) => json(o, status, CORS);                                // a key goes in a header, never a cookie, so any website may call this (they still need a key)
const fail = (status, code, message) => api({ error: code, message }, status);

/** The key owner, or an error response. */
async function authenticate(request, env) {
  const h = request.headers.get("authorization") || "", m = /^Bearer\s+(\S+)\s*$/i.exec(h), key = m ? m[1] : (request.headers.get("x-api-key") || "").trim();
  if (!key) return { err: fail(401, "missing_key", "Send your key as the header  Authorization: Bearer <key>.") };
  if (!KEY_RE.test(key)) return { err: fail(401, "invalid_key", "That is not a valid key.") };
  const row = await env.DB.prepare("SELECT id, user_email, description, expires_at, revoked_at, (expires_at IS NOT NULL AND expires_at <= datetime('now')) AS expired FROM api_keys WHERE key_hash = ?").bind(await sha256(key)).first();
  if (!row || !allowedEmails(env).includes(row.user_email)) return { err: fail(401, "invalid_key", "That key is not valid.") };
  if (row.revoked_at) return { err: fail(401, "key_revoked", "That key was revoked. Make a new one in the app: Account, API access.") };
  if (row.expired) return { err: fail(401, "key_expired", "That key has expired. Rotate it or make a new one in the app: Account, API access.") };
  await env.DB.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 hour'))").bind(row.id).run();
  return { email: row.user_email, key: row };
}

const toBytes = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const kindOf = (mode) => (mode === "freedive" ? "freedive" : "scuba");
const SELECT = "fingerprint, device, started_at, mode, duration_sec, max_depth_m, o2_percent, location, created_at, header_hex, json_extract(extra, '$.n') AS x_number, json_extract(extra, '$.t') AS x_temp";

/** One dive as the API shows it. `data` (samples / raw) is only added when asked for, because it is the expensive part. */
function shape(r, places, data) {
  const cosmiq = (r.device || "cosmiq") === "cosmiq";
  let number = r.x_number ?? null, minTemp = r.x_temp ?? null, h = null;
  if (cosmiq && r.header_hex && r.header_hex.length === 72) { h = toBytes(r.header_hex); const d = CosmiqDive.parseDive(h, new Uint8Array(0)); number = d.number; minTemp = d.minTempC; }
  const pos = r.location ? places.get(r.location.trim().toLowerCase()) : null;
  const o = { id: r.fingerprint, device: r.device || "cosmiq", kind: kindOf(r.mode), mode: r.mode, startedAt: r.started_at, durationSec: r.duration_sec, maxDepthM: r.max_depth_m, minTempC: minTemp, o2Percent: r.o2_percent ?? null,
    diveNumber: number, location: r.location || null, position: pos || null, uploadedAt: iso(r.created_at) };
  if (data) {
    if (cosmiq) {
      let samples = null, status = "unavailable";
      if (h && r.profile_hex) {
        const prof = toBytes(r.profile_hex), chk = CosmiqDive.profileCheck(h, prof);                // only a profile that really belongs to this dive is shown
        if (chk.status === "ok" || chk.status === "truncated") { const d = CosmiqDive.parseDive(h, prof); samples = d.samples.map((s) => ({ t: s.t, depthM: +s.depthM.toFixed(2), tempC: +s.tempC.toFixed(1) })); status = chk.status === "ok" ? "complete" : "partial"; }
      }
      o.profileStatus = status; o.samples = samples;
      if (data === "raw") o.raw = { headerHex: r.header_hex, profileHex: r.profile_hex || "" };
    } else {
      let x = {}; try { x = JSON.parse(r.extra || "{}"); } catch { x = {}; }
      const s = Array.isArray(x.s) ? x.s : []; o.sampleIntervalSec = x.iv ?? null; o.profileStatus = s.length ? "complete" : "unavailable";
      o.samples = s.length ? s.map(([t, d, c]) => ({ t, depthM: d, tempC: c })) : null;
    }
  }
  return o;
}
async function placeMap(env, email) {
  const { results } = await env.DB.prepare("SELECT k, lat, lon FROM places WHERE user_email = ?").bind(email).all();
  return new Map(results.map((p) => [p.k, { lat: p.lat, lon: p.lon }]));
}
const dateOk = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z"));
const encCursor = (startedAt, id) => b64url(new TextEncoder().encode(startedAt + "|" + id));
function decCursor(c) { try { const s = new TextDecoder().decode(Uint8Array.from(atob(c.replaceAll("-", "+").replaceAll("_", "/")), (x) => x.charCodeAt(0))), i = s.lastIndexOf("|"); const t = s.slice(0, i), id = s.slice(i + 1); return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t) && DIVE_RE.test(id) ? { t, id } : null; } catch { return null; } }

export async function handleApiV1(request, url, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "GET") return api({ error: "method_not_allowed", message: "This API is read-only: use GET." }, 405);
  const a = await authenticate(request, env); if (a.err) return a.err;
  const email = a.email, path = url.pathname.replace(/\/+$/, ""), q = url.searchParams;

  if (path === "/api/v1/ping") return api({ ok: true, apiVersion: "1", appVersion: VERSION, key: { description: a.key.description, expiresAt: iso(a.key.expires_at) } });

  if (path === "/api/v1/summary") {
    const { results } = await env.DB.prepare("SELECT device, CASE WHEN mode = 'freedive' THEN 'freedive' ELSE 'scuba' END AS kind, COUNT(*) AS n, COALESCE(SUM(duration_sec), 0) AS sec, MAX(started_at) AS last FROM dives WHERE user_email = ? GROUP BY device, kind").bind(email).all();
    const byDevice = {}; let dives = 0, seconds = 0, last = null;
    for (const r of results) { const d = (byDevice[r.device] ||= {}); d[r.kind] = { dives: r.n, seconds: r.sec }; dives += r.n; seconds += r.sec; if (!last || r.last > last) last = r.last; }
    return api({ total: { dives, seconds }, byDevice, lastDiveAt: last, note: "A dive recorded by two computers is counted once per computer here." });
  }

  if (path === "/api/v1/dives") {
    const include = q.get("include"); if (include && include !== "samples" && include !== "raw") return fail(400, "bad_request", "include must be samples or raw.");
    const cap = include ? MAX_PAGE_WITH_DATA : MAX_PAGE, lim = q.has("limit") ? Number(q.get("limit")) : Math.min(DEFAULT_PAGE, cap);
    if (!Number.isInteger(lim) || lim < 1 || lim > cap) return fail(400, "bad_request", `limit must be a whole number from 1 to ${cap}` + (include ? " when include is used." : "."));
    const where = ["user_email = ?"], bind = [email];
    const device = q.get("device"); if (device) { if (device !== "cosmiq" && device !== "peregrine" && device !== "garmin") return fail(400, "bad_request", "device must be cosmiq, peregrine or garmin."); where.push("device = ?"); bind.push(device); }
    const kind = q.get("kind"); if (kind) { if (kind !== "scuba" && kind !== "freedive") return fail(400, "bad_request", "kind must be scuba or freedive."); where.push(kind === "freedive" ? "mode = 'freedive'" : "(mode IS NULL OR mode != 'freedive')"); }
    for (const [name, op] of [["from", ">="], ["to", "<="]]) { const v = q.get(name); if (v) { if (!dateOk(v)) return fail(400, "bad_request", `${name} must be a date like 2025-03-14.`); where.push(`substr(started_at, 1, 10) ${op} ?`); bind.push(v); } }
    const loc = q.get("location"); if (loc) { if (loc.length > 60) return fail(400, "bad_request", "location is too long."); where.push("lower(location) = lower(?)"); bind.push(loc); }
    const up = q.get("uploadedSince"); if (up) { const t = Date.parse(up); if (!/^\d{4}-\d{2}-\d{2}/.test(up) || Number.isNaN(t)) return fail(400, "bad_request", "uploadedSince must be a date or an ISO time like 2025-03-14T09:00:00Z."); where.push("created_at >= ?"); bind.push(new Date(t).toISOString().slice(0, 19).replace("T", " ")); }
    const order = q.get("order") || "desc"; if (order !== "asc" && order !== "desc") return fail(400, "bad_request", "order must be asc or desc.");
    const cur = q.get("cursor"); if (cur) { const c = decCursor(cur); if (!c) return fail(400, "bad_request", "That cursor is not valid."); const op = order === "asc" ? ">" : "<"; where.push(`(started_at ${op} ? OR (started_at = ? AND fingerprint ${op} ?))`); bind.push(c.t, c.t, c.id); }
    const dir = order === "asc" ? "ASC" : "DESC", cols = SELECT + (include ? ", profile_hex, extra" : "");
    const { results } = await env.DB.prepare(`SELECT ${cols} FROM dives WHERE ${where.join(" AND ")} ORDER BY started_at ${dir}, fingerprint ${dir} LIMIT ?`).bind(...bind, lim + 1).all();
    const page = results.slice(0, lim), places = await placeMap(env, email);
    return api({ dives: page.map((r) => shape(r, places, include)), count: page.length, nextCursor: results.length > lim ? encCursor(page[page.length - 1].started_at, page[page.length - 1].fingerprint) : null });
  }

  const one = path.match(/^\/api\/v1\/dives\/([^/]+)$/);
  if (one) {
    if (!DIVE_RE.test(one[1])) return fail(404, "not_found", "No such dive.");
    const include = q.get("include") === "raw" ? "raw" : "samples";
    const r = await env.DB.prepare(`SELECT ${SELECT}, profile_hex, extra FROM dives WHERE user_email = ? AND fingerprint = ?`).bind(email, one[1]).first();
    if (!r) return fail(404, "not_found", "No such dive.");
    return api(shape(r, await placeMap(env, email), include));
  }
  return fail(404, "not_found", "Unknown endpoint. See Account, API access in the app.");
}
