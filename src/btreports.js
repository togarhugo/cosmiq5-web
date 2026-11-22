// Bluetooth reports and download logs a person sends to their own account, to look at a failed attempt afterwards.
// Plain text only (it is never shown as HTML), private to the signed-in user, newest 30 kept. See public/bt-log.js and public/bluetooth-lab.js.
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const KINDS = ["lab", "download"], MAX_CHARS = 200_000, KEEP = 30;

export async function handleBtReports(request, url, env, email) {
  const path = url.pathname, m = request.method;
  if (path === "/api/bt-reports" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT id, kind, length(body) AS size, created_at AS createdAt FROM bt_reports WHERE user_email = ? ORDER BY id DESC LIMIT ?").bind(email, KEEP).all();
    return json({ reports: results, max: KEEP });
  }
  if (path === "/api/bt-reports" && m === "POST") {
    const raw = await request.text();
    if (raw.length > MAX_CHARS + 2000) return json({ error: "That report is too long (limit " + MAX_CHARS + " characters)." }, 413);
    let b; try { b = JSON.parse(raw); } catch { b = null; }
    if (!b || typeof b !== "object" || !KINDS.includes(b.kind) || typeof b.body !== "string" || !b.body.trim()) return json({ error: "invalid report" }, 400);
    if (b.body.length > MAX_CHARS) return json({ error: "That report is too long (limit " + MAX_CHARS + " characters)." }, 413);
    const r = await env.DB.prepare("INSERT INTO bt_reports (user_email, kind, body) VALUES (?,?,?)").bind(email, b.kind, b.body).run();
    const id = r.meta && r.meta.last_row_id;
    await env.DB.prepare("DELETE FROM bt_reports WHERE user_email = ? AND id NOT IN (SELECT id FROM bt_reports WHERE user_email = ? ORDER BY id DESC LIMIT ?)").bind(email, email, KEEP).run();
    return json({ id, ok: true }, 201);
  }
  const one = path.match(/^\/api\/bt-reports\/(\d{1,12})$/);
  if (one && m === "GET") {
    const r = await env.DB.prepare("SELECT id, kind, body, created_at AS createdAt FROM bt_reports WHERE user_email = ? AND id = ?").bind(email, Number(one[1])).first();
    return r ? json({ report: r }) : json({ error: "not found" }, 404);
  }
  if (one && m === "DELETE") {
    const r = await env.DB.prepare("DELETE FROM bt_reports WHERE user_email = ? AND id = ?").bind(email, Number(one[1])).run();
    return r.meta && r.meta.changes ? json({ ok: true }) : json({ error: "not found" }, 404);
  }
  return json({ error: "not found" }, 404);
}
