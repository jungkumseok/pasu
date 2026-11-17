import crypto from 'node:crypto';

// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s step): the parameters every
// authenticator app supports.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SEC = 30;
const DIGITS = 6;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentCounter(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / STEP_SEC);
}

/**
 * Check `code` against the secret, allowing one step of clock drift either way.
 * Returns the matched counter, or null. Codes at or below `lastCounter` are
 * rejected so an observed code can't be replayed.
 */
export function verify(secret, code, { lastCounter = -1, nowMs = Date.now() } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const now = currentCounter(nowMs);
  let matched = null;
  for (const c of [now - 1, now, now + 1]) {
    const ok = crypto.timingSafeEqual(Buffer.from(hotp(key, c)), Buffer.from(code));
    if (ok && c > lastCounter) matched = c;
  }
  return matched;
}

export function otpauthUri(secret, { issuer, account }) {
  // The label is "issuer:account", so neither part may contain a colon itself.
  issuer = issuer.replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
  account = account.replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  // Built by hand: URLSearchParams encodes spaces as '+', which some apps display literally.
  const params = Object.entries({ secret, issuer, algorithm: 'SHA1', digits: DIGITS, period: STEP_SEC })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `otpauth://totp/${label}?${params}`;
}
