/* Bluetooth lab: a read-only sandbox to see how a dive computer talks Bluetooth LE (page: bluetooth-lab.html).
 * 1. browser checks, 2. listen for advertisements (needs Chrome's experimental requestLEScan), 3. connect and list services/characteristics,
 * 4. the Shearwater handshake (serial/firmware/model), 5. a report to copy. Nothing here writes to a device except the Shearwater handshake's
 * three read requests. Everything that comes from a device is shown as text, never as HTML. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SW = typeof Shearwater !== "undefined" ? Shearwater : null;
  const SHEARWATER_UUID = SW ? SW.SERVICE_UUID : "fe25c237-0ece-443c-b0aa-e02033e7029d";
  const NAME_RE = /peregrine|perdix|petrel|teric|tern\b|nerd|shearwater/i;
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join(" ");
  const bytesOf = (dv) => new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const ts = () => new Date().toISOString().slice(11, 23);
  const canon = (n) => "0000" + n.toString(16).padStart(4, "0") + "-0000-1000-8000-00805f9b34fb";
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const KNOWN = { [canon(0x1800)]: "Generic Access", [canon(0x1801)]: "Generic Attribute", [canon(0x180a)]: "Device Information", [canon(0x180f)]: "Battery", [SHEARWATER_UUID]: "Shearwater data service",
    "6e400001-b5a3-f393-e0a9-e50e24dcca9e": "Nordic UART", [canon(0xffe0)]: "serial (HM-10 style)", [canon(0xfff0)]: "vendor serial", [canon(0xfe59)]: "Nordic DFU" };
  const CHARS = { [canon(0x2a00)]: "device name", [canon(0x2a01)]: "appearance", [canon(0x2a19)]: "battery level", [canon(0x2a24)]: "model number", [canon(0x2a25)]: "serial number", [canon(0x2a26)]: "firmware", [canon(0x2a27)]: "hardware", [canon(0x2a28)]: "software", [canon(0x2a29)]: "manufacturer" };
  /** Services the browser will let us look at: the page must name them up front, so it names every standard one plus the usual serial ones. */
  const CANDIDATES = (() => { const a = [SHEARWATER_UUID]; for (let n = 0x1800; n <= 0x185f; n++) a.push(canon(n)); for (const u of ["6e400001-b5a3-f393-e0a9-e50e24dcca9e", canon(0xffe0), canon(0xfff0), canon(0xfe59), canon(0xff00), canon(0xffe5), canon(0xfee0), canon(0xfd00)]) a.push(u); return a; })();

  // ---------- log and report ----------
  const lines = [], env = [], scan = { rows: new Map(), started: null, stopped: null }, inspect = { name: "", services: [], reads: [] }; let shake = null;
  let repTimer = 0;
  function log(msg, cls) {
    const line = ts() + "  " + msg; lines.push(line); if (lines.length > 4000) lines.shift();
    const el = $("log"); if (el) { const d = document.createElement("div"); d.textContent = line; if (cls) d.className = cls; el.appendChild(d); el.scrollTop = el.scrollHeight; }
    clearTimeout(repTimer); repTimer = setTimeout(refreshReport, 200);
  }
  const likely = (r) => NAME_RE.test(r.name || "") || r.uuids.has(SHEARWATER_UUID) || Object.keys(r.svc).some((k) => k.toLowerCase() === SHEARWATER_UUID);
  /** What the report means, in words: written for someone who does not read bytes. */
  function verdict() {
    const v = [], rows = [...scan.rows.values()], hasBt = env.some((e) => e.label === "Web Bluetooth" && e.state === "ok");
    if (env.length && !hasBt) v.push("This browser cannot use Bluetooth (use Chrome or Edge, or Bluefy on iPhone).");
    if (shake && shake.serial) v.push(`REACHABLE: ${shake.name} answered the Shearwater protocol (serial ${shake.serial}, firmware ${shake.firmware}, model number ${shake.model}${shake.modelName ? " = " + shake.modelName : ", not in the list of known models"}). Bluetooth works from this browser. Next: Dive log > Download dives over Bluetooth.`);
    else if (shake && shake.failed) v.push("The handshake failed: " + shake.failed);
    else if (inspect.services.some((s) => s.uuid === SHEARWATER_UUID)) v.push(`The device "${inspect.name}" offers the Shearwater data service. The handshake (section 4) has not been run yet.`);
    else if (inspect.name) v.push(`The device "${inspect.name}" was inspected but does not offer the Shearwater service.`);
    if (scan.started) v.push(`Listening: ${rows.length} devices heard, ${rows.filter(likely).length} look like a dive computer.`);
    else if ((env.find((e) => e.label === "Listening for advertisements") || {}).state !== "ok") v.push("Listening for advertisements was not available (optional: choosing a device in section 3 does not need it).");
    return v.length ? v : ["Nothing has been run yet."];
  }
  function refreshReport() {
    const only = $("onlyLikely") && $("onlyLikely").checked, rows = [...scan.rows.values()], shown = rows.filter((r) => !only || likely(r));
    const out = ["Dive Manager Bluetooth lab report", "Created: " + new Date().toISOString(), "App version: " + (self.APP_VERSION || "?"), "", "== Summary ==", ...verdict(), "", "== Browser =="];
    for (const e of env) out.push(`${e.label}: ${e.value}`);
    out.push("", "== Advertisement scan ==", scan.started ? `listened ${Math.round(((scan.stopped || Date.now()) - scan.started) / 1000)} s, ${rows.length} devices heard` + (only ? `, ${rows.length - shown.length} not listed (not dive-computer-like)` : "") : "not run");
    for (const r of shown.sort((a, b) => (b.rssi || -999) - (a.rssi || -999))) out.push(`- name="${r.name || ""}" likely=${likely(r)} rssi=${r.rssi} heard=${r.count}x announces=[${[...r.uuids].join(", ")}] mfr=${JSON.stringify(r.mfr)} serviceData=${JSON.stringify(r.svc)} txPower=${r.tx}`);
    out.push("", "== Inspected device ==");
    if (inspect.name) { out.push("name: " + inspect.name); for (const s of inspect.services) { out.push(`service ${s.uuid}${KNOWN[s.uuid] ? " (" + KNOWN[s.uuid] + ")" : ""}`); for (const c of s.chars) out.push(`  char ${c.uuid}${CHARS[c.uuid] ? " (" + CHARS[c.uuid] + ")" : ""}  [${c.props}]`); } for (const r of inspect.reads) out.push("read " + r); } else out.push("not run");
    out.push("", "== Shearwater handshake ==", shake ? JSON.stringify(shake) : "not run");
    const past = typeof BtLog !== "undefined" ? BtLog.list().slice(0, 5) : []; out.push("", "== Recent Bluetooth attempts on this device ==", past.length ? past.map((e) => BtLog.format(e)).join("\n\n") : "none");
    out.push("", "== Log ==", ...lines);
    const t = $("report"); if (t) t.value = out.join("\n");
  }

  // ---------- 1. browser checks ----------
  async function checkEnv() {
    const nav = navigator, b = nav.bluetooth, add = (label, value, state) => env.push({ label, value, state });
    add("Address", location.origin + (window.isSecureContext ? "  (secure)" : "  (NOT a secure page: Bluetooth is blocked)"), window.isSecureContext ? "ok" : "bad");
    const allB = (nav.userAgentData && nav.userAgentData.brands || []).filter((x) => !/not.a.brand/i.test(x.brand)), someB = allB.filter((x) => !/^chromium$/i.test(x.brand)), brands = (someB.length ? someB : allB).map((x) => x.brand + " " + x.version).join(", ");
    add("Browser", brands || nav.userAgent, "info"); add("System", (nav.userAgentData && nav.userAgentData.platform) || nav.platform || "?", "info");
    add("Web Bluetooth", b ? "available" : "NOT available in this browser", b ? "ok" : "bad");
    let avail = "unknown";
    if (b && b.getAvailability) { try { avail = (await b.getAvailability()) ? "a Bluetooth adapter is available" : "NO Bluetooth adapter found or it is switched off"; } catch (e) { avail = "could not be checked (" + e.message + ")"; } }
    add("Bluetooth adapter", avail, /^a Bluetooth/.test(avail) ? "ok" : /NO /.test(avail) ? "bad" : "info");
    add("Listening for advertisements", b && typeof b.requestLEScan === "function" ? "supported" : "switched off (needs a Chrome setting, see section 2)", b && typeof b.requestLEScan === "function" ? "ok" : "warn");
    add("Remembered devices", b && typeof b.getDevices === "function" ? "supported" : "not supported", "info");
    if (nav.permissions && nav.permissions.query) { try { const p = await nav.permissions.query({ name: "bluetooth" }); add("Bluetooth permission", p.state, p.state === "denied" ? "bad" : "info"); } catch (e) { /* not supported */ } }
    const tb = $("envTable"); tb.textContent = "";
    for (const e of env) { const tr = document.createElement("tr"), a = document.createElement("td"), v = document.createElement("td"); a.textContent = e.label; v.textContent = e.value; v.className = e.state === "ok" ? "ok" : e.state === "bad" ? "bad" : e.state === "warn" ? "warn" : ""; tr.append(a, v); tb.appendChild(tr); }
    const mac = /mac/i.test(((nav.userAgentData && nav.userAgentData.platform) || nav.platform || "")), hints = [];
    if (!b) hints.push("This browser has no Web Bluetooth. Use Chrome or Edge (Android, Windows, Mac, Linux). On an iPhone use the Bluefy browser: Safari cannot do it.");
    if (mac) hints.push("<b>On a Mac, the browser itself needs permission:</b> System Settings &rsaquo; Privacy &amp; Security &rsaquo; Bluetooth &rsaquo; switch <b>Google Chrome</b> (or your browser) on, then quit and reopen it. Without this the device list stays empty. Also check Bluetooth is on in the menu bar.");
    hints.push("A dive computer only talks to <b>one app at a time</b>. Quit Shearwater Cloud on every phone, tablet and computer nearby (its &ldquo;Auto Connect&rdquo; grabs the computer as soon as Bluetooth is switched on at the computer).");
    hints.push("Switch <b>Bluetooth on at the dive computer</b> and stay close to it (within a metre or two).");
    $("envHints").innerHTML = "<b>Checklist</b><ul>" + hints.map((h) => "<li>" + h + "</li>").join("") + "</ul>";
    log("Browser: " + env.map((e) => e.label + "=" + e.value).join(" | "));
  }

  // ---------- 2. advertisements ----------
  let scanHandle = null, scanTimer = 0, tick = 0;
  function onAdv(e) {
    const id = (e.device && e.device.id) || "?"; let r = scan.rows.get(id);
    if (!r) { r = { id, name: "", rssi: null, count: 0, uuids: new Set(), mfr: {}, svc: {}, tx: null }; scan.rows.set(id, r); }
    r.name = e.name || (e.device && e.device.name) || r.name; r.rssi = e.rssi; r.count++; r.tx = e.txPower == null ? r.tx : e.txPower;
    for (const u of e.uuids || []) r.uuids.add(u);
    if (e.manufacturerData) e.manufacturerData.forEach((dv, k) => { r.mfr["0x" + Number(k).toString(16).padStart(4, "0")] = hex(bytesOf(dv)); });
    if (e.serviceData) e.serviceData.forEach((dv, k) => { r.svc[k] = hex(bytesOf(dv)); });
  }
  function drawScan() {
    const tb = $("scanTable").tBodies[0], named = $("scanNamed").checked; tb.textContent = "";
    const rows = [...scan.rows.values()].filter((r) => !named || r.name).sort((a, b) => (likely(b) - likely(a)) || ((b.rssi || -999) - (a.rssi || -999)));
    for (const r of rows) {
      const tr = document.createElement("tr"); if (likely(r)) tr.className = "likely";
      const c = (t) => { const td = document.createElement("td"); td.textContent = t; return td; };
      const n = c(r.name || "(no name)"); if (likely(r)) { const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "likely"; tag.style.marginLeft = "6px"; n.appendChild(tag); }
      tr.append(n, c(r.rssi == null ? "" : r.rssi + " dBm"), c(r.count + "×"), c([...r.uuids].map((u) => KNOWN[u] || u).join(", ")), c(Object.entries(r.mfr).map(([k, v]) => k + ": " + v).join("; ")));
      tr.lastChild.className = "mono"; tb.appendChild(tr);
    }
    $("scanNone").style.display = rows.length ? "none" : "";
    $("scanState").textContent = scanHandle ? `listening… ${rows.length} device${rows.length === 1 ? "" : "s"} heard` : scan.started ? `stopped, ${scan.rows.size} device${scan.rows.size === 1 ? "" : "s"} heard` : "";
  }
  async function startScan() {
    const b = navigator.bluetooth, help = $("scanHelp");
    if (!b || typeof b.requestLEScan !== "function") {
      help.style.display = ""; help.innerHTML = "<b>One browser setting is needed.</b> Listening is still an experimental Chrome feature. In Chrome open <code>chrome://flags/#enable-experimental-web-platform-features</code> (type it in the address bar), set it to <b>Enabled</b>, press <b>Relaunch</b>, then come back here. If you cannot, skip to section 3: it works without the setting.";
      log("Listening is not available: requestLEScan is switched off in this browser", "warn"); return;
    }
    help.style.display = "none"; scan.rows.clear(); scan.started = Date.now(); scan.stopped = null;
    try { scanHandle = await b.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true }); }
    catch (e) { log("Could not start listening: " + e.name + ": " + e.message, "bad"); $("scanState").textContent = e.name === "NotAllowedError" ? "not allowed: check the browser's Bluetooth permission (section 1)" : e.message; scan.started = null; return; }
    b.addEventListener("advertisementreceived", onAdv); $("scanStart").disabled = true; $("scanStop").disabled = false; log("Listening for advertisements");
    tick = setInterval(drawScan, 500); scanTimer = setTimeout(stopScan, 60000); drawScan();
  }
  function stopScan() {
    clearTimeout(scanTimer); clearInterval(tick); try { if (scanHandle && scanHandle.stop) scanHandle.stop(); } catch (e) { /* already stopped */ }
    scanHandle = null; try { navigator.bluetooth.removeEventListener("advertisementreceived", onAdv); } catch (e) { /* ignore */ }
    scan.stopped = Date.now(); $("scanStart").disabled = false; $("scanStop").disabled = true; drawScan();
    const all = [...scan.rows.values()]; log(`Stopped listening: ${all.length} devices heard, ${all.filter(likely).length} look like a dive computer`);
  }

  // ---------- 3. connect and look inside ----------
  let connected = null; const charStore = [];
  const props = (c) => ["broadcast", "read", "writeWithoutResponse", "write", "notify", "indicate"].filter((k) => c.properties && c.properties[k]).join(", ");
  const showVal = (dv) => { const b = bytesOf(dv), txt = Array.from(b, (x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join(""); return `${hex(b)}  "${txt}"`; };
  async function inspectDevice() {
    const b = navigator.bluetooth; if (!b) { $("inspectState").textContent = "This browser cannot use Bluetooth."; return; }
    const extra = $("extraUuid").value.trim().toLowerCase(), services = CANDIDATES.slice();
    if (extra) { if (!UUID_RE.test(extra) && !/^[0-9a-f]{4}$/.test(extra)) { $("inspectState").textContent = "That is not a UUID (like 6e400001-b5a3-f393-e0a9-e50e24dcca9e, or 4 hex digits)."; return; } services.push(extra.length === 4 ? canon(parseInt(extra, 16)) : extra); }
    $("inspectState").textContent = "Choose the device in the browser's list…"; $("tree").textContent = ""; inspect.name = ""; inspect.services = []; inspect.reads = []; charStore.length = 0;
    let dev; try { dev = await b.requestDevice({ acceptAllDevices: true, optionalServices: services }); }
    catch (e) { $("inspectState").textContent = e.name === "NotFoundError" ? "No device was chosen." : e.name + ": " + e.message; log("Choose device: " + e.name + ": " + e.message, e.name === "NotFoundError" ? "" : "bad"); return; }
    inspect.name = dev.name || "(no name)"; log("Chosen: " + inspect.name); $("inspectState").textContent = "Connecting to " + inspect.name + "…";
    let server; try { server = await dev.gatt.connect(); } catch (e) { $("inspectState").textContent = "Could not connect: " + e.message + ". Is another app connected to it?"; log("Connect failed: " + e.name + ": " + e.message, "bad"); return; }
    connected = dev; $("inspectDisc").disabled = false; dev.addEventListener("gattserverdisconnected", () => { log("Device disconnected"); $("inspectDisc").disabled = true; $("inspectState").textContent = "Disconnected."; });
    let svcs = []; try { svcs = await server.getPrimaryServices(); } catch (e) { log("No services visible: " + e.name + ": " + e.message, "warn"); }
    $("inspectState").textContent = `Connected to ${inspect.name}. ${svcs.length} service${svcs.length === 1 ? "" : "s"} visible` + (svcs.length ? "." : ". The device may offer services this page did not know to ask for: paste a UUID from section 2 above and try again.");
    const tree = $("tree");
    for (const s of svcs) {
      const entry = { uuid: s.uuid, chars: [] }; inspect.services.push(entry);
      const li = document.createElement("li"), head = document.createElement("div"), ul = document.createElement("ul");
      head.innerHTML = ""; const strong = document.createElement("b"); strong.textContent = (KNOWN[s.uuid] || "Service"); const code = document.createElement("code"); code.textContent = " " + s.uuid; head.append(strong, code);
      if (s.uuid === SHEARWATER_UUID) { const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "Shearwater"; tag.style.marginLeft = "6px"; head.appendChild(tag); }
      li.append(head, ul); tree.appendChild(li);
      let chars = []; try { chars = await s.getCharacteristics(); } catch (e) { log("Characteristics of " + s.uuid + ": " + e.name + ": " + e.message, "warn"); }
      for (const c of chars) {
        const p = props(c); entry.chars.push({ uuid: c.uuid, props: p }); const idx = charStore.push(c) - 1;
        const cli = document.createElement("li"), t = document.createElement("span"); t.innerHTML = ""; const cc = document.createElement("code"); cc.textContent = c.uuid; const lbl = document.createElement("span"); lbl.className = "muted"; lbl.textContent = (CHARS[c.uuid] ? "  " + CHARS[c.uuid] : "") + "  [" + p + "]  ";
        t.append(cc, lbl); cli.appendChild(t);
        const out = document.createElement("div"); out.className = "mono"; out.style.wordBreak = "break-all";
        if (c.properties.read) { const rb = document.createElement("button"); rb.type = "button"; rb.className = "alt"; rb.textContent = "Read"; rb.style.minHeight = "32px"; rb.style.padding = "4px 10px"; rb.dataset.act = "read"; rb.dataset.i = idx; cli.appendChild(rb); }
        if (c.properties.notify || c.properties.indicate) { const nb = document.createElement("button"); nb.type = "button"; nb.className = "alt"; nb.textContent = "Listen"; nb.style.minHeight = "32px"; nb.style.padding = "4px 10px"; nb.style.marginLeft = "6px"; nb.dataset.act = "notify"; nb.dataset.i = idx; cli.appendChild(nb); }
        cli.appendChild(out); cli._out = out; c._li = cli; ul.appendChild(cli);
        if (c.properties.read && (s.uuid === canon(0x1800) || s.uuid === canon(0x180a) || s.uuid === canon(0x180f))) {       // harmless identity and battery values: read straight away
          try { const v = showVal(await c.readValue()); out.textContent = v; inspect.reads.push(`${CHARS[c.uuid] || c.uuid}: ${v}`); log(`Read ${CHARS[c.uuid] || c.uuid}: ${v}`); } catch (e) { out.textContent = e.name + ": " + e.message; }
        }
      }
    }
    log(`Inspected ${inspect.name}: ${inspect.services.length} services, ${inspect.services.reduce((n, s) => n + s.chars.length, 0)} characteristics`);
  }
  async function charAction(e) {
    const b = e.target.closest("button[data-act]"); if (!b) return; const c = charStore[Number(b.dataset.i)], out = c._li._out;
    try {
      if (b.dataset.act === "read") { const v = showVal(await c.readValue()); out.textContent = v; inspect.reads.push(`${CHARS[c.uuid] || c.uuid}: ${v}`); log(`Read ${c.uuid}: ${v}`); }
      else if (c._h) { c.removeEventListener("characteristicvaluechanged", c._h); c._h = null; try { await c.stopNotifications(); } catch (e2) { /* the device may already be gone */ } b.textContent = "Listen"; out.textContent = "stopped"; log("Stopped listening to " + c.uuid); }
      else { await c.startNotifications(); b.textContent = "Stop"; out.textContent = "listening…"; c._h = (ev) => { const v = showVal(ev.target.value); out.textContent = v; log(`Notify ${c.uuid}: ${v}`); }; c.addEventListener("characteristicvaluechanged", c._h); log("Listening to " + c.uuid); }
    } catch (err) { out.textContent = err.name + ": " + err.message; log(`${b.dataset.act} ${c.uuid}: ${err.name}: ${err.message}`, "bad"); }
  }

  // ---------- 4. the Shearwater handshake ----------
  async function handshake() {
    const st = $("shakeState"); if (!SW) { st.textContent = "The Shearwater code did not load."; return; }
    st.textContent = "Choose the dive computer in the browser's list…"; st.className = "muted"; let conn = null;
    const L = typeof BtLog !== "undefined" ? BtLog.begin({ kind: "handshake", device: "shearwater", model: "Shearwater (lab)" }) : null; L && L.step("Choose the dive computer in the list");
    try {
      conn = await SW.connect((l) => { log("  " + l); L && L.trace(l); }); st.textContent = "Connected to " + conn.name + ". Asking…"; log("Handshake: connected to " + conn.name); L && (L.info({ deviceName: conn.name }), L.step("Connected to " + conn.name));
      const id = await SW.identify(conn.io); shake = { name: conn.name, ...id }; st.textContent = `Answered: serial ${id.serial}, firmware ${id.firmware}, model number ${id.model}${id.modelName ? " (" + id.modelName + ")" : ""}. The download will work.`; st.className = "ok";
      log("Handshake OK: " + JSON.stringify(shake)); L && (L.info({ serial: id.serial, firmware: id.firmware, model: id.model }), L.end(true, "The computer answered."));
    } catch (e) {
      const m = e && e.name === "NotFoundError" ? "No device was chosen." : (e && e.message) || String(e); if (!(e && e.name === "NotFoundError")) shake = { failed: m }; st.textContent = m; st.className = e && e.name === "NotFoundError" ? "muted" : "bad"; log("Handshake failed: " + m, "bad"); L && L.end(false, m, { cancelled: !!(e && e.name === "NotFoundError") });
    } finally { if (conn) conn.close(); refreshReport(); }
  }

  // ---------- 5. report ----------
  async function copyReport() {
    refreshReport(); const t = $("report"); let ok = false;
    try { await navigator.clipboard.writeText(t.value); ok = true; } catch (e) { t.select(); try { ok = document.execCommand("copy"); } catch (e2) { /* ignore */ } }
    $("repState").textContent = ok ? "Copied." : "Select the text and copy it by hand.";
  }
  async function sendReport() {
    refreshReport(); const st = $("repState"), body = $("report").value.slice(0, 195000);
    try { const r = await fetch("/api/bt-reports", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "lab", body }) }); const j = await r.json().catch(() => ({}));
      st.textContent = r.ok ? `Sent to your account (report #${j.id}). It can now be looked at.` : (j.error || "Could not send (" + r.status + ")"); log(r.ok ? "Report sent to your account as #" + j.id : "Report not sent: " + r.status); }
    catch (e) { st.textContent = "Could not send: " + e.message; }
  }
  function saveReport() { refreshReport(); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([$("report").value], { type: "text/plain" })); a.download = "bluetooth-lab-report.txt"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }

  window.addEventListener("DOMContentLoaded", async () => {
    $("scanStart").addEventListener("click", startScan); $("scanStop").addEventListener("click", stopScan); $("scanNamed").addEventListener("change", drawScan);
    $("inspectBtn").addEventListener("click", inspectDevice); $("tree").addEventListener("click", charAction);
    $("inspectDisc").addEventListener("click", () => { try { if (connected) connected.gatt.disconnect(); } catch (e) { /* ignore */ } });
    $("shakeBtn").addEventListener("click", handshake); $("repCopy").addEventListener("click", copyReport); $("repSave").addEventListener("click", saveReport); $("repSend").addEventListener("click", sendReport); $("onlyLikely").addEventListener("change", refreshReport);
    $("repClear").addEventListener("click", () => { lines.length = 0; $("log").textContent = ""; scan.rows.clear(); scan.started = null; inspect.name = ""; inspect.services = []; inspect.reads = []; shake = null; drawScan(); refreshReport(); $("repState").textContent = "Cleared."; });
    await checkEnv(); refreshReport(); window.__labReady = true;
  });
})();
