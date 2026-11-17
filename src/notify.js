import os from 'node:os';
import nodemailer from 'nodemailer';
import { config } from './config.js';
import * as logs from './logs.js';
import * as store from './store.js';
import { instanceId, isLoopback, loadSettings } from './settings.js';
import { publicIp } from './hostinfo.js';

// Failure emails. The first failure of a process is emailed right away; further failures
// within the cooldown are counted and sent as one summary when it ends, so a crash loop
// produces at most one email per cooldown instead of one per restart.

const COOLDOWN_MS = 10 * 60_000;
const LOG_LINES = 40;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

const when = (iso) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'long' });

function logTail(id) {
  const lines = logs.readLog(id).text.replace(ANSI_RE, '').replace(/\r(?!\n)/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-LOG_LINES).join('\n');
}

export async function sendMail(email, { subject, text, html }) {
  const transport = nodemailer.createTransport({
    host: email.host,
    port: email.port,
    secure: email.port === 465,
    // Never send the password (or the mail) in clear text, except to a relay on this machine.
    requireTLS: email.port !== 465 && !isLoopback(email.host),
    auth: email.user ? { user: email.user, pass: email.password } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  try {
    const address = email.from || (email.user.includes('@') ? email.user : email.to);
    await transport.sendMail({ from: { name: config.name, address }, to: email.to, subject, text, html });
  } finally {
    transport.close();
  }
}

// ---------- message ----------

const C = {
  bg: '#f4f5f7', card: '#ffffff', border: '#e3e6ea', text: '#16191d', muted: '#646d78',
  bad: '#b91c1c', badBg: '#fdecec', warnFg: '#8a4b05', warnBg: '#fdf3d8', accent: '#0f766e',
  logBg: '#111418', logFg: '#d6dde4', mono: "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace",
};

/** Which Pasu, on which machine: shown in every email. */
export function serverInfo() {
  return { id: instanceId(), hostname: os.hostname(), ip: publicIp() };
}

const serverLine = (server) => `${server.hostname}${server.ip ? ` (${server.ip})` : ''}`;

function layout({ preheader, body, server }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(preheader)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};">
<div style="display:none;max-height:0;overflow:hidden;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.text};">
<tr><td style="padding:0 4px 12px;font-size:13px;color:${C.muted};"><strong style="color:${C.accent};">Pasu</strong> &middot; ${esc(server.id)}</td></tr>
<tr><td style="background:${C.card};border:1px solid ${C.border};border-radius:12px;padding:24px;">${body}</td></tr>
<tr><td style="padding:14px 4px 0;font-size:12px;line-height:1.5;color:${C.muted};">${config.publicUrl ? `<a href="${esc(config.publicUrl.origin + config.publicUrl.path + '/')}" style="color:${C.muted};">${esc(config.publicUrl.origin + config.publicUrl.path)}</a><br>` : ''}You get these emails because email notifications are on in Pasu's settings. To stop them for one process, turn off <em>Email notifications</em> in its settings.</td></tr>
</table></td></tr></table></body></html>`;
}

function row(label, value, { mono = false } = {}) {
  return `<tr><td valign="top" style="padding:6px 16px 6px 0;font-size:13px;color:${C.muted};white-space:nowrap;">${esc(label)}</td>
<td style="padding:6px 0;font-size:14px;word-break:break-word;${mono ? `font-family:${C.mono};font-size:13px;` : ''}">${esc(value)}</td></tr>`;
}

const TITLES = { crash: 'crashed', 'start-failed': 'failed to start', down: 'stopped while Pasu was down' };

/**
 * Subject, plain text and HTML for a failure. `count` > 1 makes it a summary of the
 * failures held back by the cooldown, showing the details of the latest one.
 */
export function failureMessage(spec, ev, { server, count = 1, cooldownMs = COOLDOWN_MS }) {
  const summary = count > 1;
  const title = summary ? `is still failing (${count} failures)` : TITLES[ev.kind] ?? 'failed';
  const subject = `[${server.id}] ${spec.name} ${title}`;
  const facts = [
    ['Pasu ID', server.id],
    ['Server', serverLine(server)],
    ['When', when(ev.at)],
    ev.uptimeMs != null && ['Uptime', `${duration(ev.uptimeMs)} before it stopped`],
    ['Command', spec.command, true],
    ['Directory', spec.cwd, true],
  ].filter(Boolean);
  const minutes = Math.round(cooldownMs / 60_000);
  const moreNote = summary
    ? `It failed ${count} times since the last email. Pasu sends at most one email per process every ${minutes} minutes, so these are grouped; the details below are from the latest failure.`
    : '';

  const html = layout({
    server,
    preheader: `${spec.name}: ${ev.description}. ${ev.next}`,
    body: `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:6px;"><tr><td style="background:${C.badBg};color:${C.bad};font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 10px;border-radius:999px;">${summary ? 'Still failing' : 'Failed'}</td></tr></table>
<h1 style="margin:8px 0 4px;font-size:22px;line-height:1.3;">${esc(spec.name)} ${esc(title)}</h1>
<p style="margin:0 0 18px;font-size:15px;color:${C.muted};">${esc(ev.description)}. ${esc(ev.next)}</p>
${moreNote ? `<p style="margin:0 0 18px;padding:10px 14px;background:${C.warnBg};color:${C.warnFg};border-radius:8px;font-size:13px;line-height:1.5;">${esc(moreNote)}</p>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" style="border-top:1px solid ${C.border};padding-top:8px;margin-bottom:18px;width:100%;">
${facts.map(([l, v, mono]) => row(l, v, { mono })).join('\n')}
</table>
<p style="margin:0 0 8px;font-size:13px;font-weight:600;">Last ${LOG_LINES} lines of output</p>
<pre style="margin:0;padding:14px 16px;background:${C.logBg};color:${C.logFg};border-radius:8px;font-family:${C.mono};font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;">${esc(ev.logTail || '(no output)')}</pre>`,
  });

  const text = [
    `${spec.name} ${title}`,
    '',
    `${ev.description}. ${ev.next}`,
    ...(moreNote ? ['', moreNote] : []),
    '',
    ...facts.map(([l, v]) => `${l}: ${v}`),
    '',
    `Last ${LOG_LINES} lines of output:`,
    ev.logTail || '(no output)',
    '',
    `-- Pasu · ${server.id}`,
  ].join('\n');
  return { subject, text, html };
}

