import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pasu-notify-'));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pasu-work-'));
process.env.PASU_DATA = dataDir;

const { config } = await import('../src/config.js');
const { Supervisor } = await import('../src/supervisor.js');
const { Notifier, sendMail, failureMessage } = await import('../src/notify.js');
const { loadSettings, saveSettings, publicSettings, instanceId } = await import('../src/settings.js');
const { isPublicAddress, interfaceAddresses } = await import('../src/hostinfo.js');

const SERVER = { id: 'eu-1.example.com', hostname: 'box', ip: '203.0.113.9' };
const server = () => SERVER;

config.backoff = { initialMs: 200, maxMs: 1000, stableAfterMs: 5000 };
config.pollIntervalMs = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const supervisors = [];
after(async () => {
  for (const s of supervisors) {
    for (const p of s.list()) await s.stop(p.id).catch(() => {});
    clearInterval(s.timer);
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

const EMAIL = { enabled: true, to: 'ops@example.com', host: 'smtp.example.com', port: 587, user: 'pasu@example.com', password: 's3cret' };

test('settings validate input and never expose the password', () => {
  assert.throws(() => saveSettings({ email: { enabled: true, to: 'nope', host: '' } }), (err) => {
    assert.ok(err.errors.to && err.errors.host);
    return true;
  });
  // Disabled settings can be saved half-filled.
  saveSettings({ email: { enabled: false, to: '', host: '' } });

  const shown = saveSettings({ email: EMAIL });
  assert.equal(shown.email.password, undefined);
  assert.equal(shown.email.hasPassword, true);
  assert.equal(fs.statSync(config.settingsFile).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(publicSettings()).includes('s3cret'));

  // A blank password keeps the saved one; clearing the username clears it.
  saveSettings({ email: { ...EMAIL, password: '' } });
  assert.equal(loadSettings().email.password, 's3cret');
  saveSettings({ email: { ...EMAIL, user: '', password: '' } });
  assert.equal(loadSettings().email.password, '');
});

test('a crash loop sends one email, then one summary per cooldown', async () => {
  saveSettings({ email: EMAIL });
  const sent = [];
  const notifier = new Notifier({ cooldownMs: 1000, send: async (_email, msg) => sent.push(msg), server });
  const sup = new Supervisor({ onFailure: (id, ev) => notifier.processFailed(id, ev) });
  supervisors.push(sup);
  sup.init();

  const looping = await sup.create({ name: 'looping', command: 'echo "boom <b>&"; exit 3', cwd: workDir, autostart: true });
  await sleep(250);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, '[eu-1.example.com] looping crashed');
  assert.match(sent[0].text, /Pasu ID: eu-1\.example\.com\nServer: box \(203\.0\.113\.9\)/);
  assert.match(sent[0].html, /203\.0\.113\.9/);
  assert.match(sent[0].text, /Exited with code 3/);
  assert.match(sent[0].html, /boom &lt;b&gt;&amp;/, 'log output is escaped');
  assert.match(sent[0].text, /Restarting in/);

  // Backoff restarts at about 200ms and 600ms; both fall inside the cooldown.
  await sleep(500);
  await sup.stop(looping.id);
  assert.equal(sent.length, 1);
  await sleep(500);
  assert.equal(sent.length, 2, 'the failures during the cooldown arrive as one summary');
  assert.match(sent[1].subject, /looping is still failing \(\d+ failures\)/);
  assert.match(sent[1].html, /Still failing/);
});

test('opted-out processes, finished one-off jobs and disabled settings send nothing', async () => {
  const sent = [];
  const notifier = new Notifier({ cooldownMs: 0, send: async (_email, msg) => sent.push(msg), server });
  const sup = new Supervisor({ onFailure: (id, ev) => notifier.processFailed(id, ev) });
  supervisors.push(sup);
  sup.init();

  saveSettings({ email: EMAIL });
  const quiet = await sup.create({ name: 'quiet', command: 'exit 1', cwd: workDir, autostart: false, notify: false });
  const job = await sup.create({ name: 'job', command: 'exit 0', cwd: workDir, autostart: false });
  await sup.start(quiet.id);
  await sup.start(job.id);
  await sleep(300);
  assert.equal(sent.length, 0);

  const failing = await sup.create({ name: 'failing', command: 'exit 2', cwd: workDir, autostart: false });
  await sup.start(failing.id);
  await sleep(300);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /stays stopped/);

  saveSettings({ email: { ...EMAIL, enabled: false } });
  await sup.start(failing.id);
  await sleep(300);
  assert.equal(sent.length, 1);
});

test('the message reads well without HTML', () => {
  const { subject, text } = failureMessage(
    { name: 'api', command: 'node server.js', cwd: '/srv/api' },
    { kind: 'crash', at: new Date().toISOString(), description: 'Killed by SIGKILL', uptimeMs: 125_000, next: 'Restarting in 1s (attempt 1).', logTail: 'Out of memory' },
    { server: { ...SERVER, ip: null } },
  );
  assert.equal(subject, '[eu-1.example.com] api crashed');
  assert.ok(text.includes('Server: box\n'), 'no IP shown when it is unknown');
  for (const s of ['Killed by SIGKILL', 'Uptime: 2m 5s', 'Command: node server.js', 'Out of memory']) assert.ok(text.includes(s), s);
});

/** Minimal SMTP server that accepts one message with AUTH PLAIN. */
function smtpSink() {
  const received = { auth: null, data: '' };
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    sock.write('220 sink ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk;
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        received.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        sock.write('250 queued\r\n');
      }
      let nl;
      while (!inData && (nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO') sock.write('250-sink\r\n250 AUTH PLAIN\r\n');
        else if (cmd === 'AUTH') {
          received.auth = Buffer.from(line.split(' ')[2], 'base64').toString().split('\0');
          sock.write('235 ok\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          sock.write('354 go\r\n');
        } else if (cmd === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port })));
}

test('sends a real multipart email over SMTP', async () => {
  const { server, received, port } = await smtpSink();
  try {
    const email = { ...EMAIL, host: '127.0.0.1', port };
    await sendMail(email, { subject: 'Hi', text: 'plain body', html: '<p>html body</p>' });
    assert.deepEqual(received.auth.slice(1), ['pasu@example.com', 's3cret']);
    assert.match(received.data, /^Subject: Hi/m);
    assert.match(received.data, /^To: ops@example.com/m);
    assert.match(received.data, /From: Pasu <pasu@example.com>/);
    assert.match(received.data, /text\/plain/);
    assert.match(received.data, /text\/html/);
  } finally {
    server.close();
  }
});

test('the Pasu ID defaults to the hostname and can be set', () => {
  saveSettings({ email: { enabled: false } });
  assert.equal(instanceId(), os.hostname());
  assert.equal(publicSettings().defaultInstanceId, os.hostname());
  saveSettings({ instanceId: '  eu-1.example.com ', email: { enabled: false } });
  assert.equal(instanceId(), 'eu-1.example.com');
  assert.throws(() => saveSettings({ instanceId: 'two\nlines', email: { enabled: false } }), (err) => Boolean(err.errors.instanceId));
  // Saving only the email part keeps the ID.
  saveSettings({ email: { enabled: false } });
  assert.equal(instanceId(), 'eu-1.example.com');
});

test('public addresses are told apart from private ones', () => {
  for (const ip of ['203.0.113.9', '8.8.8.8', '2001:db8::1']) assert.ok(isPublicAddress(ip), ip);
  for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.1.5', '100.70.0.1', '127.0.0.1', '169.254.1.1', 'fe80::1', 'fd00::1', '::1']) {
    assert.ok(!isPublicAddress(ip), ip);
  }
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eth0: [{ address: '2a01:4f8::1', family: 'IPv6', internal: false }, { address: '198.51.100.4', family: 'IPv4', internal: false }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
  };
  assert.deepEqual(interfaceAddresses(ifaces), ['198.51.100.4', '2a01:4f8::1']);
});
