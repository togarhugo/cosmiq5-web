import { createRequire } from "node:module";
import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";
const I = createRequire(import.meta.url)("../public/dive-import.js");
const parse = (xml, dev = "peregrine") => I.parseUddf(xml, dev, DOMParser);

// A UDDF 3.2 file in the standard layout (SI units: seconds, metres, Kelvin, fractions).
const wp = (t, d, k, extra = "") => `<waypoint><divetime>${t}</divetime><depth>${d}</depth>${k == null ? "" : `<temperature>${k}</temperature>`}${extra}</waypoint>`;
const dive = ({ id = "d1", when = "2026-05-02T09:30:15", num = 12, wps, greatest = 28.4, dur = 2700, low = 301.15, mix = "air" } = {}) => `<dive id="${id}">
  <informationbeforedive><datetime>${when}</datetime>${num == null ? "" : `<divenumber>${num}</divenumber>`}</informationbeforedive>
  <tankdata><link ref="${mix}"/></tankdata>
  <samples>${wps || [wp(0, 0, 302.15), wp(10, 5.5, 301.65), wp(20, 12.1, 301.15), wp(30, 28.4, 301.15), wp(40, 3.2, 301.65)].join("")}</samples>
  <informationafterdive>${greatest == null ? "" : `<greatestdepth>${greatest}</greatestdepth>`}${dur == null ? "" : `<diveduration>${dur}</diveduration>`}${low == null ? "" : `<lowesttemperature>${low}</lowesttemperature>`}</informationafterdive></dive>`;
const file = (dives, ns = ' xmlns="http://www.streit.cc/uddf/3.2/"') => `<?xml version="1.0" encoding="UTF-8"?><uddf version="3.2.0"${ns}><generator><name>Shearwater Cloud</name></generator>
  <gasdefinitions><mix id="air"><name>Air</name><o2>0.21</o2><n2>0.79</n2></mix><mix id="ean32"><name>EAN32</name><o2>0.32</o2><n2>0.68</n2></mix></gasdefinitions>
  <profiledata><repetitiongroup id="rg1">${dives}</repetitiongroup></profiledata></uddf>`;

test("parseUddf: reads start time, number, depth, duration, temperature (Kelvin -> Celsius), gas and samples", () => {
  const { dives, skipped } = parse(file(dive({ mix: "ean32" })));
  assert.equal(skipped, 0); assert.equal(dives.length, 1);
  const d = dives[0];
  assert.equal(d.startedAt, "2026-05-02T09:30:00", "seconds dropped, like the Cosmiq log"); assert.equal(d.device, "peregrine"); assert.equal(d.mode, "scuba");
  assert.equal(d.number, 12); assert.equal(d.maxDepthM, 28.4); assert.equal(d.durationSec, 2700); assert.equal(d.minTempC, 28); assert.equal(d.o2Percent, 32); assert.equal(d.intervalSec, 10);
  assert.deepEqual(d.samples[0], [0, 0, 29]); assert.deepEqual(d.samples[3], [30, 28.4, 28]); assert.equal(d.samples.length, 5);
  assert.match(d.fingerprint, /^[0-9a-f]{12}$/);
});

