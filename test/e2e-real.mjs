// Real Worker (wrangler dev --local, local D1) + real browser engine. Needs .dev.vars (see README) and Playwright.
// Run: node test/e2e-real.mjs [baseUrl]
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sign } from "../src/auth.js";
import { totpNow } from "./totp-helper.mjs";
const { chromium, devices } = createRequire(import.meta.url)("playwright");

const BASE = process.argv[2] || "http://127.0.0.1:8799";
const vars = Object.fromEntries(fs.readFileSync(".dev.vars", "utf8").trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
const SHOTS = process.env.SHOTS || "/tmp";
const PASSWORD = "correct horse battery staple";
const browser = await chromium.launch();
let failed = 0;

for (const [profile, EMAIL] of [["Pixel 7", "me@example.com"], ["iPhone 13", "other@example.com"]]) {   // one account per run: the local DB persists
  const ctx = await browser.newContext({ ...devices[profile], serviceWorkers: "block" });
  const page = await ctx.newPage(); const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    // 1. Signed out: the FIRST page is the login page with both choices
    await page.goto(BASE + "/");
    assert.equal(new URL(page.url()).pathname, "/auth/login", "signed-out visitors land on the login page");
    assert.ok(await page.getByRole("link", { name: /Continue with Google/ }).isVisible());
    for (const id of ["#email", "#password", "#code"]) assert.ok(await page.locator(id).isVisible(), id);
    assert.match(await page.locator(".ver").innerText(), /^v\d+\.\d+\.\d+$/);
    assert.equal(await page.locator('a.google').getAttribute("href"), "/auth/google");
    await page.screenshot({ path: `${SHOTS}/login-${profile.replace(" ", "")}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll on login");

    // 2. A Google-signed-in session (minted here, since Google itself can't be driven in a test)
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = await sign({ typ: "session", email: EMAIL, name: "Me", amr: "google", exp }, vars.SESSION_SECRET);
    await ctx.addCookies([{ name: "dc_session", value: token, url: BASE }]);
    await page.goto(BASE + "/");
    assert.equal(new URL(page.url()).pathname, "/", "signed in: the app");
    await page.waitForFunction((e) => document.getElementById("who").textContent.includes(e), EMAIL);
    assert.match(await page.locator("#appVer").innerText(), /^v\d+\.\d+\.\d+/);

    // 3. Account tab: set up email login (real QR, real 600k-iteration PBKDF2 in this browser)
    await page.click("#navAccount");
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

    // 4. Sign out, then sign in with email + password + authenticator code
    await page.click("#signOut");
    await page.waitForSelector("text=You have been signed out");
    await page.goto(BASE + "/auth/login");
    await page.fill("#email", EMAIL); await page.fill("#password", "wrong password here");
    await page.fill("#code", await totpNow(secret, 1)); await page.click("#go");
    await page.waitForFunction(() => /Invalid email, password or code/.test(document.getElementById("err").textContent));
    assert.equal(new URL(page.url()).pathname, "/auth/login", "failed login stays on the login page");
    await page.fill("#password", PASSWORD); await page.fill("#code", await totpNow(secret, 1));
    const t1 = Date.now(); await page.click("#go");
    await page.waitForURL(BASE + "/", { timeout: 30000 });
    console.log(`  ${profile}: login (PBKDF2 + request) took ${Date.now() - t1} ms`);
    await page.waitForFunction((e) => document.getElementById("who").textContent.includes(e), EMAIL);
    await page.click("#navAccount");
    await page.waitForFunction(() => /via email \+ authenticator/.test(document.getElementById("accVia").textContent));
    await page.screenshot({ path: `${SHOTS}/account-${profile.replace(" ", "")}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no horizontal scroll in app");
    assert.deepEqual(errors, [], "page errors");
    console.log("PASS", profile);
  } catch (e) { failed++; console.log("FAIL", profile, "\n ", e.message.split("\n")[0]); await page.screenshot({ path: `${SHOTS}/fail-${profile.replace(" ", "")}.png`, fullPage: true }); }
  await ctx.close();
}
await browser.close(); process.exit(failed ? 1 : 0);
