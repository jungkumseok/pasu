import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as totp from '../src/totp.js';

// RFC 6238 Appendix B (SHA-1), truncated to 6 digits.
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));
const VECTORS = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

test('base32 round-trips', () => {
  const buf = Buffer.from('hello world, totp!');
  assert.deepEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
  assert.equal(totp.base32Encode(Buffer.from('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

test('matches RFC 6238 test vectors', () => {
  const key = totp.base32Decode(RFC_SECRET);
  for (const [t, code] of VECTORS) {
    assert.equal(totp.hotp(key, Math.floor(t / 30)), code, `t=${t}`);
  }
});

test('verify accepts ±1 step and rejects replays', () => {
  const nowMs = 1111111111 * 1000;
  const counter = totp.currentCounter(nowMs);
  assert.equal(totp.verify(RFC_SECRET, '050471', { nowMs }), counter);
  // One step later, the same code still validates (clock drift)...
  assert.equal(totp.verify(RFC_SECRET, '050471', { nowMs: nowMs + 30_000 }), counter);
  // ...but not once it has been used.
  assert.equal(totp.verify(RFC_SECRET, '050471', { nowMs, lastCounter: counter }), null);
  // Two steps away is out of the window.
  assert.equal(totp.verify(RFC_SECRET, '050471', { nowMs: nowMs + 61_000 }), null);
  assert.equal(totp.verify(RFC_SECRET, '12345', { nowMs }), null);
  assert.equal(totp.verify(RFC_SECRET, 'abcdef', { nowMs }), null);
});

test('otpauth URI', () => {
  const uri = totp.otpauthUri('ABC', { issuer: 'Pasu', account: 'box' });
  assert.equal(uri, 'otpauth://totp/Pasu:box?secret=ABC&issuer=Pasu&algorithm=SHA1&digits=6&period=30');
  const named = totp.otpauthUri('ABC', { issuer: 'Pasu: prod EU', account: 'ops.example.com' });
  assert.equal(named, 'otpauth://totp/Pasu%20prod%20EU:ops.example.com?secret=ABC&issuer=Pasu%20prod%20EU&algorithm=SHA1&digits=6&period=30');
});
