#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { APP_DIR, config } from './config.js';
import { ensureDir, removeFile } from './fsutil.js';
import { Auth, AuthError, COOKIE_NAME, setPassword } from './auth.js';
import { Supervisor, NotFoundError } from './supervisor.js';
import { ValidationError, ID_RE } from './store.js';
import { loadTls } from './tls.js';
import { Notifier, serverInfo } from './notify.js';
import { loadSettings, normalizeEmail, normalizeInstanceId, publicSettings, saveSettings } from './settings.js';
import * as logs from './logs.js';

const PUBLIC_DIR = path.join(APP_DIR, 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const MAX_BODY = 64 * 1024;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(payload);
}

/** All values of cookie `name` (a browser may send several when paths overlap). */
function cookieValues(header = '', name) {
  const out = [];
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

// Scope the cookie to the mount path so it isn't sent to other apps on the same domain.
const COOKIE_PATH = config.publicUrl?.path || '/';

// Always Secure: browsers reach the app over HTTPS (directly or via the proxy),
// and they also accept Secure cookies on http://localhost.
function sessionCookie(token, maxAgeSec) {
  return `${COOKIE_NAME}=${token}; Path=${COOKIE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

async function readBody(req) {
  // Requiring a JSON content type means a cross-site <form> can't reach the API
  // without a CORS preflight, which we never grant (CSRF defense with SameSite=Strict).
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Expected application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  let body;
  try {
    body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
  return body;
}

function forwarded(req, name) {
  if (!config.trustProxy) return null;
  return String(req.headers[name] ?? '').split(',')[0].trim() || null;
}

// The proxy appends the address it saw to X-Forwarded-For, so only the last entry
// is trustworthy; earlier ones are whatever the client sent.
function clientIp(req) {
  const hops = config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',') : [];
  return hops.at(-1)?.trim() || req.socket.remoteAddress;
}

function isHttps(req) {
  return config.tls || forwarded(req, 'x-forwarded-proto') === 'https';
}

/** The origin the browser used to reach us, as reported by the proxy when there is one. */
function requestOrigin(req) {
  const proto = forwarded(req, 'x-forwarded-proto') || (config.tls ? 'https' : 'http');
  const host = forwarded(req, 'x-forwarded-host') || req.headers.host;
  return `${proto}://${host}`;
}

function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === config.publicUrl?.origin || origin === requestOrigin(req)) return;
  throw new HttpError(403, 'Cross-origin request refused');
}

function clientMeta(req) {
  return { ip: clientIp(req), userAgent: req.headers['user-agent'] };
}

