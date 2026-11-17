import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { readJson, writeJson, removeFile } from './fsutil.js';

// Each registered process is one JSON file: data/processes/<id>.json.
// The id is derived from the name at creation and never changes, so it is
// safe to use in file paths (validated against ID_RE everywhere).

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGKILL', 'SIGUSR1', 'SIGUSR2'];

export class ValidationError extends Error {
  constructor(errors) {
    super(Object.values(errors).join('; '));
    this.errors = errors;
  }
}

function specPath(id) {
  if (!ID_RE.test(id)) throw new Error(`invalid process id: ${id}`);
  return path.join(config.processesDir, `${id}.json`);
}

export function slugify(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'process';
}

/** Validate and normalize user input into a spec. Throws ValidationError with per-field messages. */
export function normalizeSpec(input) {
  const errors = {};
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) errors.name = 'Name is required';
  else if (name.length > 100) errors.name = 'Name is too long';

  const command = typeof input.command === 'string' ? input.command.trim() : '';
  if (!command) errors.command = 'Command is required';

  let cwd = typeof input.cwd === 'string' ? input.cwd.trim() : '';
  if (cwd === '~' || cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(1));
  if (!cwd) errors.cwd = 'Working directory is required';
  else if (!path.isAbsolute(cwd)) errors.cwd = 'Must be an absolute path';
  else {
    try {
      if (!fs.statSync(cwd).isDirectory()) errors.cwd = 'Not a directory';
    } catch {
      errors.cwd = 'Directory does not exist';
    }
  }

  const env = {};
  const rawEnv = input.env ?? {};
  if (typeof rawEnv !== 'object' || Array.isArray(rawEnv)) errors.env = 'Environment must be an object';
  else {
    for (const [k, v] of Object.entries(rawEnv)) {
      if (!ENV_KEY_RE.test(k)) { errors.env = `Invalid variable name: ${k}`; break; }
      env[k] = String(v ?? '');
    }
  }

  const stopSignal = input.stopSignal || 'SIGTERM';
  if (!SIGNALS.includes(stopSignal)) errors.stopSignal = 'Unsupported signal';

  const stopTimeoutSec = Number(input.stopTimeoutSec ?? config.defaultStopTimeoutSec);
  if (!Number.isFinite(stopTimeoutSec) || stopTimeoutSec < 0 || stopTimeoutSec > 600) {
    errors.stopTimeoutSec = 'Must be between 0 and 600 seconds';
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  // Failure emails are on unless turned off for this process (and only sent when enabled in settings).
  const notify = input.notify !== false;
  return { name, command, cwd, env, autostart: Boolean(input.autostart), stopSignal, stopTimeoutSec, notify };
}

export function listSpecs() {
  let files;
  try {
    files = fs.readdirSync(config.processesDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const specs = [];
  for (const f of files) {
    const m = /^([a-z0-9][a-z0-9_-]*)\.json$/.exec(f);
    if (!m || !ID_RE.test(m[1])) continue;
    try {
      const spec = readJson(path.join(config.processesDir, f));
      if (spec) specs.push({ ...spec, id: m[1] });
    } catch (err) {
      console.error(`[store] skipping unreadable ${f}: ${err.message}`);
    }
  }
  return specs.sort((a, b) => a.name.localeCompare(b.name));
}

export function getSpec(id) {
  if (!ID_RE.test(id)) return null;
  const spec = readJson(specPath(id));
  return spec ? { ...spec, id } : null;
}

export function createSpec(input) {
  const spec = normalizeSpec(input);
  const base = slugify(spec.name);
  let id = base;
  for (let n = 2; fs.existsSync(specPath(id)); n++) id = `${base}-${n}`;
  const now = new Date().toISOString();
  const full = { id, ...spec, createdAt: now, updatedAt: now };
  writeJson(specPath(id), full);
  return full;
}

export function updateSpec(id, input) {
  const existing = getSpec(id);
  if (!existing) return null;
  const spec = normalizeSpec(input);
  const full = { id, ...spec, createdAt: existing.createdAt, updatedAt: new Date().toISOString() };
  writeJson(specPath(id), full);
  return full;
}

export function deleteSpec(id) {
  removeFile(specPath(id));
}
