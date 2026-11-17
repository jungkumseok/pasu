import crypto from 'node:crypto';
import net from 'node:net';
import QRCode from 'qrcode';
import { config } from './config.js';
import { readJson, writeJson } from './fsutil.js';
import { hashPassword, validatePassword, verifyPassword } from './password.js';
import * as totp from './totp.js';

// Browsers scope cookies by host but not port, so several Pasu instances on one host
// (different ports or subpaths) need distinct cookie names to stay logged in independently.
const instanceKey = `${config.port}|${config.publicUrl ? config.publicUrl.origin + config.publicUrl.path : ''}`;
export const COOKIE_NAME = `pasu_session_${crypto.createHash('sha256').update(instanceKey).digest('hex').slice(0, 8)}`;

const NO_PASSWORD = 'No password is set for this Pasu instance. On the server, run: pasu set-password';
const MAX_TRACKED_CLIENTS = 10_000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Rate-limit key for a client address. IPv6 is grouped by /64, since one host usually controls a whole /64. */
export function clientKey(ip) {
  ip = String(ip ?? '').replace(/%.*$/, '').replace(/^::ffff:(?=\d+\.)/i, '');
  if (!net.isIPv6(ip)) return ip;
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/**
 * Consecutive failures past `free` lock further attempts for an exponentially
 * growing window: 1s, 2s, 4s ... capped at 1 hour.
 */
class Throttle {
  constructor({ free, state = {}, onChange = () => {} }) {
    this.free = free;
    this.failures = Number(state.failures) || 0;
    this.lockedUntil = Number(state.lockedUntil) || 0;
    this.onChange = onChange;
  }
  retryAfterMs() {
    return Math.max(0, this.lockedUntil - Date.now());
  }
  fail() {
    this.failures++;
    if (this.failures > this.free) {
      this.lockedUntil = Date.now() + Math.min(1000 * 2 ** (this.failures - this.free - 1), 3600_000);
    }
    this.onChange(this);
  }
  succeed() {
    if (!this.failures && !this.lockedUntil) return;
    this.failures = 0;
    this.lockedUntil = 0;
    this.onChange(this);
  }
  toJSON() {
    return { failures: this.failures, lockedUntil: this.lockedUntil };
  }
}

/**
 * Per-client limiter. Each client gets its own lockout, and only one attempt in
 * flight at a time, so firing requests in parallel can't outrun the lockout.
 */
class ClientLimiter {
  constructor() {
    this.clients = new Map();
    this.inFlight = new Set();
  }
  async run(key, fn) {
    let throttle = this.clients.get(key);
    if (!throttle) {
      if (this.clients.size >= MAX_TRACKED_CLIENTS) this.clients.delete(this.clients.keys().next().value);
      throttle = new Throttle({ free: 5 });
      this.clients.set(key, throttle);
    }
    const wait = throttle.retryAfterMs();
    if (wait > 0) throw new AuthError('Too many failed attempts. Try again later.', { status: 429, retryAfterMs: wait });
    if (this.inFlight.has(key)) throw new AuthError('Another attempt is in progress.', { status: 429, retryAfterMs: 1000 });
    this.inFlight.add(key);
    try {
      return await fn(throttle);
    } finally {
      this.inFlight.delete(key);
      if (!throttle.failures) this.clients.delete(key);
    }
  }
}

export class AuthError extends Error {
  constructor(message, { status = 401, retryAfterMs = 0, field } = {}) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.field = field;
  }
}

/** Set or change the login password (the `set-password` command). Works while Pasu is running. */
export async function setPassword(password) {
  const state = readJson(config.authFile, null);
  if (!state?.secret) throw new Error('No authenticator is enrolled yet. Run first-time setup in the browser instead.');
  const problem = validatePassword(password);
  if (problem) throw new Error(problem);
  state.password = await hashPassword(password);
  writeJson(config.authFile, state);
}

/**
 * Login needs a password and a TOTP code. Failures count against the client's
 * address; only a correct password with a wrong code also counts against the
 * global lockout. So someone guessing passwords can only lock themselves out,
 * while the code (~20 bits) stays protected even against many addresses, and
 * that lockout survives restarts.
 */
export class Auth {
  constructor() {
    this.state = readJson(config.authFile, null); // { secret, lastCounter, createdAt, password }
    this.sessions = new Map(Object.entries(readJson(config.sessionsFile, {}) ?? {}));
    this.pendingSecret = null;
    this.global = new Throttle({
      free: 3,
      state: readJson(config.throttleFile, {}) ?? {},
      onChange: (t) => writeJson(config.throttleFile, t.toJSON()),
    });
    this.clients = new ClientLimiter();
    // Until an authenticator is enrolled, setup requires this token (printed to the
    // console), so whoever first reaches the port can't claim the instance.
    this.setupToken = this.isConfigured() ? null : crypto.randomBytes(16).toString('hex');
    this._pruneSessions();
  }

