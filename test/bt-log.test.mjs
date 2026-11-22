import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
const mem = new Map(); let full = false;
globalThis.self = { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { if (full) throw new Error("QuotaExceededError"); mem.set(k, v); }, removeItem: (k) => mem.delete(k) },
  navigator: { userAgentData: { platform: "macOS", brands: [{ brand: "Not A Brand", version: "8" }, { brand: "Google Chrome", version: "140" }] }, onLine: true }, APP_VERSION: "9.9.9" };
const L = createRequire(import.meta.url)("../public/bt-log.js");
const reset = () => { mem.clear(); full = false; };

test("an attempt is written down as it happens and survives a reload (stored on the device)", async () => {
  reset(); const h = L.begin({ kind: "download", device: "peregrine", model: "Peregrine" });
  assert.equal(L.list().length, 1, "stored at once, so even an attempt that never finishes is there"); assert.equal(L.list()[0].outcome, null);
  h.step("Choose your Peregrine in the list…"); h.step("Choose your Peregrine in the list…"); h.step("Connected to Peregrine."); h.info({ deviceName: "Peregrine" }); h.trace("TX 7e 01"); h.trace("RX 7e 02");
  h.info({ serial: "12345678", firmware: "v95", model: 8, total: 3, fresh: 2, failed: 1 }); h.end(true, "Peregrine: 3 on the dive computer, 2 new");
  const [e] = L.list(); assert.equal(e.outcome.ok, true); assert.equal(e.steps.length, 2, "the same line twice in a row is one step"); assert.deepEqual(e.env, { browser: "Google Chrome 140", system: "macOS", app: "9.9.9", online: true }, "the \"Not A Brand\" placeholder is left out");
  const t = L.format(e); for (const must of ["=== Download: Peregrine ===", "Computer: Peregrine (peregrine), Bluetooth name \"Peregrine\"", "Browser: Google Chrome 140 | System: macOS | App: 9.9.9", "Result: OK - Peregrine: 3 on the dive computer, 2 new", "Identity: serial 12345678, firmware v95, model number 8 (not in the list of known models)", "Counts: 3 on the computer, 2 new, 1 could not be read", "== Steps ==", "+0.00s  Choose your Peregrine", "Connected to Peregrine.", "== Bytes exchanged (2 lines; TX = sent, RX = received, NOTE = what it means) ==", "s TX 7e 01", "s RX 7e 02"]) assert.ok(t.includes(must), "has: " + must + "\n" + t);
});

test("a failure, a cancel and an interrupted attempt read differently; newest first; summary lines", () => {
  reset(); const a = L.begin({ kind: "test", device: "perdix", model: "Perdix" }); a.end(false, "does not offer the Shearwater service"); const b = L.begin({ kind: "download", device: "perdix", model: "Perdix" }); b.end(false, "No dive computer was chosen.", { cancelled: true }); L.begin({ kind: "download", device: "peregrine", model: "Peregrine" });
  const l = L.list(); assert.deepEqual(l.map((e) => e.device), ["peregrine", "perdix", "perdix"]);
  assert.match(L.format(l[0]), /Result: no result \(the page was closed or reloaded during the attempt\)/); assert.match(L.format(l[1]), /Result: CANCELLED - No dive computer was chosen\./); assert.match(L.format(l[2]), /=== Bluetooth test: Perdix ===[\s\S]*Result: FAILED - does not offer/);
  assert.match(L.summary(l[0]), /Download {2}Peregrine {2}interrupted$/); assert.match(L.summary(l[2]), /Bluetooth test {2}Perdix {2}FAILED - does not offer the Shearwater service$/);
  assert.match(L.formatAll(l), /Attempts: 3/); assert.equal(L.formatAll([]), "No Bluetooth attempts recorded on this device yet.");
});

test("limits: the newest 25 attempts, a long download keeps the start and the end of the bytes, long lines are cut, a full storage does not break anything", () => {
  reset(); for (let i = 0; i < 40; i++) L.begin({ kind: "test", device: "peregrine", model: "P" + i }).end(true, "ok"); const l = L.list(); assert.equal(l.length, 25); assert.equal(l[0].model, "P39"); assert.equal(l[24].model, "P15");
  const h = L.begin({ kind: "download", device: "peregrine", model: "Peregrine" }); for (let i = 0; i < 5000; i++) h.trace("TX " + i + " " + "ab ".repeat(100)); for (let i = 0; i < 600; i++) h.step("Downloading dive " + i);
  h.end(true, "x".repeat(2000)); const e = L.list()[0]; assert.equal(e.trace.length, 150); assert.ok(e.trace.every((s) => s.length <= 160 + 14), "long lines are cut"); assert.equal(e.traceSkipped, 4850); assert.ok(/^\+\d+\.\d{3}s TX 0 /.test(e.trace[0]) && /TX 4999 /.test(e.trace.at(-1)), "first and last bytes kept, each with the time since the attempt began");
  assert.ok(e.steps.length <= 250 && e.steps[0][1] === "Downloading dive 0" && e.steps.at(-1)[1] === "Downloading dive 599", "steps capped, first and last kept"); assert.ok(e.outcome.text.length <= 500);
  const t = L.format(e); assert.match(t, /5000 lines, 4850 in the middle left out/); assert.ok(t.includes("  ...\n"), "a gap marker where bytes were left out");
  assert.ok(JSON.stringify(L.list()).length <= 150000, "the stored log stays under its size cap");
  full = true; assert.doesNotThrow(() => L.begin({ kind: "test", device: "x", model: "x" }).end(true, "ok"), "a full or blocked storage is not an error");
});

test("clear, and text from a device is never treated as markup", () => {
  reset(); const h = L.begin({ kind: "test", device: "peregrine", model: "<b>x</b>" }); h.info({ deviceName: "<img src=x onerror=alert(1)>" }); h.end(true, "ok");
  assert.match(L.format(L.list()[0]), /<img src=x onerror=alert\(1\)>/, "kept as plain text (it is only ever shown with textContent)"); L.clear(); assert.deepEqual(L.list(), []);
  mem.set("btLog", "not json"); assert.deepEqual(L.list(), [], "a damaged log reads as empty"); mem.set("btLog", '{"a":1}'); assert.deepEqual(L.list(), []);
});

test("a known model is named in the log, and the placeholder browser brands are tidied", () => {
  reset(); const h = L.begin({ kind: "download", device: "peregrine", model: "Peregrine" }); h.info({ serial: "93D47FB9", firmware: "V89 Classic", model: 9, modelName: "Peregrine" }); h.end(true, "ok");
  assert.match(L.format(L.list()[0]), /Identity: serial 93D47FB9, firmware V89 Classic, model number 9 \(Peregrine\)/);
  self.navigator = { userAgentData: { platform: "macOS", brands: [{ brand: "Google Chrome", version: "157" }, { brand: "Chromium", version: "157" }, { brand: "Not=A?Brand", version: "24" }] }, onLine: true };
  assert.equal(L.begin({ kind: "test", device: "x", model: "x" }).entry.env.browser, "Google Chrome 157", "Chromium is not listed a second time next to Chrome");
});
