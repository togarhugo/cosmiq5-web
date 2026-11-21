// Real Worker (wrangler dev --local, local D1) + real browser engine. Needs .dev.vars (see README) and Playwright.
// Run: node test/e2e-real.mjs [baseUrl]
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sign } from "../src/auth.js";
import { totpNow } from "./totp-helper.mjs";
import zlib from "node:zlib";
import { base32Decode, hotp, stepOf } from "../src/totp.js";
const { chromium, devices } = createRequire(import.meta.url)("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8799";
const vars = Object.fromEntries(fs.readFileSync(".dev.vars", "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
const SHOTS = process.env.SHOTS || "/tmp";
const PASSWORD = "correct horse battery staple", NEW_PASSWORD = "an entirely different passphrase";
/** A real (valid) PNG for upload tests. */
function makePng(w = 160, h = 120) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1); raw[o + 1 + x * 3] = (x * 2) % 256; raw[o + 2 + x * 3] = (y * 2) % 256; raw[o + 3 + x * 3] = 128; }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const browser = await chromium.launch();
let failed = 0;

for (const [profile, EMAIL] of [["Pixel 7", "me@example.com"], ["iPhone 13", "other@example.com"]]) {   // one account per run: the local DB persists
  const ctx = await browser.newContext({ ...devices[profile], serviceWorkers: "block" });
  const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    // 1. Signed out: the FIRST page is the login page with exactly two choices (Google, email + password)
    await page.goto(BASE + "/");
    assert.equal(new URL(page.url()).pathname, "/auth/login", "signed-out visitors land on the login page");
    assert.ok(await page.getByRole("link", { name: /Continue with Google/ }).isVisible());
    for (const id of ["#email", "#password"]) assert.ok(await page.locator(id).isVisible(), id);
    assert.equal(await page.locator("input").count(), 2, "only email + password inputs on the first screen");
    assert.equal(await page.locator("#code").count(), 0, "no code field on the first screen");
    assert.match(await page.locator(".ver").innerText(), /^v\d+\.\d+\.\d+$/);
    assert.equal(await page.locator('a.google').getAttribute("href"), "/auth/google");
    await page.screenshot({ path: `${SHOTS}/login-${profile.replace(" ", "")}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll on login");
    assert.equal((await page.goto(BASE + "/auth/mfa")).url().endsWith("/auth/login"), true, "the code page is closed without the password step");

    // 2. A Google-signed-in session (minted here, since Google itself can't be driven in a test)
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await sign({ typ: "session", email: EMAIL, name: "Me", amr: "google", exp }, vars.SESSION_SECRET);
    await ctx.addCookies([{ name: "dc_session", value: token, url: BASE }]);
    await page.goto(BASE + "/");
    assert.equal(new URL(page.url()).pathname, "/", "signed in: the app");
    await page.waitForFunction((e) => document.getElementById("who").textContent.includes(e), EMAIL);
    assert.match(await page.locator("#appVer").textContent(), /^v\d+\.\d+\.\d+/);

    // 3. Account tab: set up email login (real QR, real 600k-iteration PBKDF2 in this browser)
    await page.click("#acctBtn");
    await page.locator("details.acc[data-sec=password] > summary").click();
    await page.waitForFunction((e) => document.getElementById("accVia").textContent === `Signed in as ${e} via Google`, EMAIL);
    assert.match(await page.locator("#accPwState").innerText(), /off/);
    await page.click("#accSetupBtn");
    await page.fill("#accPw1", "short"); await page.fill("#accPw2", "short"); await page.click("#accNext");
    assert.match(await page.locator("#accMsg").innerText(), /at least 12/);
    await page.fill("#accPw1", PASSWORD); await page.fill("#accPw2", PASSWORD + "x"); await page.click("#accNext");
    assert.match(await page.locator("#accMsg").innerText(), /don't match/);
    await page.fill("#accPw2", PASSWORD); await page.click("#accNext");
    await page.waitForSelector("#accQr svg");
    const secret = (await page.locator("#accSecret").innerText()).replace(/\s/g, "");
    assert.match(secret, /^[A-Z2-7]{32}$/);
    await page.screenshot({ path: `${SHOTS}/account-qr-${profile.replace(" ", "")}.png`, fullPage: true });
    await page.fill("#accCode", "000000"); await page.click("#accFinish");
    await page.waitForFunction(() => /wrong/i.test(document.getElementById("accMsg").textContent));
    const t0 = Date.now();
    await page.fill("#accCode", await totpNow(secret)); await page.click("#accFinish");
    await page.waitForFunction(() => /Email login is on/.test(document.getElementById("accMsg").textContent), null, { timeout: 30000 });
    console.log(`  ${profile}: PBKDF2(600k)+enroll took ${Date.now() - t0} ms in this browser`);
    assert.match(await page.locator("#accPwState").innerText(), /on/);

    // 4. Sign out, then: email + password  ->  separate page with six digit boxes  ->  app
    await page.click("#signOut");
    await page.waitForSelector("text=You have been signed out");
    await page.goto(BASE + "/auth/login");
    await page.fill("#email", EMAIL); await page.fill("#password", "wrong password here"); await page.click("#go");
    await page.waitForFunction(() => /Invalid email or password/.test(document.getElementById("err").textContent));
    assert.equal(new URL(page.url()).pathname, "/auth/login", "a wrong password stays on the login page");
    await page.fill("#password", PASSWORD);
    const t1 = Date.now(); await page.click("#go");
    await page.waitForURL(BASE + "/auth/mfa", { timeout: 30000 });
    console.log(`  ${profile}: password step (PBKDF2 + request) took ${Date.now() - t1} ms`);
    const boxes = page.locator("#boxes input"); assert.equal(await boxes.count(), 6, "six individual digit boxes");
    assert.ok(await boxes.nth(0).evaluate((el) => document.activeElement === el), "first box focused");
    await page.screenshot({ path: `${SHOTS}/mfa-${profile.replace(" ", "")}.png`, fullPage: true });
    const vals = async () => (await boxes.evaluateAll((els) => els.map((e) => e.value))).join(",");
    // typing advances box by box; Backspace on an empty box steps back and clears
    await page.keyboard.type("123"); assert.equal(await vals(), "1,2,3,,,");
    await page.keyboard.press("Backspace"); assert.equal(await vals(), "1,2,,,,");
    await page.keyboard.press("Backspace"); await page.keyboard.press("Backspace"); assert.equal(await vals(), ",,,,,");
    // a wrong code auto-submits when the 6th digit is typed, shows an error and clears the boxes
    const wrong = (await totpNow(secret, 1)) === "000000" ? "111111" : "000000";
    await page.keyboard.type(wrong);
    await page.waitForFunction(() => /not valid/.test(document.getElementById("err").textContent));
    assert.equal(await vals(), ",,,,,", "boxes cleared after a wrong code");
    assert.equal(new URL(page.url()).pathname, "/auth/mfa");
    // pasting a whole code fills every box and submits
    await boxes.nth(0).focus();
    const good = await totpNow(secret, 1);
    await page.evaluate((c) => { const dt = new DataTransfer(); dt.setData("text", c); document.querySelector("#boxes input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }, good.slice(0, 3) + " " + good.slice(3));
    await page.waitForURL(BASE + "/", { timeout: 30000 });
    await page.waitForFunction((e) => document.getElementById("who").textContent.includes(e), EMAIL);
    // every device-settings tab must respond to a tap (regression: broken onclick attributes)
    await page.click("#navDevice");
    await page.evaluate(() => { document.getElementById("app").style.display = "block"; document.getElementById("notConnected").style.display = "none"; });
    for (const [label, id] of [["Environment", "env"], ["Scuba", "scuba"], ["Freedive", "free"], ["Diagnostics", "hunter"], ["General", "gen"]]) {
      await page.locator(".tab", { hasText: label }).tap();
      assert.ok(await page.evaluate((i) => document.getElementById(i).classList.contains("active") && getComputedStyle(document.getElementById(i)).display !== "none", id), `${label} tab opens`);
    }
    await page.click("#acctBtn");
    await page.locator("details.acc[data-sec=password] > summary").click();
    await page.waitForFunction(() => /via email \+ authenticator/.test(document.getElementById("accVia").textContent));

    // 5. account area on the REAL server (local D1): picture, certification files, regulator
    const toastIs = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById("toast").textContent), re.source, { timeout: 10000 });
    await page.locator("details.acc[data-sec=profile] > summary").click();
    assert.ok(!(await page.locator("#acctImg").isVisible()), "no picture yet: a person icon");
    await page.setInputFiles("#avatarFile", { name: "me.png", mimeType: "image/png", buffer: makePng(300, 200) });
    await toastIs(/Profile picture updated/);
    const src = await page.locator("#acctImg").getAttribute("src"); assert.match(src, /^data:image\/jpeg;base64,/); assert.ok(src.length < 140000, "stored small");
    assert.deepEqual(await page.evaluate(() => { const i = document.getElementById("acctImg"); return [i.naturalWidth, i.naturalHeight]; }), [256, 256], "cropped to a 256x256 square");
    await page.evaluate(() => localStorage.removeItem("avatar")); await page.reload();                    // the phone forgets it: the server still has it
    await page.waitForFunction(() => document.getElementById("acctImg") && !document.getElementById("acctImg").hidden, null, { timeout: 10000 });
    await page.setInputFiles("#avatarFile", { name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("not a picture") }).catch(() => {});

    await page.click("#acctBtn"); await page.locator("details.acc[data-sec=certs] > summary").click();
    await page.fill("#certLabel", "PADI Advanced Open Water"); await page.fill("#certNumber", "1234567");
    await page.setInputFiles("#certFile", { name: "card.png", mimeType: "image/png", buffer: makePng(900, 600) }); await page.click("#certAdd");
    await toastIs(/Certification uploaded/); await page.waitForSelector(".cert");
    assert.match(await page.locator(".cert").first().innerText(), /PADI Advanced Open Water[\s\S]*#1234567[\s\S]*card\.jpg/);
    await page.locator(".cert-view").first().click(); await page.waitForSelector(".cert-preview img.preview");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(".cert-save").first().click()]);
    assert.equal(dl.suggestedFilename(), "card.jpg");
    await page.fill("#certLabel", "Insurance"); await page.setInputFiles("#certFile", { name: "policy.pdf", mimeType: "application/pdf", buffer: PDF }); await page.click("#certAdd");
    await page.waitForFunction(() => document.querySelectorAll(".cert").length === 2, null, { timeout: 10000 });
    await page.fill("#certLabel", "Too big"); await page.setInputFiles("#certFile", { name: "big.pdf", mimeType: "application/pdf", buffer: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(1_100_000, 65)]) }); await page.click("#certAdd");
    await page.waitForFunction(() => /limit is 1 MB/.test(document.getElementById("certMsg").textContent)); assert.equal(await page.locator(".cert").count(), 2, "the oversize file was refused");
    await page.fill("#certLabel", "Fake"); await page.setInputFiles("#certFile", { name: "fake.pdf", mimeType: "application/pdf", buffer: Buffer.from("<html><script>alert(1)</script></html>") }); await page.click("#certAdd");
    await page.waitForFunction(() => /does not look like a PDF/.test(document.getElementById("certMsg").textContent)); assert.equal(await page.locator(".cert").count(), 2, "an HTML file renamed .pdf was refused by the server");
    await page.locator(".cert-del").last().click(); assert.match(await page.locator(".cert-del").last().innerText(), /Tap again/); await page.locator(".cert-del").last().click();
    await toastIs(/Certification deleted/); await page.waitForFunction(() => document.querySelectorAll(".cert").length === 1);
    assert.equal((await page.evaluate(() => fetch("/api/certs").then((r) => r.json()))).certs.length, 1, "server agrees");

    await page.locator("details.acc[data-sec=regulator] > summary").click();
    await page.click("#regAdd"); await page.fill("#regName", "Apeks XTX50"); await page.fill("#regType", "Balanced piston"); await page.fill("#regBase", "71"); await page.click("#regSave");
    await toastIs(/Regulator saved/); assert.equal(await page.locator("#regShownCount").innerText(), "71");
    await page.evaluate(() => localStorage.removeItem("regulator")); await page.reload();                  // survives losing the phone's cache
    await page.waitForFunction(() => /orange/.test(document.getElementById("sumReg").className), null, { timeout: 10000 });
    assert.match(await page.locator("#sumRegMsg").innerText(), /Service soon: 19 dives/);
    await page.screenshot({ path: `${SHOTS}/summary-${profile.replace(" ", "")}.png`, fullPage: true });
    await page.click("#acctBtn"); await page.locator("details.acc[data-sec=regulator] > summary").click();
    await page.locator("#regReset").click(); await page.locator("#regReset").click(); await toastIs(/reset to 0/);
    assert.equal(await page.locator("#regShownCount").innerText(), "0");
    await page.click("#navSummary"); await page.waitForFunction(() => /reg-ok/.test(document.getElementById("sumReg").className));

    // 6. change the password (Pixel run only: it has to wait for authenticator time steps). Needs the CURRENT password + code;
    //    the authenticator stays the same, then the new password works at the login page and the old one does not.
    if (profile === "Pixel 7") {
      let lastUsed = stepOf(Date.now()) + 1;                                                                // the paste login above consumed this step
      const freshCode = async () => { for (;;) { const c = stepOf(Date.now()); if (c + 1 > lastUsed) { lastUsed = c + 1; return hotp(base32Decode(secret), c + 1); } await new Promise((r) => setTimeout(r, 1000)); } };
      await page.click("#acctBtn"); await page.locator("details.acc[data-sec=password] > summary").click();
      await page.click("#accChangeBtn"); await page.waitForSelector("#accChange", { state: "visible" });
      const go = async () => { await page.click("#pwChangeGo"); };
      await page.fill("#pwCur", PASSWORD); await page.fill("#pwNew1", "short"); await page.fill("#pwNew2", "short"); await page.fill("#pwCode", "123456"); await go();
      assert.match(await page.locator("#accMsg").innerText(), /at least 12/);
      await page.fill("#pwNew1", NEW_PASSWORD); await page.fill("#pwNew2", NEW_PASSWORD + "x"); await go(); assert.match(await page.locator("#accMsg").innerText(), /don't match/);
      await page.fill("#pwNew2", NEW_PASSWORD); await page.fill("#pwCode", "12"); await go(); assert.match(await page.locator("#accMsg").innerText(), /6-digit/);
      await page.fill("#pwNew1", PASSWORD); await page.fill("#pwNew2", PASSWORD); await page.fill("#pwCode", "123456"); await go(); assert.match(await page.locator("#accMsg").innerText(), /different from the current/);
      await page.fill("#pwNew1", NEW_PASSWORD); await page.fill("#pwNew2", NEW_PASSWORD);
      await page.fill("#pwCur", "not my current password"); await page.fill("#pwCode", "123456"); await go();                // wrong current password: refused by the server
      await page.waitForFunction(() => /current password or authenticator code is not right/.test(document.getElementById("accMsg").textContent), null, { timeout: 15000 });
      await page.fill("#pwCur", PASSWORD); await page.fill("#pwCode", await freshCode()); await go();
      await toastIs(/Password changed/); assert.ok(!(await page.locator("#accChange").isVisible()), "form closed after success");
      await page.screenshot({ path: `${SHOTS}/account-${profile.replace(" ", "")}.png`, fullPage: true });
      await page.click("#signOut"); await page.waitForSelector("text=You have been signed out"); await page.goto(BASE + "/auth/login");
      await page.fill("#email", EMAIL); await page.fill("#password", PASSWORD); await page.click("#go");
      await page.waitForFunction(() => /Invalid email or password/.test(document.getElementById("err").textContent), null, { timeout: 15000 }); assert.equal(new URL(page.url()).pathname, "/auth/login", "the old password no longer works");
      await page.fill("#password", NEW_PASSWORD); await page.click("#go"); await page.waitForURL(BASE + "/auth/mfa", { timeout: 30000 });
      await boxes.nth(0).focus(); const code2 = await freshCode();
      await page.evaluate((c) => { const dt = new DataTransfer(); dt.setData("text", c); document.querySelector("#boxes input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }, code2);
      await page.waitForURL(BASE + "/", { timeout: 30000 });
      console.log(`  ${profile}: password changed and signed in again with the new one (same authenticator)`);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll in app");
    assert.deepEqual(errors, [], "page errors");
    console.log("PASS", profile);
  } catch (e) { failed++; console.log("FAIL", profile, "\n ", e.message.split("\n")[0]); await page.screenshot({ path: `${SHOTS}/fail-${profile.replace(" ", "")}.png`, fullPage: true }); }
  await ctx.close();
}
await browser.close(); process.exit(failed ? 1 : 0);