  isConfigured() {
    return Boolean(this.state?.secret);
  }

  /** True when enrolled before passwords existed; login is refused until `set-password` is run. */
  needsPassword() {
    this._reload();
    return this.isConfigured() && !this.state.password;
  }

  // auth.json may have been changed by `set-password` since startup.
  _reload() {
    if (this.isConfigured()) this.state = readJson(config.authFile, null);
  }

  _checkGlobal() {
    const wait = this.global.retryAfterMs();
    if (wait > 0) throw new AuthError('Too many failed attempts. Try again later.', { status: 429, retryAfterMs: wait });
  }

  _checkSetupToken(token, client) {
    if (!this.setupToken || !safeEqual(token, this.setupToken)) {
      client.fail();
      throw new AuthError('Invalid setup token', { status: 403 });
    }
  }

  async beginSetup(token, meta) {
    if (this.isConfigured()) throw new AuthError('Already configured', { status: 409 });
    return this.clients.run(clientKey(meta.ip), async (client) => {
      this._checkSetupToken(token, client);
      // Reuse the pending secret so reloading the page doesn't invalidate an already-scanned QR code.
      this.pendingSecret ??= totp.generateSecret();
      const { name: issuer, account } = config;
      const uri = totp.otpauthUri(this.pendingSecret, { issuer, account });
      const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      return { secret: this.pendingSecret, uri, qrSvg, issuer, account };
    });
  }

  async confirmSetup(token, { password, code }, meta) {
    if (this.isConfigured()) throw new AuthError('Already configured', { status: 409 });
    return this.clients.run(clientKey(meta.ip), async (client) => {
      this._checkSetupToken(token, client);
      if (!this.pendingSecret) throw new AuthError('Setup not started', { status: 400 });
      const problem = validatePassword(password);
      if (problem) throw new AuthError(problem, { status: 400, field: 'password' });
      const counter = totp.verify(this.pendingSecret, String(code ?? '').trim());
      if (counter === null) {
        client.fail();
        throw new AuthError('Code did not match. Check the time on your phone and try again.', { field: 'code' });
      }
      const hashed = await hashPassword(password);
      if (this.isConfigured()) throw new AuthError('Already configured', { status: 409 });
      this.state = { secret: this.pendingSecret, lastCounter: counter, password: hashed, createdAt: new Date().toISOString() };
      writeJson(config.authFile, this.state);
      this.pendingSecret = null;
      this.setupToken = null;
      client.succeed();
      return this._createSession(meta);
    });
  }

  async login({ password, code }, meta) {
    if (!this.isConfigured()) throw new AuthError('Not configured', { status: 409 });
    if (this.needsPassword()) throw new AuthError(NO_PASSWORD, { status: 409 });
    this._checkGlobal();
    return this.clients.run(clientKey(meta.ip), async (client) => {
      const wrong = () => new AuthError('Wrong password or code', {
        retryAfterMs: Math.max(client.retryAfterMs(), this.global.retryAfterMs()),
      });
      if (!(await verifyPassword(this.state.password, password))) {
        client.fail();
        throw wrong();
      }
      // Synchronous from here on, so concurrent logins can't slip past the global lockout.
      this._checkGlobal();
      const counter = totp.verify(this.state.secret, String(code ?? '').trim(), { lastCounter: this.state.lastCounter });
      if (counter === null) {
        client.fail();
        this.global.fail();
        throw wrong();
      }
      client.succeed();
      this.global.succeed();
      this.state.lastCounter = counter;
      writeJson(config.authFile, this.state);
      return this._createSession(meta);
    });
  }

  _createSession({ ip, userAgent }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(sha256(token), {
      createdAt: now,
      expiresAt: now + config.sessionTtlMs,
      ip,
      userAgent: String(userAgent ?? '').slice(0, 200),
    });
    this._saveSessions();
    return { token, maxAgeSec: Math.floor(config.sessionTtlMs / 1000) };
  }

  /** Only the hash of a session token is stored, so a leaked sessions.json can't be replayed. */
  validateSession(token) {
    if (!token || !this.isConfigured()) return false;
    const s = this.sessions.get(sha256(token));
    if (!s) return false;
    if (s.expiresAt < Date.now()) {
      this.sessions.delete(sha256(token));
      this._saveSessions();
      return false;
    }
    return true;
  }

  logout(token) {
    if (token && this.sessions.delete(sha256(token))) this._saveSessions();
  }

  _pruneSessions() {
    const now = Date.now();
    let changed = false;
    for (const [k, s] of this.sessions) {
      if (s.expiresAt < now) {
        this.sessions.delete(k);
        changed = true;
      }
    }
    if (changed) this._saveSessions();
  }

  _saveSessions() {
    writeJson(config.sessionsFile, Object.fromEntries(this.sessions));
  }
}