function createHandler({ auth, supervisor, notifier }) {
  const routes = [];
  const route = (method, pattern, handler, { public: isPublic = false } = {}) =>
    routes.push({ method, pattern, handler, isPublic });

  route('GET', /^\/api\/auth\/status$/, ({ authed }) => ({
    name: config.name,
    configured: auth.isConfigured(),
    needsPassword: auth.needsPassword(),
    authenticated: authed,
  }), { public: true });

  route('POST', /^\/api\/setup\/begin$/, ({ req, body }) => auth.beginSetup(body.token, clientMeta(req)), { public: true });

  route('POST', /^\/api\/setup\/confirm$/, async ({ req, res, body }) => {
    const { token, maxAgeSec } = await auth.confirmSetup(body.token, body, clientMeta(req));
    res.setHeader('Set-Cookie', sessionCookie(token, maxAgeSec));
    return { ok: true };
  }, { public: true });

  route('POST', /^\/api\/login$/, async ({ req, res, body }) => {
    const { token, maxAgeSec } = await auth.login(body, clientMeta(req));
    res.setHeader('Set-Cookie', sessionCookie(token, maxAgeSec));
    return { ok: true };
  }, { public: true });

  route('POST', /^\/api\/logout$/, ({ res, token }) => {
    auth.logout(token);
    res.setHeader('Set-Cookie', sessionCookie('', 0));
    return { ok: true };
  }, { public: true });

  route('GET', /^\/api\/processes$/, () => supervisor.list());
  route('POST', /^\/api\/processes$/, ({ body }) => supervisor.create(body));

  const one = (id) => {
    const view = supervisor.view(id);
    if (!view) throw new HttpError(404, 'No such process');
    return view;
  };
  route('GET', /^\/api\/processes\/([^/]+)$/, ({ params: [id] }) => one(id));
  route('PUT', /^\/api\/processes\/([^/]+)$/, ({ params: [id], body }) => supervisor.update(id, body));
  route('DELETE', /^\/api\/processes\/([^/]+)$/, async ({ params: [id] }) => {
    await supervisor.remove(id);
    return { ok: true };
  });
  for (const action of ['start', 'stop', 'restart']) {
    route('POST', new RegExp(`^/api/processes/([^/]+)/${action}$`), async ({ params: [id] }) => {
      one(id);
      await supervisor[action](id);
      return one(id);
    });
  }
  route('GET', /^\/api\/settings$/, () => ({ ...publicSettings(), status: notifier.status(), server: serverInfo() }));
  route('PUT', /^\/api\/settings$/, ({ body }) => ({ ...saveSettings(body), status: notifier.status() }));
  // Sends with the values in the form, so they can be checked before saving.
  route('POST', /^\/api\/settings\/test-email$/, async ({ body }) => {
    const email = normalizeEmail(body.email ?? {}, loadSettings().email, { require: true });
    const id = normalizeInstanceId(body.instanceId);
    try {
      await notifier.sendTest(email, { id });
    } catch (err) {
      throw new HttpError(502, `Could not send: ${err.message}`);
    }
    return { ok: true, to: email.to };
  });

  route('GET', /^\/api\/processes\/([^/]+)\/resources$/, ({ params: [id] }) => {
    one(id);
    return supervisor.resourceDetail(id);
  });
  route('GET', /^\/api\/processes\/([^/]+)\/logs$/, ({ params: [id], url }) => {
    one(id);
    const raw = url.searchParams.get('offset');
    const offset = raw == null || raw === '' ? undefined : Number(raw);
    if (offset !== undefined && !(Number.isInteger(offset) && offset >= 0)) throw new HttpError(400, 'Bad offset');
    return logs.readLog(id, offset);
  });

  const handle = async (req, res) => {
    let url;
    try {
      // Inside the try: the URL parser throws on targets like "//", and an
      // uncaught error here would take all of Pasu down.
      try {
        url = new URL(req.url, 'https://localhost');
      } catch {
        throw new HttpError(400, 'Bad request');
      }
      if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), { 'Content-Type': type });
      }
      if (!url.pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');

      const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!match) throw new HttpError(404, 'Not found');
      const params = match.pattern.exec(url.pathname).slice(1);
      if (params.some((p) => !ID_RE.test(p))) throw new HttpError(404, 'No such process');

      const tokens = cookieValues(req.headers.cookie, COOKIE_NAME);
      const token = tokens.find((t) => auth.validateSession(t)) ?? tokens[0];
      const authed = Boolean(token) && auth.validateSession(token);
      if (!match.isPublic && !authed) throw new HttpError(401, 'Not logged in');

      let body = {};
      if (req.method !== 'GET') {
        checkOrigin(req);
        body = await readBody(req);
      }
      const result = await match.handler({ req, res, url, params, body, token, authed });
      send(res, 200, result);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...err.extra });
      if (err instanceof AuthError) {
        const headers = err.retryAfterMs ? { 'Retry-After': String(Math.ceil(err.retryAfterMs / 1000)) } : {};
        return send(res, err.status, { error: err.message, retryAfterMs: err.retryAfterMs, field: err.field }, headers);
      }
      if (err instanceof ValidationError) return send(res, 400, { error: 'Please fix the highlighted fields', fields: err.errors });
      if (err instanceof NotFoundError) return send(res, 404, { error: err.message });
      console.error(`[http] ${req.method} ${url?.pathname ?? req.url}:`, err);
      send(res, 500, { error: 'Internal error' });
    }
  };
  // Last line of defence: nothing a request does may crash the process.
  return (req, res) =>
    handle(req, res).catch((err) => {
      console.error('[http] unhandled:', err);
      if (!res.headersSent) send(res, 500, { error: 'Internal error' });
      else res.destroy();
    });
}

function isLoopback(host) {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function resetAuth() {
  removeFile(config.authFile);
  removeFile(config.sessionsFile);
  removeFile(config.throttleFile);
  console.log('Authenticator, password and sessions removed. Restart Pasu to run first-time setup again.');
}

/** Prompt for the new password twice, without echoing it; reads one line when stdin isn't a terminal. */
async function readNewPassword() {
  const tty = Boolean(process.stdin.isTTY);
  // readline echoes what's typed to its output, so give it one that can be muted.
  let muted = false;
  const output = new Writable({ write: (chunk, _enc, cb) => (muted || process.stdout.write(chunk), cb()) });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: tty });
  rl.on('SIGINT', () => {
    process.stdout.write('\nCancelled; nothing changed.\n');
    process.exit(130);
  });
  const ask = async (prompt) => {
    if (tty) process.stdout.write(prompt);
    muted = true;
    try {
      return await rl.question('');
    } finally {
      muted = false;
      if (tty) process.stdout.write('\n');
    }
  };
  try {
    const password = await ask('New password: ');
    if (tty && (await ask('Repeat it: ')) !== password) throw new Error('Passwords did not match');
    return password;
  } catch (err) {
    throw err.code === 'ABORT_ERR' ? new Error('Cancelled') : err;
  } finally {
    rl.close();
  }
}

