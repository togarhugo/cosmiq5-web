// Account area API: profile picture, regulator tracking, certification files. JSON only.
// Everything is scoped to the signed-in user. Binary data stays base64 text: only the first bytes are inspected here.
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const MAX_AVATAR_CHARS = 150_000;            // a 256x256 JPEG is ~15-40 KB
const MAX_FILE_BYTES = 1_000_000, MAX_FILES = 12, MAX_BODY_CHARS = 1_500_000;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const KINDS = ["cert", "dan"];
/** "" or a real calendar date YYYY-MM-DD between 1990 and 2100; false if invalid. */
function dateOnly(v) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number), t = new Date(Date.UTC(y, m - 1, d));
  return y >= 1990 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? v : false;
}

/** Control characters out, whitespace collapsed, trimmed; false if too long. */
function text(v, max) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") return false;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? false : t;
}
const rawSize = (b64) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
function head(b64, n = 12) {                                                   // first bytes only
  try { return Uint8Array.from(atob(b64.slice(0, Math.ceil(n / 3) * 4)), (c) => c.charCodeAt(0)); } catch { return new Uint8Array(0); }
}
const startsWith = (h, sig) => sig.every((b, i) => h[i] === b);
// allowed upload types and how to recognise them
const SIGNATURES = {
  "image/jpeg": (h) => startsWith(h, [0xff, 0xd8, 0xff]),
  "image/png": (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/webp": (h) => startsWith(h, [0x52, 0x49, 0x46, 0x46]) && h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50,
  "application/pdf": (h) => startsWith(h, [0x25, 0x50, 0x44, 0x46, 0x2d]),
};
async function body(request) {
  const t = await request.text();
  if (t.length > MAX_BODY_CHARS) return { tooBig: true };
  try { const b = JSON.parse(t); return b && typeof b === "object" ? { b } : { b: null }; } catch { return { b: null }; }
}

export async function handleAccountData(request, url, env, email) {
  const path = url.pathname, m = request.method;

  // ---- profile picture -------------------------------------------------------------------------------------------
  if (path === "/api/profile" && m === "GET") {
    const r = await env.DB.prepare("SELECT avatar, full_name, dan_number, dan_plan, dan_valid_until, latest_cert_id FROM profiles WHERE user_email = ?").bind(email).first();
    return json({ avatar: r ? r.avatar : null, fullName: r ? r.full_name : "", latestCertId: r ? r.latest_cert_id : "", dan: { number: r ? r.dan_number : "", plan: r ? r.dan_plan : "", validUntil: r ? r.dan_valid_until : "" } });
  }
  if (path === "/api/profile/name" && m === "PUT") {
    const { b, tooBig } = await body(request);
    const name = b && typeof b.fullName === "string" ? text(b.fullName, 80) : false;
    if (tooBig || name === false) return json({ error: "The name must be 80 characters or fewer." }, tooBig ? 413 : 400);
    await env.DB.prepare("INSERT INTO profiles (user_email, full_name, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(user_email) DO UPDATE SET full_name = excluded.full_name, updated_at = excluded.updated_at").bind(email, name).run();
    return json({ ok: true });
  }
  // Pin one certification as "latest" for the Summary ({id: ""} goes back to working it out from the dates).
  if (path === "/api/profile/latest-cert" && m === "PUT") {
    const { b, tooBig } = await body(request);
    if (tooBig || !b || typeof b.id !== "string" || !(b.id === "" || /^[0-9a-f]{16}$/.test(b.id))) return json({ error: "bad request" }, tooBig ? 413 : 400);
    if (b.id) {
      const c = await env.DB.prepare("SELECT id FROM certs WHERE user_email = ? AND id = ? AND kind = 'cert'").bind(email, b.id).first();
      if (!c) return json({ error: "That certification does not exist." }, 404);
    }
    await env.DB.prepare("INSERT INTO profiles (user_email, latest_cert_id, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(user_email) DO UPDATE SET latest_cert_id = excluded.latest_cert_id, updated_at = excluded.updated_at").bind(email, b.id).run();
    return json({ ok: true });
  }
  if (path === "/api/profile/dan" && m === "PUT") {
    const { b, tooBig } = await body(request);
    if (tooBig || !b) return json({ error: "bad request" }, tooBig ? 413 : 400);
    const number = text(b.number, 30), plan = text(b.plan, 60), validUntil = dateOnly(b.validUntil);
    if (!number || !/^[A-Za-z0-9 \-/]+$/.test(number)) return json({ error: "Enter your DAN member number (letters, digits, spaces and dashes)." }, 400);
    if (plan === false || validUntil === false) return json({ error: "invalid DAN details" }, 400);
    await env.DB.prepare("INSERT INTO profiles (user_email, dan_number, dan_plan, dan_valid_until, updated_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(user_email) DO UPDATE SET dan_number = excluded.dan_number, dan_plan = excluded.dan_plan, dan_valid_until = excluded.dan_valid_until, updated_at = excluded.updated_at").bind(email, number, plan, validUntil).run();
    return json({ ok: true });
  }
  if (path === "/api/profile/dan" && m === "DELETE") {
    await env.DB.prepare("UPDATE profiles SET dan_number = '', dan_plan = '', dan_valid_until = '', updated_at = datetime('now') WHERE user_email = ?").bind(email).run();
    return json({ ok: true });
  }
  if (path === "/api/profile/avatar" && m === "PUT") {
    const { b, tooBig } = await body(request);
    if (tooBig) return json({ error: "too large" }, 413);
    const d = b && b.dataUrl, pre = "data:image/jpeg;base64,";
    if (typeof d !== "string" || !d.startsWith(pre) || d.length > MAX_AVATAR_CHARS || !B64.test(d.slice(pre.length)) || !SIGNATURES["image/jpeg"](head(d.slice(pre.length))))
      return json({ error: "The picture must be a JPEG under about 100 KB." }, 400);
    await env.DB.prepare("INSERT INTO profiles (user_email, avatar, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(user_email) DO UPDATE SET avatar = excluded.avatar, updated_at = excluded.updated_at").bind(email, d).run();
    return json({ ok: true });
  }
  if (path === "/api/profile/avatar" && m === "DELETE") {
    await env.DB.prepare("UPDATE profiles SET avatar = NULL, updated_at = datetime('now') WHERE user_email = ?").bind(email).run();
    return json({ ok: true });
  }

  // ---- regulator ---------------------------------------------------------------------------------------------------
  if (path === "/api/regulator" && m === "GET") {
    const r = await env.DB.prepare("SELECT name, type, baseline, since FROM regulators WHERE user_email = ?").bind(email).first();
    return json({ regulator: r || null });
  }
  if (path === "/api/regulator" && m === "PUT") {
    const { b, tooBig } = await body(request);
    if (tooBig || !b) return json({ error: "bad request" }, tooBig ? 413 : 400);
    const name = text(b.name, 60), type = text(b.type, 40), since = b.since === undefined || b.since === null ? "" : b.since;
    if (!name || type === false || !Number.isInteger(b.baseline) || b.baseline < 0 || b.baseline > 99999 ||
        !(since === "" || (typeof since === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(since)))) return json({ error: "invalid regulator" }, 400);
    await env.DB.prepare("INSERT INTO regulators (user_email, name, type, baseline, since, updated_at) VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(user_email) DO UPDATE SET name = excluded.name, type = excluded.type, baseline = excluded.baseline, since = excluded.since, updated_at = excluded.updated_at")
      .bind(email, name, type, b.baseline, since).run();
    return json({ ok: true });
  }
  if (path === "/api/regulator" && m === "DELETE") {
    await env.DB.prepare("DELETE FROM regulators WHERE user_email = ?").bind(email).run();
    return json({ ok: true });
  }

  // ---- certification files --------------------------------------------------------------------------------------------
  if (path === "/api/certs" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT id, label, number, kind, certified_on AS certifiedOn, filename, mime, size, created_at AS createdAt FROM certs WHERE user_email = ? ORDER BY created_at DESC, id").bind(email).all();
    return json({ certs: results });
  }
  if (path === "/api/certs" && m === "POST") {
    const { b, tooBig } = await body(request);
    if (tooBig) return json({ error: "That file is too large (limit 1 MB)." }, 413);
    if (!b) return json({ error: "bad request" }, 400);
    const label = text(b.label, 80), number = text(b.number, 40), filename = text(b.filename, 120).replace(/[\\/]/g, "_");
    const mime = b.mime, data = b.data, kind = b.kind === undefined ? "cert" : b.kind, certifiedOn = dateOnly(b.certifiedOn);
    if (!KINDS.includes(kind) || certifiedOn === false) return json({ error: "invalid details" }, 400);
    if (!label) return json({ error: "Give the certification a name." }, 400);
    if (number === false || filename === false || !filename) return json({ error: "invalid details" }, 400);
    if (typeof mime !== "string" || !SIGNATURES[mime] || typeof data !== "string" || !data || !B64.test(data)) return json({ error: "Only PDF, JPEG, PNG or WebP files." }, 400);
    if (rawSize(data) > MAX_FILE_BYTES) return json({ error: "That file is too large (limit 1 MB)." }, 413);
    if (!SIGNATURES[mime](head(data))) return json({ error: "The file does not look like a " + mime.split("/")[1].toUpperCase() + "." }, 400);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM certs WHERE user_email = ? AND kind = ?").bind(email, kind).first();
    if (n.n >= MAX_FILES) return json({ error: `You can keep up to ${MAX_FILES} files. Delete one first.` }, 409);
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.DB.prepare("INSERT INTO certs (id, user_email, label, number, kind, certified_on, filename, mime, size, data) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id, email, label, number, kind, certifiedOn, filename, mime, rawSize(data), data).run();
    return json({ id });
  }
  const one = path.match(/^\/api\/certs\/([0-9a-f]{16})$/);
  if (one && m === "GET") {
    const r = await env.DB.prepare("SELECT id, label, number, kind, certified_on AS certifiedOn, filename, mime, size, data FROM certs WHERE user_email = ? AND id = ?").bind(email, one[1]).first();
    return r ? json({ cert: r }) : json({ error: "not found" }, 404);
  }
  if (one && m === "DELETE") {
    const r = await env.DB.prepare("DELETE FROM certs WHERE user_email = ? AND id = ?").bind(email, one[1]).run();
    await env.DB.prepare("UPDATE profiles SET latest_cert_id = '' WHERE user_email = ? AND latest_cert_id = ?").bind(email, one[1]).run();   // a deleted file cannot stay pinned
    return json({ deleted: r.meta.changes || 0 });
  }
  return null;
}
