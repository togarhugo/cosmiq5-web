// Sharing a dive log with the other person who uses this app (they dive together): the sender copies their OWN dives into the other account.
// Everything is driven by the signed-in sender; the recipient must be on the allow-list; only dives the sender recorded themselves are copied (never
// dives that were shared with them), so copies cannot bounce back and forth. Copies carry the sender's email in `shared_from`, are ranked after the
// recipient's own computers (see PREFERENCE in public/dive-utils.js) and can be removed by the recipient. Copying again adds only what is new.
import { allowedEmails } from "./auth.js";
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** "" (no limit) or a real calendar date YYYY-MM-DD; false if invalid. */
function day(v) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number), t = new Date(Date.UTC(y, m - 1, d));
  return y >= 1990 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? v : false;
}
async function readBody(request, env, email) {
  let b; try { b = await request.json(); } catch { return { error: json({ error: "bad json" }, 400) }; }
  if (!b || typeof b !== "object") return { error: json({ error: "bad request" }, 400) };
  const to = typeof b.to === "string" ? b.to.trim().toLowerCase() : "", from = day(b.from), until = day(b.until);
  if (!to || !allowedEmails(env).includes(to) || to === email) return { error: json({ error: "Choose another person who uses this app." }, 400) };
  if (from === false || until === false) return { error: json({ error: "Dates must look like 2025-03-31." }, 400) };
  if (from && until && from > until) return { error: json({ error: "The first date is after the last date." }, 400) };
  return { to, lo: (from || "0000-01-01") + "T00:00:00", hi: (until || "9999-12-31") + "T23:59:59" };
}

export async function handleShare(request, url, env, email) {
  const path = url.pathname, m = request.method;
  if (path === "/api/share" && m === "GET") {
    const targets = allowedEmails(env).filter((e) => e !== email);
    const { results } = await env.DB.prepare("SELECT shared_from AS fromEmail, COUNT(*) AS n, MIN(started_at) AS first, MAX(started_at) AS last FROM dives WHERE user_email = ? AND shared_from != '' GROUP BY shared_from").bind(email).all();
    return json({ targets, received: results.map((r) => ({ from: r.fromEmail, count: r.n, first: r.first, last: r.last })) });
  }
  if (path === "/api/share/preview" && m === "POST") {
    const r = await readBody(request, env, email); if (r.error) return r.error;
    const { results } = await env.DB.prepare("SELECT substr(started_at, 1, 4) AS year, COUNT(*) AS n FROM dives WHERE user_email = ? AND shared_from = '' AND started_at >= ? AND started_at <= ? GROUP BY year ORDER BY year").bind(email, r.lo, r.hi).all();
    return json({ total: results.reduce((a, x) => a + x.n, 0), byYear: results.map((x) => ({ year: x.year, count: x.n })) });
  }
  if (path === "/api/share/copy" && m === "POST") {
    const r = await readBody(request, env, email); if (r.error) return r.error;
    const res = await env.DB.prepare(
      "INSERT OR IGNORE INTO dives (user_email, fingerprint, device_mac, started_at, mode, duration_sec, max_depth_m, o2_percent, header_hex, profile_hex, location, device, extra, shared_from) " +
      "SELECT ?, fingerprint, device_mac, started_at, mode, duration_sec, max_depth_m, o2_percent, header_hex, profile_hex, location, device, extra, ? FROM dives WHERE user_email = ? AND shared_from = '' AND started_at >= ? AND started_at <= ? AND NOT EXISTS (SELECT 1 FROM deleted_dives x WHERE x.user_email = ? AND x.fingerprint = dives.fingerprint)"
    ).bind(r.to, email, email, r.lo, r.hi, r.to).run();
    return json({ copied: res.meta.changes || 0, to: r.to });
  }
  if (path === "/api/share/remove" && m === "POST") {                                // the recipient removes the dives another person shared with them
    let b; try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const from = b && typeof b.from === "string" ? b.from.trim().toLowerCase() : "";
    if (!from || from === email) return json({ error: "Choose a person who shared dives with you." }, 400);
    const res = await env.DB.prepare("DELETE FROM dives WHERE user_email = ? AND shared_from = ?").bind(email, from).run();
    return json({ removed: res.meta.changes || 0 });
  }
  return json({ error: "not found" }, 404);
}
