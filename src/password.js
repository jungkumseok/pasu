import crypto from 'node:crypto';
import { promisify } from 'node:util';

// scrypt with N=2^15, r=8 (32 MiB, ~50-100ms per hash): slow enough that a
// leaked auth.json can't be cracked quickly, fast enough for a login.
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LEN = 32;
const scrypt = promisify(crypto.scrypt);

export const MIN_LENGTH = 12;
const MAX_LENGTH = 1024;

/** Returns an error message, or null if the password is acceptable. */
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters`;
  if (password.length > MAX_LENGTH) return `Use at most ${MAX_LENGTH} characters`;
  return null;
}

const derive = (password, salt, { N, r, p }) =>
  scrypt(password.normalize('NFKC'), salt, KEY_LEN, { N, r, p, maxmem: 256 * N * r });

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt, PARAMS);
  return { alg: 'scrypt', ...PARAMS, salt: salt.toString('base64'), hash: hash.toString('base64') };
}

export async function verifyPassword(stored, password) {
  if (!stored || typeof password !== 'string' || password.length > MAX_LENGTH) return false;
  const expected = Buffer.from(stored.hash, 'base64');
  const actual = await derive(password, Buffer.from(stored.salt, 'base64'), stored);
  return crypto.timingSafeEqual(actual, expected);
}
