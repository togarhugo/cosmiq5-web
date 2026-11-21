import { base32Decode, hotp, stepOf } from "../src/totp.js";
/** The 6-digit code an authenticator app would show for `secretB32`, `stepOffset` 30 s windows from now. */
export async function totpNow(secretB32, stepOffset = 0) { return hotp(base32Decode(secretB32), stepOf() + stepOffset); }
