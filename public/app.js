// Pasu frontend. No framework: DOM is built with h() so user-controlled
// strings (names, commands, log output) are only ever inserted as text.

const app = document.getElementById('app');
const POLL_MS = 2000;
const LOG_POLL_MS = 1500;
const LOG_MAX_LINES = 5000;

// Instance name (PASU_NAME), so several servers' tabs are easy to tell apart.
let appName = 'Pasu';

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError('Cannot reach Pasu', 0);
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('api/login') && !path.startsWith('api/setup')) {
    showLogin();
    throw new ApiError('Session expired', 401, data);
  }
  if (!res.ok) throw new ApiError(data?.error || `${res.status} ${res.statusText}`, res.status, data);
  return data;
}

function toast(message, kind = 'error') {
  const el = h('div', { class: `toast toast-${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.classList.add('toast-out'), 4000);
  setTimeout(() => el.remove(), 4400);
}

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const hr = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmtBytes(n) {
  if (n == null) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i && n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// 100% is one core fully busy, as in top.
const fmtCpu = (v) => (v == null ? '–' : `${v < 10 ? v.toFixed(1) : Math.round(v)}%`);

const ago = (iso) => `${duration(Date.now() - new Date(iso).getTime())} ago`;

function describeExit(e) {
  if (!e) return null;
  if (e.error) return `failed to start: ${e.error}`;
  if (e.note) return e.note;
  if (e.signal) return `killed by ${e.signal}`;
  if (e.code != null) return `exited with code ${e.code}`;
  return 'exited';
}

let screenCleanup = null;
function setScreen(...nodes) {
  screenCleanup?.();
  screenCleanup = null;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  app.replaceChildren(...nodes);
}

// ---------- boot ----------

async function boot() {
  let status;
  try {
    status = await api('GET', 'api/auth/status');
    appName = status.name || appName;
    document.title = appName;
  } catch (err) {
    setScreen(h('div', { class: 'center' }, h('div', { class: 'card' }, h('h1', {}, 'Pasu'), h('p', { class: 'muted' }, err.message))));
    return;
  }
  if (!status.configured) showSetup();
  else if (!status.authenticated) showLogin(status);
  else showMain();
}

// ---------- setup ----------

function setupToken() {
  return new URLSearchParams(location.hash.slice(1)).get('setup');
}

async function showSetup() {
  const token = setupToken();
  if (!token) {
    setScreen(h('div', { class: 'center' }, h('div', { class: 'card' },
      brand(),
      h('h1', {}, 'Setup link required'),
      h('p', {}, 'Before an authenticator is enrolled, first-time setup needs the one-time link Pasu printed to its console at startup.'),
      h('pre', { class: 'hint' }, 'https://<host>:<port>/#setup=<token>'),
      h('p', { class: 'muted' }, 'Restart Pasu to see the link again.'),
    )));
    return;
  }

  let setup;
  try {
    setup = await api('POST', 'api/setup/begin', { token });
  } catch (err) {
    if (err.status === 409) return boot();
    setScreen(h('div', { class: 'center' }, h('div', { class: 'card' }, brand(), h('h1', {}, 'Setup unavailable'), h('p', { class: 'error-text' }, err.message))));
    return;
  }

  const qr = h('div', { class: 'qr', 'aria-label': 'QR code for your authenticator app', role: 'img' });
  qr.innerHTML = setup.qrSvg; // generated server-side from our own otpauth URI
  const grouped = setup.secret.match(/.{1,4}/g).join(' ');
  const copyBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: async () => {
    await navigator.clipboard.writeText(setup.secret).catch(() => {});
    copyBtn.textContent = 'Copied';
    setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
  } }, 'Copy');

  const password = passwordInput('new-password', 'Password');
  const repeat = passwordInput('new-password', 'Repeat password');
  const { field, error, submit } = codeForm(async (code) => {
    await api('POST', 'api/setup/confirm', { token, code, password: password.value });
    history.replaceState(null, '', location.pathname);
    showMain();
  }, {
    inputs: [password, repeat],
    check: () => {
      if (password.value.length < MIN_PASSWORD) return [password, `Choose a password of at least ${MIN_PASSWORD} characters.`];
      if (repeat.value !== password.value) return [repeat, 'The passwords don’t match.'];
      return null;
    },
  });

  setScreen(h('div', { class: 'center' }, h('div', { class: 'card card-wide' },
    brand(),
    h('h1', {}, 'Set up sign-in'),
    h('p', { class: 'muted' }, 'Signing in will take a password and a code from your authenticator app.'),
    h('form', { onsubmit: submit },
      h('ol', { class: 'steps' },
        h('li', {},
          h('p', {}, 'Scan this QR code with your authenticator app (Google Authenticator, 1Password, Authy, …).'),
          qr,
          h('p', { class: 'muted small' }, 'It will appear as ', h('strong', {}, setup.issuer), ` (${setup.account}).`),
          h('details', { class: 'manual' },
            h('summary', {}, 'Can’t scan? Enter the key manually'),
            h('div', { class: 'secret-row' }, h('code', { class: 'secret' }, grouped), copyBtn),
            h('p', { class: 'muted small' }, 'Time-based, SHA-1, 6 digits, 30 seconds.'),
          ),
        ),
        h('li', {},
          h('p', {}, 'Choose a password. A password manager can generate and remember a long one.'),
          labeled('Password', password, `At least ${MIN_PASSWORD} characters.`),
          labeled('Repeat password', repeat),
        ),
        h('li', {},
          h('p', {}, 'Enter the 6-digit code your authenticator app shows.'),
          h('div', { class: 'code-form' }, field, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Verify and finish')),
          error,
        ),
      ),
    ),
  )));
}

// ---------- login ----------

const MIN_PASSWORD = 12;

function brand() {
  return h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '', width: 28, height: 28 }), h('span', {}, appName));
}

function passwordInput(autocomplete, label) {
  return h('input', { type: 'password', autocomplete, required: true, maxlength: 1024, 'aria-label': label });
}

function labeled(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint && h('span', { class: 'field-hint' }, hint));
}

/**
 * A 6-digit code input that submits itself once complete. `inputs` are other
 * fields of the form (disabled along with it during a lockout); `check()`
 * returns [input, message] to block submitting, or null.
 */
function codeForm(onCode, { inputs = [], check = () => null } = {}) {
  const input = h('input', {
    class: 'code-input', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code',
    pattern: '[0-9]{6}', maxlength: 6, placeholder: '000000', required: true, 'aria-label': '6-digit code',
  });
  const all = [...inputs, input];
  const error = h('p', { class: 'error-text', role: 'alert' });
  let busy = false;
  let lockTimer = null;

  const lockFor = (ms) => {
    clearInterval(lockTimer);
    const until = Date.now() + ms;
    all.forEach((el) => (el.disabled = true));
    const tick = () => {
      const left = until - Date.now();
      if (left <= 0) {
        clearInterval(lockTimer);
        all.forEach((el) => (el.disabled = false));
        error.textContent = '';
        (all.find((el) => !el.value) ?? input).focus();
        return;
      }
      error.textContent = `Too many attempts. Try again in ${duration(left + 999)}.`;
    };
    tick();
    lockTimer = setInterval(tick, 500);
  };

  const shake = (el) => {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  };

  const submit = async (e) => {
    e?.preventDefault();
    const code = input.value.replace(/\D/g, '');
    if (busy || all.some((el) => el.disabled)) return;
    const problem = check();
    if (problem) {
      error.textContent = problem[1];
      problem[0].focus();
      return;
    }
    if (code.length !== 6) {
      error.textContent = 'Enter the 6-digit code from your authenticator app.';
      input.focus();
      return;
    }
    busy = true;
    input.classList.add('busy');
    try {
      await onCode(code);
    } catch (err) {
      if (err.status === 429) {
        input.value = '';
        lockFor(err.data?.retryAfterMs ?? 5000);
        return;
      }
      error.textContent = err.message;
      // A rejected password at setup leaves the code unused; anything else needs a fresh code.
      const target = err.data?.field === 'password' ? inputs[0] : input;
      if (target === input) input.value = '';
      if (err.data?.retryAfterMs) lockFor(err.data.retryAfterMs);
      shake(target);
      target.focus();
    } finally {
      busy = false;
      input.classList.remove('busy');
    }
  };

  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6);
    if (input.value.length === 6) submit();
  });
  return { field: input, input, error, submit };
}

function showLogin(status) {
  if (app.querySelector('.login-card')) return;
  if (status?.needsPassword) {
    setScreen(h('div', { class: 'center' }, h('div', { class: 'card login-card' },
      brand(),
      h('h1', {}, 'Set a password first'),
      h('p', {}, 'Signing in now takes a password as well as a code. This Pasu instance was set up before that, so it has no password yet. On the server, run:'),
      h('pre', { class: 'hint' }, 'pasu set-password'),
      h('p', { class: 'muted' }, 'Then reload this page. Pasu doesn’t need a restart.'),
    )));
    return;
  }
  const password = passwordInput('current-password', 'Password');
  const { field, error, submit } = codeForm(async (code) => {
    await api('POST', 'api/login', { password: password.value, code });
    showMain();
  }, {
    inputs: [password],
    check: () => (password.value ? null : [password, 'Enter your password.']),
  });
  setScreen(h('div', { class: 'center' }, h('div', { class: 'card login-card' },
    brand(),
    h('h1', {}, 'Sign in'),
    h('form', { onsubmit: submit },
      labeled('Password', password),
      h('span', { class: 'field-label' }, 'Code from your authenticator app'),
      h('div', { class: 'code-form code-form-tight' }, field, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign in')),
      error,
    ),
  )));
  password.focus();
}

// ---------- main ----------

const STATUS_LABEL = { running: 'Running', stopped: 'Stopped', stopping: 'Stopping', backoff: 'Crashed', failed: 'Failed' };

function showMain() {
  const list = h('div', { class: 'proc-list' });
  const summary = h('span', { class: 'summary muted' });
  const rows = new Map();
  let procs = [];
  let pollTimer = null;
  let stopped = false;

  const header = h('header', { class: 'topbar' },
    brand(),
    summary,
    h('div', { class: 'topbar-actions' },
      h('button', { class: 'btn btn-primary', onclick: () => openEditor(null, refresh) }, '+ New process'),
      h('button', { class: 'btn', onclick: () => openSettings() }, 'Settings'),
      h('button', { class: 'btn btn-ghost', onclick: async () => {
        await api('POST', 'api/logout').catch(() => {});
        showLogin();
      } }, 'Sign out'),
    ),
  );

  const render = () => {
    const running = procs.filter((p) => p.status === 'running').length;
    const troubled = procs.filter((p) => p.status === 'backoff' || p.status === 'failed').length;
    summary.textContent = procs.length
      ? `${running} of ${procs.length} running${troubled ? ` · ${troubled} need attention` : ''}`
      : '';

    if (!procs.length) {
      rows.clear();
      list.replaceChildren(h('div', { class: 'empty' },
        h('h2', {}, 'No processes yet'),
        h('p', { class: 'muted' }, 'Register a command and Pasu will keep an eye on it.'),
        h('button', { class: 'btn btn-primary', onclick: () => openEditor(null, refresh) }, '+ New process'),
      ));
      return;
    }
    list.querySelector('.empty')?.remove();

    const seen = new Set();
    procs.forEach((p, i) => {
      seen.add(p.id);
      let row = rows.get(p.id);
      if (!row) {
        row = createRow(p.id, refresh);
        rows.set(p.id, row);
      }
      row.update(p);
      // Only move nodes when the order actually changed, so focus is kept.
      if (list.children[i] !== row.el) list.insertBefore(row.el, list.children[i] ?? null);
    });
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.el.remove();
        rows.delete(id);
      }
    }
  };

  async function refresh() {
    try {
      procs = await api('GET', 'api/processes');
      render();
      app.querySelector('.offline')?.remove();
    } catch (err) {
      if (err.status === 401) return;
      if (!app.querySelector('.offline')) header.after(h('div', { class: 'offline' }, `Connection problem: ${err.message}. Retrying…`));
    }
  }

  const schedule = () => {
    clearTimeout(pollTimer);
    if (stopped) return;
    pollTimer = setTimeout(async () => {
      if (!document.hidden) await refresh();
      schedule();
    }, POLL_MS);
  };
  const onVisible = () => !document.hidden && refresh();
  // Uptimes and countdowns tick between polls.
  const clock = setInterval(() => rows.forEach((r) => r.tick()), 1000);

  setScreen(header, h('div', { class: 'container' }, list));
  document.addEventListener('visibilitychange', onVisible);
  screenCleanup = () => {
    stopped = true;
    clearTimeout(pollTimer);
    clearInterval(clock);
    document.removeEventListener('visibilitychange', onVisible);
  };
  refresh().then(schedule);
}

/** Start/Stop and Restart buttons for one process, shared by its row and its log viewer. */
function processControls(id, { onBusy, after }) {
  let p = null;
  let busy = false;
  const isActive = () => p.status === 'running' || p.status === 'stopping' || p.status === 'backoff';

  const act = async (label, action) => {
    if (busy || !p) return;
    busy = true;
    onBusy(label);
    sync();
    try {
      await api('POST', `api/processes/${id}/${action}`);
    } catch (err) {
      toast(`${p.name}: ${err.message}`);
    } finally {
      busy = false;
      onBusy(null);
      await after();
    }
  };

  const toggleBtn = h('button', { class: 'btn btn-sm', onclick: () => (isActive() ? act('Stopping', 'stop') : act('Starting', 'start')) });
  const restartBtn = h('button', { class: 'btn btn-sm', onclick: () => act('Restarting', 'restart') }, 'Restart');

  const sync = () => {
    if (!p) return;
    const active = isActive();
    toggleBtn.textContent = active ? 'Stop' : 'Start';
    toggleBtn.className = `btn btn-sm ${active ? '' : 'btn-primary'}`;
    toggleBtn.disabled = busy || p.status === 'stopping';
    restartBtn.disabled = busy || p.status !== 'running';
  };

  return {
    toggleBtn,
    restartBtn,
    isBusy: () => busy,
    update(next) {
      p = next;
      sync();
    },
  };
}

function createRow(id, refresh) {
  const dot = h('span', { class: 'dot', 'aria-hidden': 'true' });
  const name = h('h3', { class: 'proc-name' });
  const badges = h('span', { class: 'badges' });
  const cmd = h('code', { class: 'proc-cmd' });
  const statusText = h('span', { class: 'status-text' });
  const detail = h('span', { class: 'detail' });
  const cwd = h('span', { class: 'cwd' });

  let p = null;
  const controls = processControls(id, {
    onBusy: (label) => {
      el.classList.toggle('busy', Boolean(label));
      if (label) statusText.textContent = `${label}…`;
    },
    after: refresh,
  });
  const logsBtn = h('button', { class: 'btn btn-sm btn-ghost', onclick: () => openLogs(p, refresh) }, 'Logs');
  const resourcesBtn = h('button', { class: 'btn btn-sm btn-ghost', onclick: () => openResources(p, refresh) }, 'Resources');
  const editBtn = h('button', { class: 'btn btn-sm btn-ghost', onclick: () => openEditor(p, refresh) }, 'Edit');

  const el = h('article', { class: 'proc' },
    h('div', { class: 'proc-main' },
      h('div', { class: 'proc-title' }, dot, name, badges),
      cmd,
      h('div', { class: 'proc-meta' }, statusText, detail, cwd),
    ),
    h('div', { class: 'proc-actions' }, controls.toggleBtn, controls.restartBtn, logsBtn, resourcesBtn, editBtn),
  );

  const tick = () => {
    if (!p || controls.isBusy()) return;
    const parts = [];
    if (p.status === 'running') {
      parts.push(`pid ${p.pid}`);
      if (p.startedAt) parts.push(`up ${duration(Date.now() - new Date(p.startedAt).getTime())}`);
      if (p.usage?.cpu != null) parts.push(`${fmtCpu(p.usage.cpu)} CPU`);
      if (p.usage) parts.push(`${fmtBytes(p.usage.rss)} RAM`);
    } else if (p.status === 'backoff') {
      const left = new Date(p.nextRestartAt).getTime() - Date.now();
      parts.push(describeExit(p.lastExit));
      parts.push(left > 0 ? `restarting in ${duration(left + 999)}` : 'restarting…');
      if (p.crashCount > 1) parts.push(`attempt ${p.crashCount}`);
    } else if (p.status === 'failed') {
      parts.push(p.error || describeExit(p.lastExit));
    } else if (p.lastExit && p.status === 'stopped') {
      parts.push(`${describeExit(p.lastExit)} ${ago(p.lastExit.at)}`);
    }
    statusText.textContent = STATUS_LABEL[p.status] ?? p.status;
    detail.textContent = parts.filter(Boolean).join(' · ');
  };

  const update = (next) => {
    p = next;
    el.dataset.status = p.status;
    name.textContent = p.name;
    name.title = p.id;
    cmd.textContent = p.command;
    cmd.title = p.command;
    cwd.textContent = p.cwd;
    cwd.title = `Working directory: ${p.cwd}`;
    const b = [];
    if (p.autostart) {
      b.push(p.held
        ? h('span', { class: 'badge badge-warn', title: 'Stopped manually; auto-start resumes when you start it again' }, 'auto-start paused')
        : h('span', { class: 'badge', title: 'Started automatically and restarted if it exits' }, 'auto-start'));
    }
    if (p.needsRestart) b.push(h('span', { class: 'badge badge-info', title: 'Command, directory or environment changed since it was started' }, 'restart to apply changes'));
    badges.replaceChildren(...b);

    controls.update(p);
    tick();
  };

  return { el, tick, update };
}

// ---------- editor ----------

function envToText(env) {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

function parseEnv(text) {
  const env = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new Error(`Line ${i + 1}: expected KEY=value`);
    let value = m[2];
    if (/^(['"]).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    env[m[1]] = value;
  }
  return env;
}

function field(label, control, { hint, name } = {}) {
  const error = h('p', { class: 'field-error', id: `err-${name}` });
  control.setAttribute('aria-describedby', `err-${name}`);
  const wrap = h('label', { class: 'field', dataset: { field: name } },
    h('span', { class: 'field-label' }, label),
    control,
    hint && h('span', { class: 'field-hint' }, hint),
    error,
  );
  return { wrap, error };
}

function openEditor(p, refresh) {
  const isNew = !p;
  const v = p ?? { name: '', command: '', cwd: '', env: {}, autostart: true, stopSignal: 'SIGTERM', stopTimeoutSec: 10, notify: true };

  const inputs = {
    name: h('input', { name: 'name', value: v.name, required: true, maxlength: 100, autocomplete: 'off', placeholder: 'My API server' }),
    command: h('textarea', { name: 'command', rows: 2, required: true, spellcheck: 'false', class: 'mono', placeholder: 'npm run start' }),
    cwd: h('input', { name: 'cwd', value: v.cwd, required: true, spellcheck: 'false', class: 'mono', placeholder: '/home/me/projects/api' }),
    env: h('textarea', { name: 'env', rows: 4, spellcheck: 'false', class: 'mono', placeholder: 'PORT=3000\nNODE_ENV=production' }),
    autostart: h('input', { type: 'checkbox', name: 'autostart', checked: v.autostart }),
    notify: h('input', { type: 'checkbox', name: 'notify', checked: v.notify !== false }),
    stopSignal: h('select', { name: 'stopSignal' }, ...['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2', 'SIGKILL'].map((s) => h('option', { value: s, selected: s === v.stopSignal }, s))),
    stopTimeoutSec: h('input', { type: 'number', name: 'stopTimeoutSec', min: 0, max: 600, value: v.stopTimeoutSec }),
  };
  inputs.command.value = v.command;
  inputs.env.value = envToText(v.env);

  const f = {
    name: field('Name', inputs.name, { name: 'name' }),
    command: field('Command', inputs.command, { name: 'command', hint: 'Run with bash -c. Keep it in the foreground (no trailing &, no daemonize flags).' }),
    cwd: field('Working directory', inputs.cwd, { name: 'cwd', hint: 'Absolute path. ~ expands to your home directory.' }),
    env: field('Environment variables', inputs.env, { name: 'env', hint: 'One KEY=value per line. Added on top of Pasu’s environment.' }),
    stopSignal: field('Stop signal', inputs.stopSignal, { name: 'stopSignal' }),
    stopTimeoutSec: field('Grace period (s)', inputs.stopTimeoutSec, { name: 'stopTimeoutSec', hint: 'Then SIGKILL.' }),
  };
  const autostartRow = h('label', { class: 'switch-row' },
    inputs.autostart,
    h('span', {}, h('strong', {}, 'Keep running'), h('span', { class: 'field-hint' }, 'Start automatically, and restart (with backoff) whenever it exits.')),
  );
  const notifyHint = h('span', { class: 'field-hint' }, 'Send an email when this process fails.');
  const notifyRow = h('label', { class: 'switch-row' },
    inputs.notify,
    h('span', {}, h('strong', {}, 'Email notifications'), notifyHint),
  );
  api('GET', 'api/settings').then(({ email }) => {
    notifyHint.textContent = email.enabled
      ? `Email ${email.to} when this process fails.`
      : 'Email notifications are turned off in Settings, so nothing is sent until you turn them on there.';
  }, () => {});
  const formError = h('p', { class: 'error-text', role: 'alert' });
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, isNew ? 'Create' : 'Save');

  const clearErrors = () => {
    formError.textContent = '';
    Object.values(f).forEach(({ wrap, error }) => {
      wrap.classList.remove('invalid');
      error.textContent = '';
    });
  };
  const showErrors = (fields) => {
    let first = null;
    for (const [k, msg] of Object.entries(fields)) {
      if (!f[k]) continue;
      f[k].wrap.classList.add('invalid');
      f[k].error.textContent = msg;
      first ??= inputs[k];
    }
    first?.focus();
  };

  const form = h('form', { class: 'editor', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    clearErrors();
    let env;
    try {
      env = parseEnv(inputs.env.value);
    } catch (err) {
      return showErrors({ env: err.message });
    }
    const body = {
      name: inputs.name.value,
      command: inputs.command.value,
      cwd: inputs.cwd.value,
      env,
      autostart: inputs.autostart.checked,
      notify: inputs.notify.checked,
      stopSignal: inputs.stopSignal.value,
      stopTimeoutSec: Number(inputs.stopTimeoutSec.value),
    };
    saveBtn.disabled = true;
    try {
      const saved = await api(isNew ? 'POST' : 'PUT', isNew ? 'api/processes' : `api/processes/${p.id}`, body);
      dialog.close();
      if (saved.needsRestart) toast(`${saved.name} saved. Restart it to apply the changes.`, 'info');
      else toast(`${saved.name} ${isNew ? 'created' : 'saved'}`, 'success');
      refresh();
    } catch (err) {
      formError.textContent = err.message;
      if (err.data?.fields) showErrors(err.data.fields);
    } finally {
      saveBtn.disabled = false;
    }
  } },
    h('div', { class: 'dialog-head' }, h('h2', {}, isNew ? 'New process' : `Edit ${p.name}`)),
    h('div', { class: 'dialog-body' },
      f.name.wrap, f.command.wrap, f.cwd.wrap, f.env.wrap, autostartRow, notifyRow,
      h('details', { class: 'advanced', open: !isNew && (v.stopSignal !== 'SIGTERM' || v.stopTimeoutSec !== 10) },
        h('summary', {}, 'Stopping'),
        h('div', { class: 'row-2' }, f.stopSignal.wrap, f.stopTimeoutSec.wrap),
      ),
      formError,
    ),
    h('div', { class: 'dialog-foot' },
      !isNew && h('button', { class: 'btn btn-danger-ghost', type: 'button', onclick: () => confirmDelete(p, () => { dialog.close(); refresh(); }) }, 'Delete…'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      saveBtn,
    ),
  );

  const dialog = h('dialog', { class: 'dialog' }, form);
  showDialog(dialog);
  inputs.name.focus();
}

function showDialog(dialog) {
  dialog.addEventListener('close', () => dialog.remove());
  // Click on the backdrop closes.
  dialog.addEventListener('mousedown', (e) => e.target === dialog && dialog.close());
  document.body.append(dialog);
  dialog.showModal();
}

function confirmDelete(p, onDone) {
  const btn = h('button', { class: 'btn btn-danger', type: 'button', onclick: async () => {
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      await api('DELETE', `api/processes/${p.id}`);
      dialog.close();
      toast(`${p.name} deleted`, 'success');
      onDone();
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  } }, 'Delete');
  const dialog = h('dialog', { class: 'dialog dialog-sm' },
    h('div', { class: 'dialog-head' }, h('h2', {}, `Delete ${p.name}?`)),
    h('div', { class: 'dialog-body' }, h('p', {}, p.status === 'running' ? 'The process will be stopped. Its configuration and logs will be removed.' : 'Its configuration and logs will be removed.')),
    h('div', { class: 'dialog-foot' }, h('span', { class: 'spacer' }), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, 'Cancel'), btn),
  );
  showDialog(dialog);
  btn.focus();
}

// ---------- settings ----------

async function openSettings() {
  let settings;
  try {
    settings = await api('GET', 'api/settings');
  } catch (err) {
    return toast(err.message);
  }
  const e = settings.email;
  const { server } = settings;
  const inputs = {
    instanceId: h('input', { value: settings.instanceId, spellcheck: 'false', autocomplete: 'off', maxlength: 100, placeholder: settings.defaultInstanceId }),
    enabled: h('input', { type: 'checkbox', checked: e.enabled }),
    to: h('input', { type: 'email', value: e.to, autocomplete: 'email', placeholder: 'you@example.com' }),
    host: h('input', { value: e.host, spellcheck: 'false', autocomplete: 'off', placeholder: 'smtp.example.com' }),
    port: h('input', { type: 'number', min: 1, max: 65535, value: e.port }),
    user: h('input', { value: e.user, spellcheck: 'false', autocomplete: 'off', placeholder: 'Empty if no login is needed' }),
    // new-password keeps browsers from filling in the Pasu login password here.
    password: h('input', { type: 'password', autocomplete: 'new-password', placeholder: e.hasPassword ? 'Saved; leave empty to keep it' : '' }),
    from: h('input', { type: 'email', value: e.from, spellcheck: 'false', autocomplete: 'off', placeholder: 'Defaults to the username, if it’s an address' }),
  };
  const f = {
    instanceId: field('Pasu ID', inputs.instanceId, {
      name: 'instanceId',
      hint: `Tells this Pasu apart from your others in emails. Leave empty to use ${settings.defaultInstanceId}. This server: ${server.hostname}${server.ip ? `, public IP ${server.ip}` : ''}.`,
    }),
    to: field('Notification receiver', inputs.to, { name: 'to', hint: 'Where failure emails go.' }),
    host: field('SMTP server', inputs.host, { name: 'host' }),
    port: field('Port', inputs.port, { name: 'port', hint: '465 for TLS, or 587 for STARTTLS (required).' }),
    user: field('SMTP username', inputs.user, { name: 'user' }),
    password: field('SMTP password', inputs.password, { name: 'password', hint: 'Stored on the server, readable only by Pasu’s user. Never sent back to the browser.' }),
    from: field('Sender address (optional)', inputs.from, { name: 'from', hint: 'Some providers only accept mail from an address they verified.' }),
  };
  const enabledRow = h('label', { class: 'switch-row' },
    inputs.enabled,
    h('span', {}, h('strong', {}, 'Enable email notifications'), h('span', { class: 'field-hint' }, 'Email the receiver when a process crashes or fails to start. Processes can opt out in their own settings. Repeated failures are grouped: at most one email per process every 10 minutes.')),
  );
  const status = h('p', { class: 'muted small settings-status' });
  const showStatus = ({ lastSent, lastError }) => {
    const parts = [];
    if (lastSent) parts.push(`Last email sent ${ago(lastSent.at)} to ${lastSent.to}.`);
    if (lastError) parts.push(`Last error ${ago(lastError.at)}: ${lastError.message}`);
    status.textContent = parts.join(' ');
    status.classList.toggle('settings-error', Boolean(lastError && (!lastSent || lastError.at > lastSent.at)));
  };
  showStatus(settings.status);

  const formError = h('p', { class: 'error-text', role: 'alert' });
  const clearErrors = () => {
    formError.textContent = '';
    Object.values(f).forEach(({ wrap, error }) => {
      wrap.classList.remove('invalid');
      error.textContent = '';
    });
  };
  const showErrors = (fields) => {
    let first = null;
    for (const [k, msg] of Object.entries(fields)) {
      if (!f[k]) continue;
      f[k].wrap.classList.add('invalid');
      f[k].error.textContent = msg;
      first ??= inputs[k];
    }
    first?.focus();
  };
  const values = () => ({
    instanceId: inputs.instanceId.value,
    email: {
      enabled: inputs.enabled.checked,
      to: inputs.to.value,
      host: inputs.host.value,
      port: Number(inputs.port.value),
      user: inputs.user.value,
      password: inputs.password.value,
      from: inputs.from.value,
    },
  });
  // Runs a request with the form's values, showing field errors the same way for both buttons.
  const submit = async (btn, busyLabel, request) => {
    clearErrors();
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    try {
      return await request(values());
    } catch (err) {
      formError.textContent = err.message;
      if (err.data?.fields) showErrors(err.data.fields);
      return null;
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };

  const testBtn = h('button', { class: 'btn btn-ghost', type: 'button', onclick: async () => {
    const r = await submit(testBtn, 'Sending…', (body) => api('POST', 'api/settings/test-email', body));
    if (r) toast(`Test email sent to ${r.to}`, 'success');
    api('GET', 'api/settings').then((s) => showStatus(s.status), () => {});
  } }, 'Send test email');
  const saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save');

  const form = h('form', { novalidate: true, onsubmit: async (ev) => {
    ev.preventDefault();
    const r = await submit(saveBtn, 'Saving…', (body) => api('PUT', 'api/settings', body));
    if (!r) return;
    dialog.close();
    toast(r.email.enabled ? `Settings saved. Failures will be emailed to ${r.email.to}.` : 'Settings saved. Email notifications are off.', 'success');
  } },
    h('div', { class: 'dialog-head' }, h('h2', {}, 'Settings')),
    h('div', { class: 'dialog-body' },
      h('h3', { class: 'section-title' }, 'General'),
      f.instanceId.wrap,
      h('h3', { class: 'section-title' }, 'Email notifications'),
      enabledRow,
      f.to.wrap,
      h('div', { class: 'row-2' }, f.host.wrap, f.port.wrap),
      h('div', { class: 'row-2' }, f.user.wrap, f.password.wrap),
      f.from.wrap,
      status,
      formError,
    ),
    h('div', { class: 'dialog-foot' },
      testBtn,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      saveBtn,
    ),
  );
  const dialog = h('dialog', { class: 'dialog' }, form);
  showDialog(dialog);
  inputs.instanceId.focus();
}

// ---------- logs ----------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

function openLogs(p, refresh) {
  const pre = h('pre', { class: 'log', tabindex: 0 });
  const statusText = h('span', { class: 'status-text' });
  const status = h('span', { class: 'log-status' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), statusText);
  const controls = processControls(p.id, {
    onBusy: (label) => label && (statusText.textContent = `${label}…`),
    // Poll right away so Pasu's "stopped"/"started" lines show up promptly.
    after: () => Promise.all([refresh(), poll()]),
  });
  const showStatus = (view) => {
    status.dataset.status = view.status;
    controls.update(view);
    if (!controls.isBusy()) statusText.textContent = STATUS_LABEL[view.status] ?? view.status;
  };
  showStatus(p);
  const follow = h('input', { type: 'checkbox', checked: true });
  const state = h('span', { class: 'muted small' });
  let offset;
  let timer = null;
  let open = true;

  const atBottom = () => pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
  pre.addEventListener('scroll', () => {
    follow.checked = atBottom();
  });

  // Lines Pasu itself wrote ("[pasu <time>] ...") are styled apart from process output.
  let atLineStart = true;
  let lineCount = 0;
  const append = (text, reset) => {
    if (reset) {
      pre.replaceChildren();
      atLineStart = true;
      lineCount = 0;
    }
    const clean = text.replace(ANSI_RE, '').replace(/\r(?!\n)/g, '\n');
    const frag = document.createDocumentFragment();
    for (const part of clean.split(/(?<=\n)/)) {
      if (!part) continue;
      frag.append(atLineStart && part.startsWith('[pasu ') ? h('span', { class: 'log-sys' }, part) : document.createTextNode(part));
      atLineStart = part.endsWith('\n');
      if (atLineStart) lineCount++;
    }
    pre.append(frag);
    // Keep the DOM bounded on chatty processes.
    while (lineCount > LOG_MAX_LINES && pre.firstChild) {
      if (pre.firstChild.textContent.endsWith('\n')) lineCount--;
      pre.firstChild.remove();
    }
    if (follow.checked && clean) pre.scrollTop = pre.scrollHeight;
    pre.classList.toggle('log-empty', !pre.firstChild);
  };

  let polling = false;
  const poll = async () => {
    if (!open || polling) return;
    polling = true;
    clearTimeout(timer);
    try {
      const q = offset == null ? '' : `?offset=${offset}`;
      const [r, view] = await Promise.all([api('GET', `api/processes/${p.id}/logs${q}`), api('GET', `api/processes/${p.id}`)]);
      append(r.text, r.reset);
      offset = r.offset;
      showStatus(view);
      state.textContent = 'Live';
    } catch (err) {
      state.textContent = err.message;
    } finally {
      polling = false;
    }
    if (open) timer = setTimeout(poll, LOG_POLL_MS);
  };

  const dialog = h('dialog', { class: 'dialog dialog-logs' },
    h('div', { class: 'dialog-head' },
      h('h2', {}, `${p.name} `, h('span', { class: 'muted' }, 'logs')),
      status,
      h('span', { class: 'log-actions' }, controls.toggleBtn, controls.restartBtn),
      h('span', { class: 'log-tools' },
        state,
        h('label', { class: 'follow' }, follow, ' Follow'),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => dialog.close() }, 'Close'),
      ),
    ),
    pre,
  );
  follow.addEventListener('change', () => follow.checked && (pre.scrollTop = pre.scrollHeight));
  dialog.addEventListener('close', () => {
    open = false;
    clearTimeout(timer);
  });
  showDialog(dialog);
  poll();
}

// ---------- resources ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Round `max` up to a top value with 4 even steps (1/2/2.5/5 × 10^n, in units of `base`^n). */
function niceScale(max, base = 10) {
  const unit = base === 1024 ? 1024 ** Math.max(0, Math.floor(Math.log(max) / Math.log(1024))) : 1;
  const raw = max / unit / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) * unit;
  return { step, top: step * 4 };
}

const timeOfDay = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Line chart of one value over the sampling window, with a hover crosshair. */
function timeChart({ title, index, format, axis = format, floor, base }) {
  const svg = s('svg', { class: 'chart-svg', role: 'img', 'aria-label': `${title} over time` });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const plot = h('div', { class: 'chart-plot' }, svg, tip);
  const el = h('section', { class: 'chart' }, h('h3', { class: 'chart-title' }, title), plot);
  const H = 150;
  const M = { top: 10, right: 12, bottom: 22, left: 52 };
  let last = null;
  let geom = null;
  let hoverX = null; // pointer position over the plot, kept across re-renders

  const render = (data = last) => {
    last = data;
    const W = plot.clientWidth;
    if (!data || !W) return;
    const { history, intervalMs, historyMs, now } = data;
    const t0 = now - historyMs;
    const pts = history.map((r) => [r[0], r[index]]);
    const values = pts.map((p) => p[1]).filter((v) => v != null);
    const { step, top } = niceScale(Math.max(floor, ...values) * 1.1, base);
    const x = (t) => M.left + ((t - t0) / historyMs) * (W - M.left - M.right);
    const y = (v) => M.top + (1 - v / top) * (H - M.top - M.bottom);
    geom = { pts, x, y };

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    const nodes = [];
    for (let v = 0; v <= top + step / 2; v += step) {
      nodes.push(s('line', { class: v ? 'chart-grid' : 'chart-axis', x1: M.left, x2: W - M.right, y1: y(v), y2: y(v) }));
      const label = s('text', { class: 'chart-label', x: M.left - 8, y: y(v) + 4, 'text-anchor': 'end' });
      label.textContent = axis(v);
      nodes.push(label);
    }
    // Time labels every 5 minutes, skipping any that would collide with the previous one on narrow screens.
    const minutes = historyMs / 60_000;
    const ticks = [];
    for (let m = minutes; m >= 0; m -= 5) {
      const text = m ? `${m} min ago` : 'now';
      const width = text.length * 6.2;
      const anchor = m === minutes ? 'start' : m ? 'middle' : 'end';
      const left = x(now - m * 60_000) - { start: 0, middle: width / 2, end: width }[anchor];
      ticks.push({ m, text, anchor, left, right: left + width });
    }
    const end = ticks.at(-1);
    let prevRight = -Infinity;
    for (const t of ticks) {
      // The first and last labels always show; the ones between only where they fit.
      if (t !== end && t !== ticks[0] && (t.left < prevRight + 12 || t.right > end.left - 12)) continue;
      prevRight = t.right;
      const label = s('text', { class: 'chart-label', x: x(now - t.m * 60_000), y: H - 5, 'text-anchor': t.anchor });
      label.textContent = t.text;
      nodes.push(label);
    }

    // Break the line wherever the process wasn't running or samples are missing.
    const segments = [];
    let seg = [];
    let prevT = null;
    for (const [t, v] of pts) {
      if (v == null || (prevT != null && t - prevT > intervalMs * 2.5)) {
        if (seg.length) segments.push(seg);
        seg = [];
      }
      if (v != null) seg.push([x(t), y(v)]);
      prevT = t;
    }
    if (seg.length) segments.push(seg);
    for (const sg of segments) {
      const line = sg.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
      if (sg.length === 1) {
        nodes.push(s('circle', { class: 'chart-point', cx: sg[0][0], cy: sg[0][1], r: 3 }));
        continue;
      }
      nodes.push(s('path', { class: 'chart-area', d: `${line}L${sg.at(-1)[0].toFixed(1)},${y(0)}L${sg[0][0].toFixed(1)},${y(0)}Z` }));
      nodes.push(s('path', { class: 'chart-line', d: line }));
    }
    if (!values.length) {
      const empty = s('text', { class: 'chart-label', x: (M.left + W - M.right) / 2, y: (H - M.bottom) / 2 + 4, 'text-anchor': 'middle' });
      empty.textContent = 'No samples yet';
      nodes.push(empty);
    }
    nodes.push(s('line', { class: 'chart-cross', y1: M.top, y2: y(0), visibility: 'hidden' }));
    nodes.push(s('circle', { class: 'chart-hover', r: 4, visibility: 'hidden' }));
    svg.replaceChildren(...nodes);
    showHover();
  };

  const hide = () => {
    tip.hidden = true;
    svg.querySelectorAll('.chart-cross, .chart-hover').forEach((n) => n.setAttribute('visibility', 'hidden'));
  };
  const showHover = () => {
    if (!geom || hoverX == null) return hide();
    let best = null;
    for (const p of geom.pts) {
      if (p[1] == null) continue;
      const d = Math.abs(geom.x(p[0]) - hoverX);
      if (!best || d < best.d) best = { d, p };
    }
    if (!best || best.d > 24) return hide();
    const [t, v] = best.p;
    const cx = geom.x(t);
    const cross = svg.querySelector('.chart-cross');
    const dot = svg.querySelector('.chart-hover');
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', cx);
    dot.setAttribute('cy', geom.y(v));
    dot.setAttribute('visibility', 'visible');
    tip.replaceChildren(h('strong', {}, format(v)), h('span', { class: 'muted' }, timeOfDay(t)));
    tip.hidden = false;
    // Keep the tooltip inside the plot.
    const left = Math.min(Math.max(cx - tip.offsetWidth / 2, 0), plot.clientWidth - tip.offsetWidth);
    tip.style.left = `${left}px`;
  };
  plot.addEventListener('pointermove', (e) => {
    hoverX = e.clientX - plot.getBoundingClientRect().left;
    showHover();
  });
  plot.addEventListener('pointerleave', () => {
    hoverX = null;
    hide();
  });
  new ResizeObserver(() => render()).observe(plot);

  return { el, render };
}

function openResources(p, refresh) {
  const statusText = h('span', { class: 'status-text' });
  const status = h('span', { class: 'log-status' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), statusText);
  const controls = processControls(p.id, {
    onBusy: (label) => label && (statusText.textContent = `${label}…`),
    after: () => Promise.all([refresh(), poll()]),
  });
  const showStatus = (view) => {
    status.dataset.status = view.status;
    controls.update(view);
    if (!controls.isBusy()) statusText.textContent = STATUS_LABEL[view.status] ?? view.status;
  };
  showStatus(p);
  const state = h('span', { class: 'muted small' });

  const tile = (label) => {
    const value = h('div', { class: 'tile-value' }, '–');
    const sub = h('div', { class: 'tile-sub muted' });
    return { el: h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, label), value, sub), value, sub };
  };
  const cpuTile = tile('CPU');
  const memTile = tile('Memory');
  const procTile = tile('Processes');
  const cpuChart = timeChart({ title: 'CPU', index: 1, format: fmtCpu, axis: (v) => `${+v.toFixed(1)}%`, floor: 10 });
  const memChart = timeChart({ title: 'Memory', index: 2, format: fmtBytes, axis: (v) => fmtBytes(v).replace('.0 ', ' '), floor: 16 * 1024 * 1024, base: 1024 });
  const note = h('p', { class: 'muted small res-note' });
  const tbody = h('tbody');
  const tableWrap = h('div', { class: 'res-table-wrap' },
    h('table', { class: 'res-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'PID'), h('th', {}, 'Command'), h('th', { class: 'num' }, 'CPU'), h('th', { class: 'num' }, 'Memory'), h('th', { class: 'num col-threads' }, 'Threads'))),
      tbody,
    ),
  );
  const members = h('section', {}, h('h3', { class: 'chart-title' }, 'Processes'), tableWrap);

  const show = (r) => {
    const c = r.current;
    const peak = (i) => Math.max(...r.history.map((row) => row[i] ?? 0), 0);
    const minutes = Math.round(r.historyMs / 60_000);
    cpuTile.value.textContent = c ? fmtCpu(c.cpu) : '–';
    cpuTile.sub.textContent = c ? `peak ${fmtCpu(peak(1))} · ${r.cpus} cores = ${r.cpus * 100}%` : 'Not running';
    memTile.value.textContent = c ? fmtBytes(c.rss) : '–';
    memTile.sub.textContent = c ? `peak ${fmtBytes(peak(2))} · ${((c.rss / r.totalMemory) * 100).toFixed(1)}% of ${fmtBytes(r.totalMemory)}` : 'Not running';
    procTile.value.textContent = c ? String(c.processes) : '–';
    procTile.sub.textContent = c ? `${c.threads} threads` : 'Not running';
    note.textContent = `Peaks cover the last ${minutes} minutes. Sampled every ${r.intervalMs / 1000}s; memory is resident memory (RSS) summed over the process and its children, and 100% CPU is one core.`;

    const data = { history: r.history, intervalMs: r.intervalMs, historyMs: r.historyMs, now: c?.at ?? Date.now() };
    cpuChart.render(data);
    memChart.render(data);

    tbody.replaceChildren(...(c?.members ?? []).map((m) => h('tr', {},
      h('td', { class: 'mono' }, String(m.pid)),
      h('td', { class: 'res-cmd mono', title: m.command || m.name }, m.command || `[${m.name}]`),
      h('td', { class: 'num' }, fmtCpu(m.cpu)),
      h('td', { class: 'num' }, fmtBytes(m.rss)),
      h('td', { class: 'num col-threads' }, String(m.threads)),
    )));
    members.hidden = !c;
  };

  let timer = null;
  let open = true;
  let polling = false;
  let interval = POLL_MS;
  const poll = async () => {
    if (!open || polling) return;
    polling = true;
    clearTimeout(timer);
    try {
      const [r, view] = await Promise.all([api('GET', `api/processes/${p.id}/resources`), api('GET', `api/processes/${p.id}`)]);
      interval = r.intervalMs;
      show(r);
      showStatus(view);
      state.textContent = 'Live';
    } catch (err) {
      state.textContent = err.message;
    } finally {
      polling = false;
    }
    if (open) timer = setTimeout(poll, interval);
  };

  const dialog = h('dialog', { class: 'dialog dialog-logs dialog-resources' },
    h('div', { class: 'dialog-head' },
      h('h2', {}, `${p.name} `, h('span', { class: 'muted' }, 'resources')),
      status,
      h('span', { class: 'log-actions' }, controls.toggleBtn, controls.restartBtn),
      h('span', { class: 'log-tools' },
        state,
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => dialog.close() }, 'Close'),
      ),
    ),
    h('div', { class: 'dialog-body res-body' },
      h('div', { class: 'tiles' }, cpuTile.el, memTile.el, procTile.el),
      cpuChart.el,
      memChart.el,
      members,
      note,
    ),
  );
  dialog.addEventListener('close', () => {
    open = false;
    clearTimeout(timer);
  });
  showDialog(dialog);
  poll();
}

window.addEventListener('hashchange', () => setupToken() && boot());
boot();
