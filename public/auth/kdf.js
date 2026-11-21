/* Browser-side password stretching (PBKDF2-HMAC-SHA256). The server never receives the password:
 * it gets this derived key, and stores only an HMAC of it. Shared by the login page and Account tab. */
(function (root) {
  "use strict";
  const enc = new TextEncoder();
  const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
  const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));

  /** saltHex from the server, bound to the email so the same password differs per account. */
  async function deriveKey(password, saltHex, iterations, email) {
    const salt = new Uint8Array([...unhex(saltHex), ...enc.encode("|" + String(email).trim().toLowerCase())]);
    const base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
    return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, 256));
  }
  const randomSalt = () => hex(crypto.getRandomValues(new Uint8Array(16)));
  const api = { deriveKey, randomSalt, MIN_ITER: 100000, MAX_ITER: 2000000 };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.CosmiqKdf = api;
})(typeof self !== "undefined" ? self : this);
