/* Trips tab: plan a dive trip (title, destination, dates with a countdown) and pack for it (checklists with a weight per item and bag limits).
 * Needs TripUtils. Trips are kept in your account (GET /api/trips, PUT /api/trips/<id>, DELETE /api/trips/<id>); changes are saved a moment after you stop typing.
 * The Overview shows the trip that is on now or the next one to start, and nothing when there is none. */
(function () {
  "use strict";
  const T = window.TripUtils, $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const say = (t, kind) => { if (window.toast) window.toast(t, kind || "ok"); };
  let trips = [], loaded = false, cur = null, editItem = null, adding = null, editGroup = null, ask = null, newList = false, timer = 0, state = "";
  const dirty = new Set(), find = (id) => trips.find((t) => t.id === id), today = () => T.todayKey();
  const kgIn = (v) => { v = String(v == null ? "" : v).trim().replace(",", "."); if (v === "") return null; const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : NaN; };
  const num = (n) => (n == null ? "" : String(n));

  // ---------- talking to the account ----------
  async function load() {
    try {
      const r = await fetch("/api/trips", { credentials: "same-origin", redirect: "error" }); if (!r.ok) throw new Error("HTTP " + r.status);
      const got = (await r.json()).trips || []; for (const t of got) if (!dirty.has(t.id)) { const i = trips.findIndex((x) => x.id === t.id); if (i < 0) trips.push(t); else trips[i] = t; }
      trips = trips.filter((t) => dirty.has(t.id) || got.some((g) => g.id === t.id)); loaded = true;
    } catch (e) { /* offline or signed out: the Trips tab says so, the Overview just shows nothing */ }
    renderOverview(); if (visible()) render();
  }
  const setState = (s) => { state = s; const el = $("tripSaved"); if (el) { el.textContent = s; } };
  function touch(t) {
    dirty.add(t.id); setState("Saving…"); clearTimeout(timer); timer = setTimeout(flush, 700);
  }
  async function flush(keep) {
    clearTimeout(timer); timer = 0; let bad = "";
    for (const id of [...dirty]) {
      const t = find(id); if (!t) { dirty.delete(id); continue; }
      if (!t.title.trim()) { bad = "A trip needs a title."; continue; }
      try {
        const r = await fetch("/api/trips/" + id, { method: "PUT", credentials: "same-origin", redirect: "error", keepalive: !!keep, headers: { "content-type": "application/json" }, body: JSON.stringify(t) });
        if (r.ok) dirty.delete(id); else { bad = ((await r.json().catch(() => ({}))).error) || "Not saved (HTTP " + r.status + ")."; }
      } catch (e) { bad = "Not saved: no connection. It will be sent with your next change."; }
    }
    setState(bad || (dirty.size ? "" : "Saved")); const err = $("trErr"); if (err) { err.textContent = bad; err.style.color = bad ? "var(--tx-c92a2a)" : ""; }
    renderOverview();
  }
  window.addEventListener("pagehide", () => { if (dirty.size) flush(true); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && dirty.size) flush(true); });

  // ---------- the trip card (Overview and the top of the Trips list) ----------
  function heroHtml(t) {
    const st = T.status(t, today()), tot = T.totals(t), l = t.limits || {}, pill = (label, used, limit) => { const lv = T.level(used, limit); return `<span class="tp-pill ${lv === "over" ? "bad" : lv === "warn" ? "warn" : lv === "ok" ? "ok" : ""}">${label} ${T.kgText(used)}${limit ? " / " + T.kgText(limit) : ""}</span>`; };
    return `<div class="tp-label">${st.kind === "ongoing" ? "On a trip now" : "Next trip"}</div><div class="tp-title">${esc(t.title)}</div>` +
      `<div class="muted tp-sub">${esc([t.destination, T.range(t.start, t.end)].filter(Boolean).join(" · "))}</div>` +
      `<div class="tp-count">${st.big ? `<span class="tp-big">${esc(st.big)}</span>` : ""}<span class="tp-l">${esc(st.text)}</span></div>` +
      `<div class="tp-pills"><span class="tp-pill">Packed ${tot.packed} / ${tot.count}</span>${pill("Dive bag", tot.dive, l.dive)}${pill("Carry-on", tot.carry, l.carry)}</div>`;
  }
  function renderOverview() {
    const box = $("sumTrip"); if (!box) return; const t = loaded ? T.nextTrip(trips, today()) : null;
    box.style.display = t ? "" : "none"; if (!t) { box.innerHTML = ""; return; }
    box.dataset.id = t.id; box.innerHTML = heroHtml(t);
  }
  const visible = () => { const v = $("tripsView"); return !!v && v.style.display !== "none"; };

  // ---------- the list of trips ----------
  const shortStatus = (st) => (st.kind === "upcoming" ? `in ${st.days} day${st.days === 1 ? "" : "s"}` : st.kind === "ongoing" ? `on now, day ${st.day} of ${st.total}` : st.kind === "ended" ? "ended" : "dates not set");
  function listHtml() {
    const nt = T.nextTrip(trips, today()), s = T.sections(trips, today());
    const row = (t) => { const st = T.status(t, today()), d = t.start ? new Date(t.start + "T00:00:00Z") : null;
      return `<button class="tp-row" type="button" data-a="open" data-id="${esc(t.id)}"><span class="tp-date">${d ? esc(d.toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" }).toUpperCase()) + "<br>" + d.getUTCFullYear() : "&ndash;"}</span><span class="tp-rowtxt"><b>${esc(t.title)}</b><span class="muted">${esc([T.range(t.start, t.end), shortStatus(st)].filter(Boolean).join(" · "))}</span></span></button>`; };
    const group = (name, list) => (list.length ? `<div class="card"><h3>${name}</h3>${list.map(row).join("")}</div>` : "");
    return `<div class="tp-bar"><h2>Dive trips</h2><button class="btn-set" type="button" data-a="new">+ New trip</button></div>` +
      (nt ? `<div class="card tp-hero" data-a="open" data-id="${esc(nt.id)}" role="button" tabindex="0">${heroHtml(nt)}</div>` : "") +
      (trips.length ? group("Upcoming", s.upcoming) + group("Past trips", s.past) + group("No dates yet", s.undated) : `<div class="card muted">${loaded ? "No trips yet. Plan one: dates with a countdown, and a packing list with the weight of every item against your baggage allowance." : "Loading your trips…"}</div>`);
  }

  // ---------- one trip ----------
  const bagName = (b) => (b === "carry" ? "Carry-on" : "Dive bag");
  function barHtml(label, used, limit) {
    const lv = T.level(used, limit), w = limit ? Math.min(100, used / limit * 100) : 0, lf = T.left(used, limit);
    return `<div class="tp-bag"><div class="tp-h"><span>${label}</span><b>${T.kgText(used)}${limit ? " / " + T.kgText(limit) : ""}</b></div>` +
      (limit ? `<div class="tp-wbar"><i class="${lv}" style="width:${w}%"></i></div><div class="muted tp-small">${lf >= 0 ? T.kgText(lf) + " left" : T.kgText(-lf) + " over the limit"}</div>` : `<div class="muted tp-small">No limit set</div>`) + `</div>`;
  }
  function barsHtml(t) {
    const tot = T.totals(t), l = t.limits || {};
    return barHtml("Dive bag", tot.dive, l.dive) + barHtml("Camera carry-on", tot.carry, l.carry) + (l.total ? barHtml("All bags together", tot.total, l.total) : `<div class="tp-bag"><div class="tp-h"><span>All bags together</span><b>${T.kgText(tot.total)}</b></div></div>`);
  }
  function countHtml(t) { const st = T.status(t, today()); return `<div class="tp-count">${st.big ? `<span class="tp-big">${esc(st.big)}</span>` : ""}<span class="tp-l">${esc(st.text)}${st.sub && st.kind === "upcoming" ? "<br>" + esc(st.sub) : ""}</span></div>`; }
  const chips = (cur, attr) => ["dive", "carry"].map((b) => `<button type="button" class="tp-chip${cur === b ? " on" : ""}" ${attr} data-bag="${b}" aria-pressed="${cur === b}">${bagName(b)}</button>`).join("");
  function itemHtml(t, g, i) {
    if (editItem === i.id) return `<div class="tp-edit" data-item="${esc(i.id)}"><div class="tp-two"><input class="fld" data-f="name" maxlength="80" value="${esc(i.name)}" aria-label="Item name"><input class="fld" data-f="kg" inputmode="decimal" value="${esc(num(i.kg))}" aria-label="Weight in kg" placeholder="kg"></div><div class="tp-chips">${chips(i.bag, 'data-a="setbag"')}</div><div class="tp-actions"><button type="button" class="tp-del" data-a="item-del">Delete item</button><button type="button" class="btn-set" data-a="item-done">Done</button></div></div>`;
    return `<div class="tp-item${i.packed ? " done" : ""}" data-item="${esc(i.id)}"><button type="button" class="tp-ck${i.packed ? " on" : ""}" data-a="ck" role="checkbox" aria-checked="${i.packed}" aria-label="Packed: ${esc(i.name)}">${i.packed ? "&#10003;" : ""}</button><button type="button" class="tp-name" data-a="edit">${esc(i.name)}</button><span class="tp-kg">${T.kgText(i.kg)}</span><button type="button" class="tp-bagbtn ${i.bag}" data-a="bag" aria-label="Bag: ${bagName(i.bag)}. Tap to change">${bagName(i.bag)}</button></div>`;
  }
  function groupHtml(t, g) {
    const kgSum = g.items.reduce((a, i) => a + (i.kg || 0), 0), packed = g.items.filter((i) => i.packed).length;
    let h = `<div class="tp-group" data-g="${esc(g.id)}"><div class="tp-ghead"><b>${esc(g.name)}</b><span class="muted tp-small" data-sub>${packed} of ${g.items.length} packed · ${T.kgText(kgSum)}</span></div>`;
    if (editGroup === g.id) h += `<div class="tp-edit"><input class="fld" data-f="gname" maxlength="60" value="${esc(g.name)}" aria-label="List name"><div class="tp-actions">${ask === "g:" + g.id ? `<span>Remove this list and its ${g.items.length} items?</span><button type="button" class="tp-del" data-a="gdel-ok">Remove</button><button type="button" class="btn-set alt" data-a="ask-no">Keep</button>` : `<button type="button" class="tp-del" data-a="gdel">Remove list</button><button type="button" class="btn-set" data-a="gdone">Done</button>`}</div></div>`;
    h += g.items.map((i) => itemHtml(t, g, i)).join("");
    if (adding && adding.gid === g.id) h += `<div class="tp-add"><b>New item in ${esc(g.name)}</b><div class="tp-two"><input class="fld" data-f="anew" maxlength="80" placeholder="Item name, e.g. Red filter" aria-label="New item name"><input class="fld" data-f="akg" inputmode="decimal" placeholder="kg" aria-label="Weight in kg"></div><div class="tp-chips">${chips(adding.bag, 'data-a="addbag"')}</div><div class="tp-actions"><button type="button" class="linkbtn" data-a="add-cancel">Cancel</button><button type="button" class="btn-set" data-a="add-ok">Add item</button></div></div>`;
    else h += `<div class="tp-links"><button type="button" class="linkbtn" data-a="add">+ Add to ${esc(g.name)}</button>${editGroup === g.id ? "" : `<button type="button" class="linkbtn" data-a="gedit">Rename or remove list</button>`}</div>`;
    return h + `</div>`;
  }
  function groupsHtml(t) {
    return t.groups.map((g) => groupHtml(t, g)).join("") +
      (newList ? `<div class="tp-add"><b>New list</b><input class="fld" data-f="lname" maxlength="60" placeholder="e.g. Snorkel / freedive kit" aria-label="Name of the new list"><div class="tp-actions"><button type="button" class="linkbtn" data-a="list-cancel">Cancel</button><button type="button" class="btn-set" data-a="list-ok">Add list</button></div></div>`
        : `<div class="tp-links"><button type="button" class="linkbtn" data-a="list-new">+ New list</button>${ask === "reset" ? `<span class="tp-small">Put back the standard lists? Your changes to the lists are lost.</span><button type="button" class="tp-del" data-a="reset-ok">Reset</button><button type="button" class="linkbtn" data-a="ask-no">Keep</button>` : `<button type="button" class="linkbtn" data-a="reset">Reset to the standard lists</button>`}</div>`);
  }
  function detailHtml(t) {
    const l = t.limits || {};
    return `<div class="tp-top"><button type="button" class="linkbtn" data-a="back">&larr; All trips</button><span id="tripSaved" class="muted tp-small">${esc(state)}</span></div>` +
      `<div class="card tp-head"><label class="lbl" for="trTitle">Trip title</label><input id="trTitle" class="fld" data-f="title" maxlength="100" value="${esc(t.title)}" placeholder="e.g. Banggai / Luwuk Dive Trip">` +
      `<label class="lbl" for="trDest">Destination</label><input id="trDest" class="fld" data-f="destination" maxlength="120" value="${esc(t.destination)}" placeholder="e.g. Luwuk, Central Sulawesi">` +
      `<div class="tp-two"><div><label class="lbl" for="trStart">Start</label><input id="trStart" class="fld" type="date" data-f="start" value="${esc(t.start)}"></div><div><label class="lbl" for="trEnd">End</label><input id="trEnd" class="fld" type="date" data-f="end" value="${esc(t.end)}"></div></div>` +
      `<div id="trCount">${countHtml(t)}</div><div id="trErr" class="msg" role="status"></div></div>` +
      `<div class="card"><h3>Baggage weight</h3><p class="muted tp-small" style="margin:0 0 6px">Set the allowance of your airline. Leave a box empty for no limit.</p>` +
      `<div class="tp-three"><div><label class="lbl" for="trLDive">Dive bag (kg)</label><input id="trLDive" class="fld" inputmode="decimal" data-f="ldive" value="${esc(num(l.dive))}"></div><div><label class="lbl" for="trLCarry">Carry-on (kg)</label><input id="trLCarry" class="fld" inputmode="decimal" data-f="lcarry" value="${esc(num(l.carry))}"></div><div><label class="lbl" for="trLTotal">All bags (kg)</label><input id="trLTotal" class="fld" inputmode="decimal" data-f="ltotal" value="${esc(num(l.total))}"></div></div><div id="trBars">${barsHtml(t)}</div></div>` +
      `<div class="card" id="trGroups">${groupsHtml(t)}</div>` +
      `<div class="card tp-foot">${ask === "trip" ? `<span>Delete this trip and its packing lists?</span><div class="tp-actions"><button type="button" class="tp-del solid" data-a="trip-del-ok">Delete trip</button><button type="button" class="btn-set alt" data-a="ask-no">Keep it</button></div>` : `<button type="button" class="tp-del" data-a="trip-del">Delete this trip</button>`}</div>`;
  }
  function render() {
    const v = $("tripsView"); if (!v) return; const t = cur && find(cur);
    if (cur && !t) cur = null;
    v.innerHTML = t ? detailHtml(t) : listHtml();
  }
  function refresh(t) {                                                             // the sums, without redrawing the boxes you are typing in
    const c = $("trCount"), b = $("trBars"); if (c) c.innerHTML = countHtml(t); if (b) b.innerHTML = barsHtml(t);
    for (const g of t.groups) { const el = document.querySelector(`.tp-group[data-g="${g.id}"] [data-sub]`); if (el) el.textContent = `${g.items.filter((i) => i.packed).length} of ${g.items.length} packed · ${T.kgText(g.items.reduce((a, i) => a + (i.kg || 0), 0))}`; }
  }
  const redrawGroups = (t) => { const g = $("trGroups"); if (g) g.innerHTML = groupsHtml(t); refresh(t); };
  function open(id) { cur = id; editItem = adding = editGroup = ask = null; newList = false; render(); window.scrollTo({ top: 0 }); }

  async function create() {
    const t = T.newTrip(); t.title = "New trip"; trips.push(t); touch(t); await flush(); open(t.id);
    const el = $("trTitle"); if (el) { el.focus(); el.select(); }
  }
  async function removeTrip(t) {
    try { const r = await fetch("/api/trips/" + t.id, { method: "DELETE", credentials: "same-origin", redirect: "error" }); if (!r.ok) throw new Error("HTTP " + r.status); }
    catch (e) { say("Could not delete the trip: " + e.message, "err"); return; }
    trips = trips.filter((x) => x.id !== t.id); dirty.delete(t.id); cur = null; ask = null; render(); renderOverview(); say("Trip deleted");
  }

  // ---------- events ----------
  function onClick(e) {
    const a = e.target.closest("[data-a]"); if (!a) return; const act = a.dataset.a, t = cur && find(cur), itemEl = a.closest("[data-item]"), gEl = a.closest("[data-g]");
    const item = () => { const g = t.groups.find((x) => x.id === (gEl && gEl.dataset.g)); const i = g && g.items.find((x) => x.id === (itemEl && itemEl.dataset.item)); return { g, i }; };
    if (act === "open") return open(a.dataset.id);
    if (act === "new") return void create();
    if (act === "back") { flush(); cur = null; render(); return; }
    if (!t) return;
    const redraw = () => redrawGroups(t);
    if (act === "ck") { const { i } = item(); i.packed = !i.packed; touch(t); return redraw(); }
    if (act === "bag") { const { i } = item(); i.bag = i.bag === "carry" ? "dive" : "carry"; touch(t); return redraw(); }
    if (act === "edit") { editItem = itemEl.dataset.item; adding = null; redraw(); const n = document.querySelector(`.tp-edit[data-item="${editItem}"] [data-f=name]`); if (n) n.focus(); return; }
    if (act === "setbag") { const { i } = item(); i.bag = a.dataset.bag; touch(t); return redraw(); }
    if (act === "item-done") { editItem = null; return redraw(); }
    if (act === "item-del") { const { g, i } = item(); g.items = g.items.filter((x) => x !== i); editItem = null; touch(t); return redraw(); }
    if (act === "add") { adding = { gid: a.closest("[data-g]").dataset.g, bag: /camera/i.test(t.groups.find((g) => g.id === a.closest("[data-g]").dataset.g).name) ? "carry" : "dive" }; editItem = null; redraw(); const n = document.querySelector("[data-f=anew]"); if (n) n.focus(); return; }
    if (act === "addbag") { adding.bag = a.dataset.bag; const name = document.querySelector("[data-f=anew]").value, kg = document.querySelector("[data-f=akg]").value; redraw(); document.querySelector("[data-f=anew]").value = name; document.querySelector("[data-f=akg]").value = kg; return; }
    if (act === "add-cancel") { adding = null; return redraw(); }
    if (act === "add-ok") {
      const g = t.groups.find((x) => x.id === adding.gid), name = document.querySelector("[data-f=anew]").value.trim().replace(/\s+/g, " "), kg = kgIn(document.querySelector("[data-f=akg]").value);
      if (!name) { document.querySelector("[data-f=anew]").focus(); return say("Give the item a name", "warn"); } if (Number.isNaN(kg) || (kg != null && kg > 100)) return say("The weight is a number of kg, 0 to 100", "warn");
      g.items.push({ id: T.newId(), name: name.slice(0, 80), kg: kg || 0, bag: adding.bag, packed: false }); adding = { gid: g.id, bag: adding.bag }; touch(t); redraw(); const n = document.querySelector("[data-f=anew]"); if (n) n.focus(); return;
    }
    if (act === "gedit") { editGroup = gEl.dataset.g; ask = null; return redraw(); }
    if (act === "gdone") { editGroup = null; ask = null; return redraw(); }
    if (act === "gdel") { ask = "g:" + editGroup; return redraw(); }
    if (act === "gdel-ok") { t.groups = t.groups.filter((g) => g.id !== editGroup); editGroup = null; ask = null; touch(t); return redraw(); }
    if (act === "ask-no") { ask = null; return a.closest("#trGroups") ? redraw() : render(); }
    if (act === "list-new") { newList = true; redraw(); const n = document.querySelector("[data-f=lname]"); if (n) n.focus(); return; }
    if (act === "list-cancel") { newList = false; return redraw(); }
    if (act === "list-ok") { const name = document.querySelector("[data-f=lname]").value.trim().replace(/\s+/g, " "); if (!name) return say("Give the list a name", "warn"); if (t.groups.length >= 12) return say("You can have up to 12 lists", "warn"); t.groups.push({ id: T.newId(), name: name.slice(0, 60), items: [] }); newList = false; touch(t); return redraw(); }
    if (act === "reset") { ask = "reset"; return redraw(); }
    if (act === "reset-ok") { t.groups = T.defaultGroups(); ask = null; editItem = adding = editGroup = null; touch(t); return redraw(); }
    if (act === "trip-del") { ask = "trip"; return render(); }
    if (act === "trip-del-ok") return void removeTrip(t);
  }
  function onInput(e) {
    const f = e.target.dataset && e.target.dataset.f; if (!f || !cur) return; const t = find(cur); if (!t) return; const v = e.target.value;
    const bad = (m) => { const el = $("trErr"); if (el) { el.textContent = m; el.style.color = m ? "var(--tx-c92a2a)" : ""; } };
    if (f === "title") { t.title = v.slice(0, 100); bad(t.title.trim() ? "" : "A trip needs a title."); return touch(t); }
    if (f === "destination") { t.destination = v.slice(0, 120); return touch(t); }
    if (f === "start" || f === "end") {
      t[f] = v; if (t.start && t.end && t.end < t.start) { bad("The trip ends before it starts."); dirty.delete(t.id); setState(""); } else { bad(""); touch(t); } return refresh(t);
    }
    if (f === "ldive" || f === "lcarry" || f === "ltotal") { const n = kgIn(v); if (Number.isNaN(n) || (n != null && n > 400)) { e.target.setAttribute("aria-invalid", "true"); return; } e.target.removeAttribute("aria-invalid"); t.limits = { ...(t.limits || {}), [f === "ldive" ? "dive" : f === "lcarry" ? "carry" : "total"]: n }; touch(t); return refresh(t); }
    const el = e.target.closest("[data-item]"), g = e.target.closest("[data-g]");
    if (f === "name" && el) { const gr = t.groups.find((x) => x.id === g.dataset.g), i = gr.items.find((x) => x.id === el.dataset.item); if (v.trim()) { i.name = v.trim().slice(0, 80); touch(t); } return; }
    if (f === "kg" && el) { const gr = t.groups.find((x) => x.id === g.dataset.g), i = gr.items.find((x) => x.id === el.dataset.item), n = kgIn(v); if (Number.isNaN(n) || (n != null && n > 100)) { e.target.setAttribute("aria-invalid", "true"); return; } e.target.removeAttribute("aria-invalid"); i.kg = n || 0; touch(t); return refresh(t); }
    if (f === "gname") { const gr = t.groups.find((x) => x.id === editGroup); if (gr && v.trim()) { gr.name = v.trim().slice(0, 60); touch(t); const h = document.querySelector(`.tp-group[data-g="${gr.id}"] .tp-ghead b`); if (h) h.textContent = gr.name; } }
  }
  function onKey(e) {
    if (e.key === "Enter" || e.key === " ") { const r = e.target.closest('[role="button"][data-a="open"]'); if (r && e.target === r) { e.preventDefault(); r.click(); return; } }
    if (e.key === "Enter" && e.target.dataset) { const f = e.target.dataset.f; if (f === "anew" || f === "akg") { e.preventDefault(); document.querySelector('[data-a="add-ok"]').click(); } else if (f === "lname") { e.preventDefault(); document.querySelector('[data-a="list-ok"]').click(); } else if (f === "name" || f === "kg" || f === "gname") { e.preventDefault(); const d = document.querySelector('[data-a="item-done"],[data-a="gdone"]'); if (d) d.click(); } }
    if (e.key === "Escape") { const c = document.querySelector('[data-a="add-cancel"],[data-a="list-cancel"],[data-a="item-done"]'); if (c) c.click(); }
  }
  function init() {
    const v = $("tripsView"); if (v) { v.addEventListener("click", onClick); v.addEventListener("input", onInput); v.addEventListener("keydown", onKey); }
    const s = $("sumTrip"); if (s) { s.addEventListener("click", () => { window.showView("trips"); open(s.dataset.id); }); s.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); s.click(); } }); }
    load();
  }
  /** The Trips tab was opened. */
  function show() { cur = cur && find(cur) ? cur : null; render(); load(); }
  window.Trips = { init, show, load, render };
})();
