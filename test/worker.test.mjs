import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const env = { TEAM_DOMAIN: "t.cloudflareaccess.com", POLICY_AUD: "aud", ALLOWED_EMAILS: "a@b.c",
  ASSETS: { fetch: async () => new Response("static") }, DB: {} };
const call = (path, init, e = env) => worker.fetch(new Request("https://x" + path, init), e);

test("API fails closed without a token", async () => {
  assert.equal((await call("/api/dives")).status, 401);
  assert.equal((await call("/api/me", { headers: { "Cf-Access-Jwt-Assertion": "a.b.c" } })).status, 401);
});
test("API refuses to run with placeholder config", async () => {
  const r = await call("/api/dives", {}, { ...env, POLICY_AUD: "REPLACE_WITH_AUD_TAG" });
  assert.equal(r.status, 503);
});
test("static assets are passed through", async () => {
  assert.equal(await (await call("/index.html")).text(), "static");
});

// ---- happy path with a real RS256 signature and a stubbed JWKS endpoint ----
const b64 = (b) => Buffer.from(b).toString("base64url");
async function makeIdp() {
  const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };
  const sign = async (claims, key = kp.privateKey) => {
    const h = b64(JSON.stringify({ alg: "RS256", kid: "k1" })), p = b64(JSON.stringify(claims));
    const s = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64(s)}`;
  };
  return { jwk, sign };
}
test("valid Access token is accepted; forged / expired / wrong-aud / wrong-user are rejected", async () => {
  const idp = await makeIdp();
  const other = await makeIdp(); // attacker's key, same kid
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [idp.jwk] }));
  try {
    const good = { aud: ["aud"], iss: "https://t.cloudflareaccess.com", email: "A@B.C", exp: Math.floor(Date.now() / 1000) + 600 };
    const me = (tok) => call("/api/me", { headers: { "Cf-Access-Jwt-Assertion": tok } });
    const ok = await me(await idp.sign(good));
    assert.equal(ok.status, 200); assert.equal((await ok.json()).email, "a@b.c");
    assert.equal((await me(await other.sign(good))).status, 401, "forged signature");
    assert.equal((await me(await idp.sign({ ...good, exp: 1 }))).status, 401, "expired");
    assert.equal((await me(await idp.sign({ ...good, aud: ["nope"] }))).status, 401, "wrong audience");
    assert.equal((await me(await idp.sign({ ...good, iss: "https://evil" }))).status, 401, "wrong issuer");
    assert.equal((await me(await idp.sign({ ...good, email: "x@y.z" }))).status, 403, "email not allowed");
  } finally { globalThis.fetch = realFetch; }
});
