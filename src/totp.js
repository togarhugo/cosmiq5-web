// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s) as used by Google Authenticator.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s) {
  let bits = 0, value = 0; const out = [];
  for (const c of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(c); if (i < 0) throw new Error("bad base32");
    value = (value << 5) | i; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Uint8Array.from(out);
}

export async function hotp(secretBytes, counter, digits = 6) {
  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new Uint8Array(8); new DataView(msg.buffer).setUint32(4, counter >>> 0); new DataView(msg.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[19] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, "0");
}
export const stepOf = (ms = Date.now()) => Math.floor(ms / 30000);

/** Returns the matched time step (so the caller can refuse replays), or null. Accepts +-1 step of clock drift. */
export async function verifyTotp(secretBytes, code, lastStep = 0, nowMs = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const cur = stepOf(nowMs); let matched = null;
  for (const s of [cur - 1, cur, cur + 1]) {            // evaluate all three: no early exit
    const ok = (await hotp(secretBytes, s)) === String(code);
    if (ok && s > lastStep && matched === null) matched = s;
  }
  return matched;
}

export function otpauthUri(secretB32, email, issuer = "Cosmiq Dive") {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
