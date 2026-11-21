// Dive places on a map: name -> latitude / longitude. JSON only, scoped to the signed-in user.
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const MAX_PLACES = 500;
const clean = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : null);
const coord = (v, lim) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= lim ? Math.round(v * 1e6) / 1e6 : null;     // ~0.1 m is plenty

export async function handlePlaces(request, url, env, email) {
  const m = request.method;
  if (url.pathname !== "/api/places") return null;
  if (m === "GET") {
    const { results } = await env.DB.prepare("SELECT name, lat, lon FROM places WHERE user_email = ? ORDER BY name COLLATE NOCASE").bind(email).all();
    return json({ places: results });
  }
  let body; try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body !== "object") return json({ error: "bad json" }, 400);
  const name = clean(body.name);
  if (m === "PUT") {
    const lat = coord(body.lat, 90), lon = coord(body.lon, 180);
    if (!name || name.length > 60 || lat === null || lon === null) return json({ error: "A place needs a name (up to 60 characters) and a position on the map." }, 400);
    const k = name.toLowerCase();
    const have = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(k = ?) AS same FROM places WHERE user_email = ?").bind(k, email).first();
    if (!have.same && have.n >= MAX_PLACES) return json({ error: `You can keep up to ${MAX_PLACES} places.` }, 409);
    await env.DB.prepare("INSERT INTO places (user_email, k, name, lat, lon, updated_at) VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(user_email, k) DO UPDATE SET name = excluded.name, lat = excluded.lat, lon = excluded.lon, updated_at = excluded.updated_at")
      .bind(email, k, name, lat, lon).run();
    return json({ ok: true });
  }
  if (m === "DELETE") {
    if (!name || name.length > 60) return json({ error: "bad request" }, 400);
    const r = await env.DB.prepare("DELETE FROM places WHERE user_email = ? AND k = ?").bind(email, name.toLowerCase()).run();
    return json({ deleted: r.meta.changes || 0 });
  }
  return json({ error: "method not allowed" }, 405);
}