export function testMessage(email, server) {
  const subject = `[${server.id}] Test email`;
  const html = layout({
    server,
    preheader: 'Email notifications are working.',
    body: `<h1 style="margin:0 0 8px;font-size:22px;">Email notifications are working</h1>
<p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:${C.muted};">This test was sent through ${esc(email.host)}:${email.port}. When a process fails, Pasu will email ${esc(email.to)} with what happened and its last lines of output.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-top:1px solid ${C.border};padding-top:8px;width:100%;">
${row('Pasu ID', server.id)}
${row('Server', serverLine(server))}
</table>`,
  });
  const text = `Email notifications are working.\n\nThis test was sent through ${email.host}:${email.port}. When a process fails, Pasu will email ${email.to}.\n\nPasu ID: ${server.id}\nServer: ${serverLine(server)}`;
  return { subject, text, html };
}

// ---------- notifier ----------

export class Notifier {
  constructor({ cooldownMs = COOLDOWN_MS, send = sendMail, server = serverInfo } = {}) {
    this.cooldownMs = cooldownMs;
    this.send = send;
    this.server = server;
    this.procs = new Map(); // id -> { lastSentAt, held, latest, timer }
    this.lastSent = null;
    this.lastError = null;
  }

  /** Delivery status for the settings screen. */
  status() {
    return { lastSent: this.lastSent, lastError: this.lastError };
  }

  _settingsFor(id) {
    const { email } = loadSettings();
    const spec = store.getSpec(id);
    return email.enabled && spec && spec.notify !== false ? { email, spec } : null;
  }

  /** Called by the supervisor. `ev`: { kind, at, description, uptimeMs?, next }. */
  processFailed(id, ev) {
    let target;
    try {
      target = this._settingsFor(id);
      if (!target) return;
      ev = { ...ev, logTail: logTail(id) };
    } catch (err) {
      console.error(`[notify] ${id}: ${err.message}`);
      return;
    }
    const st = this.procs.get(id) ?? { lastSentAt: 0, held: 0, latest: null, timer: null };
    this.procs.set(id, st);
    const wait = st.lastSentAt + this.cooldownMs - Date.now();
    if (wait > 0) {
      st.held++;
      st.latest = ev;
      st.timer ??= setTimeout(() => this._flush(id), wait);
      st.timer.unref?.();
      return;
    }
    this._deliver(st, target, ev, 1);
  }

  _flush(id) {
    const st = this.procs.get(id);
    if (!st) return;
    st.timer = null;
    const { held, latest } = st;
    st.held = 0;
    st.latest = null;
    const target = held ? this._settingsFor(id) : null;
    if (target) this._deliver(st, target, latest, held);
  }

  _deliver(st, { email, spec }, ev, count) {
    st.lastSentAt = Date.now();
    const message = failureMessage(spec, ev, { server: this.server(), count, cooldownMs: this.cooldownMs });
    this.send(email, message).then(
      () => {
        this.lastSent = { at: new Date().toISOString(), to: email.to, subject: message.subject };
        console.log(`[notify] emailed ${email.to}: ${message.subject}`);
      },
      (err) => {
        this.lastError = { at: new Date().toISOString(), message: err.message };
        console.error(`[notify] could not email ${email.to} about ${spec.id}: ${err.message}`);
      },
    );
  }

  /** `id` overrides the saved Pasu ID, so the form's value can be tried before saving. */
  async sendTest(email, { id } = {}) {
    try {
      const server = this.server();
      await this.send(email, testMessage(email, { ...server, id: id || server.id }));
      this.lastSent = { at: new Date().toISOString(), to: email.to, subject: 'Test email' };
      this.lastError = null;
    } catch (err) {
      this.lastError = { at: new Date().toISOString(), message: err.message };
      throw err;
    }
  }
}
