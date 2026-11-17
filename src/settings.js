import net from 'node:net';
import { config } from './config.js';
import { readJson, writeJson } from './fsutil.js';
import { defaultInstanceId } from './hostinfo.js';
import { ValidationError } from './store.js';

// App-wide settings, kept in data/settings.json (mode 0600: it holds the SMTP password).
// The password never leaves the server; the UI only learns whether one is saved.

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

const EMAIL_DEFAULTS = { enabled: false, to: '', from: '', host: '', port: 587, user: '', password: '' };

export function loadSettings() {
  const saved = readJson(config.settingsFile, {}) ?? {};
  return { instanceId: saved.instanceId ?? '', email: { ...EMAIL_DEFAULTS, ...saved.email } };
}

/** The Pasu ID: what's set in Settings, or the domain / hostname. */
export const instanceId = (settings = loadSettings()) => settings.instanceId || defaultInstanceId();

/** Settings as shown to the browser: everything except the password. */
export function publicSettings(settings = loadSettings()) {
  const { password, ...email } = settings.email;
  return { instanceId: settings.instanceId, defaultInstanceId: defaultInstanceId(), email: { ...email, hasPassword: Boolean(password) } };
}

export function normalizeInstanceId(input) {
  const id = typeof input === 'string' ? input.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (id.length > 100 || /[\x00-\x1f\x7f]/.test(id)) throw new ValidationError({ instanceId: 'Use up to 100 characters, on one line' });
  return id;
}

export const isLoopback = (host) => host === 'localhost' || (net.isIP(host) && (host === '::1' || host.startsWith('127.')));

/**
 * Validate email settings from the UI. A blank password keeps the saved one; clearing the
 * username clears the password too. `require` forces the fields needed to send (for a test
 * email), which are otherwise only required once notifications are enabled.
 */
export function normalizeEmail(input, saved, { require = false } = {}) {
  const errors = {};
  const str = (k) => (typeof input[k] === 'string' ? input[k].trim() : '');
  const enabled = Boolean(input.enabled);
  const needed = enabled || require;

  const to = str('to');
  if (!to) needed && (errors.to = 'Enter the address to notify');
  else if (!EMAIL_RE.test(to) || to.length > 254) errors.to = 'Not a valid email address';

  const from = str('from');
  if (from && (!EMAIL_RE.test(from) || from.length > 254)) errors.from = 'Not a valid email address';

  const host = str('host').toLowerCase();
  if (!host) needed && (errors.host = 'Enter the SMTP server');
  else if (!HOST_RE.test(host) && !net.isIP(host)) errors.host = 'Not a valid host name';

  const port = Number(input.port ?? 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = 'Must be between 1 and 65535';

  const user = str('user');
  if (user.length > 254) errors.user = 'Too long';
  const typed = typeof input.password === 'string' ? input.password : '';
  if (typed.length > 1024) errors.password = 'Too long';
  const password = !user ? '' : typed || saved.password || '';
  if (user && !password) errors.password = 'Enter the SMTP password';

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { enabled, to, from, host, port, user, password };
}

export function saveSettings(input) {
  const saved = loadSettings();
  const errors = {};
  let id = saved.instanceId;
  let email;
  try {
    if (input?.instanceId !== undefined) id = normalizeInstanceId(input.instanceId);
  } catch (err) {
    Object.assign(errors, err.errors);
  }
  try {
    email = normalizeEmail(input?.email ?? {}, saved.email);
  } catch (err) {
    Object.assign(errors, err.errors);
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const settings = { ...saved, instanceId: id, email };
  writeJson(config.settingsFile, settings);
  return publicSettings(settings);
}
