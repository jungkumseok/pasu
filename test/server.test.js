import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pasu-server-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let server;

before(async () => {
  server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PASU_DATA: dir, PASU_TLS: 'off', PASU_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => String(d).includes('listening') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
});

after(() => server.kill());

/** Send a request line as-is, bypassing any client-side URL normalization. */
function raw(target) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let data = '';
    sock.on('data', (d) => (data += d));
    sock.on('end', () => resolve(data.split('\r\n')[0]));
    sock.on('error', reject);
  });
}

test('malformed request targets are rejected without crashing', async () => {
  for (const target of ['//', '/\\', '//[::1']) {
    assert.match(await raw(target), /^HTTP\/1\.1 400/, target);
  }
  assert.equal(server.exitCode, null);
  assert.equal((await fetch(`${base}/api/auth/status`)).status, 200);
});

test('non-object JSON bodies are rejected', async () => {
  for (const body of ['null', '[]', '"x"', '1']) {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(res.status, 400, body);
  }
});

test('HSTS is sent only for HTTPS requests', async () => {
  const plain = await fetch(`${base}/api/auth/status`);
  assert.equal(plain.headers.get('strict-transport-security'), null);
  const proxied = await fetch(`${base}/api/auth/status`, { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(proxied.headers.get('strict-transport-security'), 'max-age=31536000');
});