test("parseUddf: tolerant of real-world differences", () => {
  // no namespace, Celsius written as Celsius, no dive number, no after-dive block (falls back to the samples), prefixed elements
  const bare = file(dive({ num: null, greatest: null, dur: null, low: null, wps: [wp(0, 0, 29.5), wp(60, 18, 28.1), wp(120, 4.5, 28.4)].join("") }), "");
  const d = parse(bare).dives[0];
  assert.equal(d.number, null); assert.equal(d.maxDepthM, 18); assert.equal(d.durationSec, 120); assert.equal(d.minTempC, 28.1, "Celsius values are not converted twice");
  const prefixed = file(dive(), ' xmlns:u="http://www.streit.cc/uddf/3.2/"').replace(/<(\/?)(uddf|dive|waypoint|depth|divetime|datetime|informationbeforedive|informationafterdive|greatestdepth|diveduration|samples)\b/g, "<$1u:$2").replace("<u:uddf ", "<u:uddf ").replace(' xmlns:u=', ' xmlns:u=');
  assert.equal(parse(prefixed).dives.length, 1, "namespace prefixes");
  // depth-less waypoints (gas switch markers) and a time zone suffix
  const marked = dive({ when: "2026-05-02T09:30:00+07:00", wps: [wp(0, 0, 300), `<waypoint><divetime>5</divetime><switchmix ref="ean32"/></waypoint>`, wp(10, 6, 300)].join("") });
  const m = parse(file(marked)).dives[0]; assert.equal(m.samples.length, 2, "marker without depth is not a sample"); assert.equal(m.startedAt, "2026-05-02T09:30:00", "zone suffix dropped, clock time kept"); assert.equal(m.o2Percent, 32, "gas from the switch marker");
  assert.equal(parse(file(dive({ mix: "unknown" }))).dives[0].o2Percent, null, "unknown gas stays blank");
});

test("parseUddf: several dives, incomplete ones skipped, same file twice gives the same fingerprints", () => {
  const xml = file(dive({ id: "a", when: "2026-05-02T09:30:00" }) + dive({ id: "b", when: "2026-05-02T13:10:00", num: 13 }) + dive({ id: "c", when: "not a date" }) + dive({ id: "d", when: "2026-05-03T09:00:00", dur: 0, greatest: null, wps: "" }));
  const r = parse(xml); assert.equal(r.dives.length, 2); assert.equal(r.skipped, 2);
  assert.deepEqual(parse(xml).dives.map((d) => d.fingerprint), r.dives.map((d) => d.fingerprint), "stable");
  assert.notEqual(r.dives[0].fingerprint, r.dives[1].fingerprint);
  assert.notEqual(I.fingerprint("peregrine|2026-05-02T09:30"), I.fingerprint("cosmiq|2026-05-02T09:30"), "per computer");
  assert.equal(parse(xml, "peregrine").dives[0].fingerprint, I.fingerprint("peregrine|2026-05-02T09:30"), "depends on the computer and the minute only");
});

test("parseUddf: long profiles are thinned but keep the deepest point and the last sample", () => {
  const wps = []; for (let t = 0; t < 7200; t++) wps.push(wp(t, t === 4321 ? 40 : 10 + (t % 7) * 0.1, 300));
  const d = parse(file(dive({ wps: wps.join(""), greatest: 40, dur: 7200 }))).dives[0];
  assert.ok(d.samples.length <= I.MAX_SAMPLES + 2, "thinned: " + d.samples.length); assert.ok(d.samples.some((s) => s[1] === 40), "deepest kept"); assert.equal(d.samples.at(-1)[0], 7199);
  assert.equal(d.maxDepthM, 40);
  assert.ok(JSON.stringify({ n: 1, t: 1, iv: 1, s: d.samples }).length < 120_000, "fits the server's per-dive limit");
});

test("parseUddf: refuses things that are not a UDDF dive log, with a message that says what to do", () => {
  assert.throws(() => parse("not xml at all <<<"), /not valid XML/);
  assert.throws(() => parse("<html><body>hi</body></html>"), /not a UDDF dive log.*"html".*Export/);
  assert.throws(() => parse("<?xml version='1.0'?><ssrf></ssrf>"), /"ssrf"/);
  assert.equal(parse(`<uddf version="3.2.0"></uddf>`).dives.length, 0, "a valid but empty UDDF imports nothing");
  // hostile content is only ever read as data
  const evil = file(dive({ when: "2026-05-02T09:30:00" }).replace("<name>", "<name>").replace("</samples>", "</samples><script>alert(1)</script>"));
  assert.equal(parse(evil).dives.length, 1);
  assert.ok(!JSON.stringify(parse(evil).dives).includes("alert"));
});