async function setPasswordCommand() {
  try {
    await setPassword(await readNewPassword());
  } catch (err) {
    console.error(`${err.message}; nothing changed.`);
    process.exit(1);
  }
  console.log(`Password set in ${config.authFile}. It applies to the next sign-in; existing sessions stay valid.`);
}

const USAGE = `Usage: pasu [command]

  (none)              start Pasu
  set-password        set or change the login password
  reset-auth          remove the authenticator, password and sessions, to enroll again
  service <action>    manage the systemd service: install, uninstall, status, print
  help                show this help
  version             print the version

Settings are environment variables (PASU_NAME, PASU_PORT, PASU_DATA, ...); see the README.
Data is kept in ${config.dataDir}.`;

/**
 * Before the npm package, data lived in ./data inside the checkout. Refuse to start
 * with an empty new directory in that case: Pasu would run first-time setup and lose
 * track of the processes it was managing.
 */
function checkLegacyData() {
  const legacy = config.legacyDataDir;
  if (!config.dataDirIsDefault || fs.existsSync(config.dataDir)) return;
  if (!fs.existsSync(path.join(legacy, 'processes')) && !fs.existsSync(path.join(legacy, 'auth.json'))) return;
  console.error(`Pasu now keeps its data in ${config.dataDir}, but found existing data in ${legacy}.

Move it there (stop Pasu first; managed processes keep running and are re-adopted):

    mkdir -p ${path.dirname(config.dataDir)} && mv ${legacy} ${config.dataDir}

or keep it where it is by setting PASU_DATA=${legacy}`);
  process.exit(1);
}

function serviceCommand(args) {
  const result = spawnSync('bash', [path.join(APP_DIR, 'scripts', 'service.sh'), ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (['help', '--help', '-h'].includes(command)) return console.log(USAGE);
  if (['version', '--version', '-v'].includes(command)) {
    return console.log(JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version);
  }
  if (process.platform !== 'linux') {
    console.error('Pasu runs on Linux only: it tracks processes through /proc.');
    process.exit(1);
  }
  if (command === 'service') return serviceCommand(args);
  checkLegacyData();
  if (command === 'preflight') return; // used by `pasu service install`
  if (command === 'reset-auth') return resetAuth();
  if (command === 'set-password') return setPasswordCommand();
  if (command) {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    process.exit(2);
  }

  ensureDir(config.dataDir);
  const tls = config.tls ? loadTls() : null;
  const auth = new Auth();
  const notifier = new Notifier();
  const supervisor = new Supervisor({ onFailure: (id, event) => notifier.processFailed(id, event) });
  supervisor.init();

  const handler = createHandler({ auth, supervisor, notifier });
  const server = tls ? https.createServer({ cert: tls.cert, key: tls.key }, handler) : http.createServer(handler);
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.listen(config.port, config.host, () => {
    const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
    const base = config.publicUrl ? config.publicUrl.origin + config.publicUrl.path : `${tls ? 'https' : 'http'}://${shownHost}:${config.port}`;
    console.log(`[pasu] "${config.name}" listening on ${tls ? 'https' : 'http'}://${config.host}:${config.port}, data in ${config.dataDir}`);
    if (tls?.selfSigned) console.log(`[pasu] self-signed certificate SHA-256 fingerprint:\n          ${tls.fingerprint}`);
    if (!tls && !isLoopback(config.host)) {
      console.warn(`[pasu] WARNING: TLS is off but listening on ${config.host}. Bind to 127.0.0.1 and put a TLS proxy in front.`);
    }
    if (auth.setupToken) {
      console.log(`\n[pasu] First-time setup: open this URL to enroll your authenticator:\n\n    ${base}/#setup=${auth.setupToken}\n`);
    }
  });

  // Managed processes are deliberately left running when Pasu exits.
  const shutdown = (sig) => {
    console.log(`[pasu] ${sig} received, exiting (managed processes keep running)`);
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
