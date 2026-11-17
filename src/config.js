import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// All runtime configuration comes from environment variables so the app can be
// dropped into a systemd unit without a separate config file.
const env = process.env;
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Follows the XDG base directory spec, so an npm upgrade (which replaces APP_DIR) never touches it.
const defaultDataDir = path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'pasu');
const dataDir = path.resolve(env.PASU_DATA || defaultDataDir);

function bool(name, fallback) {
  const v = env[name];
  if (v == null || v === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error(`${name} must be on/off, got "${v}"`);
}

function parsePublicUrl(raw) {
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('PASU_PUBLIC_URL must be an http(s) URL');
  // Normalize to origin + path without a trailing slash: "https://host/pasu".
  return { origin: url.origin, host: url.host, hostname: url.hostname, path: url.pathname.replace(/\/+$/, '') };
}

// Behind a reverse proxy, TLS is terminated by the proxy and Pasu should
// only listen on loopback.
const tls = bool('PASU_TLS', true);
const publicUrl = parsePublicUrl(env.PASU_PUBLIC_URL);

export const config = {
  // Shown in the UI and as the issuer in authenticator apps; set it per server.
  name: (env.PASU_NAME || 'Pasu').trim(),
  tls,
  host: env.PASU_HOST || (tls ? '0.0.0.0' : '127.0.0.1'),
  port: Number(env.PASU_PORT || 8443),
  // Where users reach the app (e.g. https://pasu.example.com or https://example.com/pasu).
  publicUrl,
  // Honour X-Forwarded-For/-Host/-Proto. Only enable when a proxy you control sits in front.
  trustProxy: bool('PASU_TRUST_PROXY', !tls),
  // Account label in authenticator apps; distinguishes servers sharing a name.
  account: (env.PASU_ACCOUNT || publicUrl?.hostname || os.hostname()).trim(),
  dataDir,
  dataDirIsDefault: !env.PASU_DATA,
  // Where versions before the npm package kept their data.
  legacyDataDir: path.join(APP_DIR, 'data'),
  processesDir: path.join(dataDir, 'processes'),
  runDir: path.join(dataDir, 'run'),
  logsDir: path.join(dataDir, 'logs'),
  tlsDir: path.join(dataDir, 'tls'),
  authFile: path.join(dataDir, 'auth.json'),
  sessionsFile: path.join(dataDir, 'sessions.json'),
  throttleFile: path.join(dataDir, 'throttle.json'),
  settingsFile: path.join(dataDir, 'settings.json'),
  // Provide your own certificate, or a self-signed one is generated into tlsDir.
  tlsCert: env.PASU_TLS_CERT || null,
  tlsKey: env.PASU_TLS_KEY || null,
  sessionTtlMs: Number(env.PASU_SESSION_DAYS || 30) * 24 * 3600 * 1000,
  logMaxBytes: Number(env.PASU_LOG_MAX_MB || 5) * 1024 * 1024,
  pollIntervalMs: 1000,
  backoff: { initialMs: 1000, maxMs: 60_000, stableAfterMs: 30_000 },
  defaultStopTimeoutSec: 10,
};
