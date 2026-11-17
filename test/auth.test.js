import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pasu-auth-'));
process.env.PASU_DATA = dir;
const { Auth, setPassword, clientKey } = await import('../src/auth.js');
const totp = await import('../src/totp.js');
const { config } = await import('../src/config.js');

const PASSWORD = 'correct horse battery';
const A = { ip: '203.0.113.5' };
const B = { ip: '198.51.100.7' };
const codeAt = (secret, offset = 0) => totp.hotp(totp.base32Decode(secret), totp.currentCounter() + offset);

async function rejects(promise, status) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status, err.message);
    return true;
  });
}

async function enrolled() {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const auth = new Auth();
  const token = auth.setupToken;
  const { secret } = await auth.beginSetup(token, A);
  await auth.confirmSetup(token, { password: PASSWORD, code: codeAt(secret) }, A);
  return { auth, secret };
}

test('setup needs the token and a long enough password', async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const auth = new Auth();
  const token = auth.setupToken;
  await rejects(auth.beginSetup('wrong', A), 403);
  const { secret } = await auth.beginSetup(token, A);
  await rejects(auth.confirmSetup(token, { password: 'short', code: codeAt(secret) }, A), 400);
  await rejects(auth.confirmSetup(token, { password: PASSWORD, code: '000000' === codeAt(secret) ? '111111' : '000000' }, A), 401);
  const { token: session } = await auth.confirmSetup(token, { password: PASSWORD, code: codeAt(secret) }, A);
  assert.ok(auth.validateSession(session));
  assert.ok(!JSON.stringify(JSON.parse(fs.readFileSync(config.authFile, 'utf8'))).includes(PASSWORD));
  // Once configured there is no setup token left to match, not even the string "null".
  await rejects(auth.beginSetup('null', B), 409);
});

test('login needs both the password and a fresh code', async () => {
  const { auth, secret } = await enrolled();
  const code = codeAt(secret, 1);
  await rejects(auth.login({ password: 'not the password', code }, A), 401);
  assert.equal(auth.global.failures, 0, 'a wrong password does not count against the global lockout');
  await rejects(auth.login({ password: PASSWORD, code: code === '000000' ? '111111' : '000000' }, A), 401);
  assert.equal(auth.global.failures, 1);
  const { token } = await auth.login({ password: PASSWORD, code }, B);
  assert.ok(auth.validateSession(token));
  await rejects(auth.login({ password: PASSWORD, code }, B), 401); // replay
});

test('password guessing locks out only the guessing address', async () => {
  const { auth, secret } = await enrolled();
  for (let i = 0; i < 6; i++) await rejects(auth.login({ password: `guess ${i}`, code: '123456' }, A), 401);
  await rejects(auth.login({ password: PASSWORD, code: codeAt(secret, 1) }, A), 429);
  await auth.login({ password: PASSWORD, code: codeAt(secret, 1) }, B);
});

test('parallel attempts from one address are not evaluated concurrently', async () => {
  const { auth } = await enrolled();
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => auth.login({ password: `guess ${i}`, code: '123456' }, A)),
  );
  const statuses = results.map((r) => r.reason.status);
  assert.equal(statuses.filter((s) => s === 401).length, 1);
  assert.equal(statuses.filter((s) => s === 429).length, 19);
});

test('IPv6 clients are grouped by /64', () => {
  assert.equal(clientKey('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(clientKey('2001:db8:1:2:3:4:5:6'), clientKey('2001:db8:1:2::9'));
  assert.notEqual(clientKey('2001:db8:1:2::9'), clientKey('2001:db8:1:3::9'));
  assert.equal(clientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
});

test('the global code lockout survives a restart', async () => {
  const { auth, secret } = await enrolled();
  const wrong = codeAt(secret, 1) === '000000' ? '111111' : '000000';
  for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4']) {
    await rejects(auth.login({ password: PASSWORD, code: wrong }, { ip }), 401);
  }
  const restarted = new Auth();
  await rejects(restarted.login({ password: PASSWORD, code: codeAt(secret, 1) }, B), 429);
});

test('an instance enrolled without a password refuses login until set-password', async () => {
  const { auth, secret } = await enrolled();
  const state = JSON.parse(fs.readFileSync(config.authFile, 'utf8'));
  delete state.password;
  fs.writeFileSync(config.authFile, JSON.stringify(state));
  assert.equal(auth.needsPassword(), true);
  await rejects(auth.login({ password: PASSWORD, code: codeAt(secret, 1) }, A), 409);
  await assert.rejects(setPassword('short'), /at least/);
  // Takes effect in the running instance, without a restart.
  await setPassword('a brand new passphrase');
  assert.equal(auth.needsPassword(), false);
  await auth.login({ password: 'a brand new passphrase', code: codeAt(secret, 1) }, A);
});
