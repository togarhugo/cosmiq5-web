// Dive trips (Trips tab): a title, destination, dates, baggage limits and packing lists with a weight per item. Private to the signed-in user.
// A trip is stored as JSON in one row. Everything coming in is cleaned and size-limited here, so a page cannot store anything else.
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const MAX_TRIPS = 60, MAX_GROUPS = 12, MAX_ITEMS = 120, MAX_BYTES = 120_000;

const text = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : null);
const ident = (v) => (typeof v === "string" && /^[a-z0-9]{4,24}$/.test(v) ? v : null);
/** "" (not set) or a real calendar date YYYY-MM-DD; false if invalid. */
function day(v) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number), t = new Date(Date.UTC(y, m - 1, d));
  return y >= 1990 && y <= 2100 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? v : false;
}
/** A weight in kg (two decimals, 0 to max) or null (not set); false if invalid. */
function kg(v, max) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > max) return false;
  return Math.round(n * 100) / 100;
}

/** The trip as it will be stored, or { error } saying what is wrong. */
export function cleanTrip(t, id) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return { error: "bad trip" };
  const title = text(t.title, 100); if (!title) return { error: "A trip needs a title." };
  const destination = text(t.destination ?? "", 120), start = day(t.start), end = day(t.end);
  if (destination === null || start === false || end === false) return { error: "Dates must look like 2026-12-12." };
  if (start && end && end < start) return { error: "The trip ends before it starts." };
  const lim = t.limits && typeof t.limits === "object" ? t.limits : {}, limits = { dive: kg(lim.dive, 200), carry: kg(lim.carry, 200), total: kg(lim.total, 400) };
  if (Object.values(limits).includes(false)) return { error: "A weight limit must be between 0 and 200 kg." };
  if (!Array.isArray(t.groups) || t.groups.length > MAX_GROUPS) return { error: "Too many lists." };
  const seen = new Set(); let items = 0; const groups = [];
  for (const g of t.groups) {
    const gid = g && ident(g.id), name = g && text(g.name, 60);
    if (!gid || !name || !Array.isArray(g.items) || seen.has(gid)) return { error: "Each list needs a name." };
    seen.add(gid); const list = [];
    for (const i of g.items) {
      const iid = i && ident(i.id), iname = i && text(i.name, 80), w = i && kg(i.kg, 100);
      if (!iid || !iname || w === false || seen.has(iid) || (i.bag !== "dive" && i.bag !== "carry")) return { error: "Each item needs a name, a weight between 0 and 100 kg and a bag." };
      seen.add(iid); list.push({ id: iid, name: iname, kg: w ?? 0, bag: i.bag, packed: i.packed === true }); items++;
    }
    groups.push({ id: gid, name, items: list });
  }
  if (items > MAX_ITEMS) return { error: "Too many items." };
  return { trip: { id, title, destination, start, end, limits, groups } };
}

export async function handleTrips(request, url, env, email) {
  const path = url.pathname, m = request.method;
  if (path === "/api/trips" && m === "GET") {
    const { results } = await env.DB.prepare("SELECT id, data, updated_at AS updatedAt FROM trips WHERE user_email = ? ORDER BY id").bind(email).all();
    const trips = []; for (const r of results) { try { trips.push({ ...JSON.parse(r.data), id: r.id, updatedAt: r.updatedAt }); } catch { /* a damaged row is skipped */ } }
    return json({ trips });
  }
  const one = path.match(/^\/api\/trips\/([a-z0-9]{4,24})$/);
  if (one && m === "PUT") {
    if (Number(request.headers.get("content-length") || 0) > MAX_BYTES) return json({ error: "This trip is too large." }, 413);
    let body; try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const c = cleanTrip(body, one[1]); if (c.error) return json({ error: c.error }, 400);
    const data = JSON.stringify(c.trip); if (data.length > MAX_BYTES) return json({ error: "This trip is too large." }, 413);
    const have = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(id = ?) AS mine FROM trips WHERE user_email = ?").bind(one[1], email).first();
    if (!have.mine && have.n >= MAX_TRIPS) return json({ error: `You can keep up to ${MAX_TRIPS} trips. Delete an old one first.` }, 400);
    await env.DB.prepare("INSERT INTO trips (user_email, id, data, updated_at) VALUES (?,?,?,datetime('now')) ON CONFLICT(user_email, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at").bind(email, one[1], data).run();
    return json({ saved: true, trip: c.trip });
  }
  if (one && m === "DELETE") {
    const res = await env.DB.prepare("DELETE FROM trips WHERE user_email = ? AND id = ?").bind(email, one[1]).run();
    return json({ deleted: res.meta.changes || 0 });
  }
  return json({ error: "not found" }, 404);
}
