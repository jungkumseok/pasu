import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { ensureDir, readJson, writeJson, removeFile } from './fsutil.js';
import * as store from './store.js';
import * as procfs from './procfs.js';
import * as logs from './logs.js';
import { ResourceMonitor } from './resources.js';

const SHELL = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESOURCE_EVERY_TICKS = 2;

export class NotFoundError extends Error {}

/** Hash of the spec fields that only take effect on (re)start. */
function launchHash(spec) {
  const env = Object.keys(spec.env).sort().map((k) => [k, spec.env[k]]);
  return crypto.createHash('sha256').update(JSON.stringify([spec.command, spec.cwd, env])).digest('hex').slice(0, 16);
}

function runPath(id) {
  return path.join(config.runDir, `${id}.json`);
}

const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

function describeExit({ code, signal }) {
  if (signal) return `killed by ${signal}`;
  if (code == null) return 'exited';
  return `exited with code ${code}`;
}

/**
 * Supervises registered processes.
 *
 * Processes are spawned detached (own session + process group) with output going
 * directly to a log file, so they survive Pasu restarting. Their identity
 * (pid + kernel start time) is persisted in data/run/<id>.json and re-adopted on
 * startup. Processes started by this Pasu instance report exit via the child
 * handle; adopted ones are detected by polling /proc.
 *
 * Status values: running | stopping | stopped | backoff (crashed, restart pending) | failed
 */
export class Supervisor {
  /** `onFailure(id, event)` is called when a process fails; see _reportFailure. */
  constructor({ onFailure = () => {} } = {}) {
    this.onFailure = onFailure;
    this.procs = new Map();
    this.tickCount = 0;
    this.resources = new ResourceMonitor({ intervalMs: config.pollIntervalMs * RESOURCE_EVERY_TICKS });
  }

  _state(id) {
    let st = this.procs.get(id);
    if (!st) {
      st = {
        status: 'stopped',
        pid: null,
        procStart: null,
        startedAt: null,
        specHash: null,
        held: false, // user stopped it explicitly; don't auto-restart until started again
        child: null,
        expectingExit: false,
        lastExit: null,
        crashCount: 0,
        restartTimer: null,
        nextRestartAt: null,
        error: null,
        lock: Promise.resolve(),
      };
      this.procs.set(id, st);
    }
    return st;
  }

  /** Serialize lifecycle operations per process so start/stop can't interleave. */
  _locked(id, fn) {
    const st = this._state(id);
    const run = st.lock.then(fn);
    st.lock = run.catch(() => {});
    return run;
  }

  _persist(id) {
    const st = this._state(id);
    writeJson(runPath(id), {
      pid: st.pid,
      procStart: st.procStart,
      startedAt: st.startedAt,
      specHash: st.specHash,
      held: st.held,
      lastExit: st.lastExit,
      bootId: procfs.bootId(),
    });
  }

  init() {
    for (const dir of [config.processesDir, config.runDir, config.logsDir]) ensureDir(dir);
    const specs = store.listSpecs();
    const known = new Set(specs.map((s) => s.id));

    // Drop run files of processes that no longer exist.
    for (const f of fs.readdirSync(config.runDir)) {
      const id = f.replace(/\.json$/, '');
      if (!known.has(id)) removeFile(path.join(config.runDir, f));
    }

    for (const spec of specs) {
      const st = this._state(spec.id);
      const saved = readJson(runPath(spec.id), {}) ?? {};
      st.held = Boolean(saved.held);
      st.lastExit = saved.lastExit ?? null;
      if (saved.pid && procfs.isRunning(saved.pid, saved.procStart)) {
        Object.assign(st, {
          status: 'running',
          pid: saved.pid,
          procStart: saved.procStart,
          startedAt: saved.startedAt,
          specHash: saved.specHash,
        });
        console.log(`[supervisor] adopted ${spec.id} (pid ${saved.pid})`);
      } else if (saved.pid) {
        st.lastExit = { code: null, signal: null, at: new Date().toISOString(), note: 'exited while Pasu was down' };
        logs.writeMarker(spec.id, 'process exited while Pasu was not running');
        // After a reboot every process is gone; that's not a failure worth an email each.
        const rebooted = saved.bootId !== procfs.bootId();
        if (!rebooted) this._reportFailure(spec.id, {
          kind: 'down',
          description: 'It exited while Pasu was not running',
          next: spec.autostart && !st.held ? 'Pasu is starting it again.' : 'Keep running is off, so it stays stopped.',
        });
      }
      this._persist(spec.id);
    }

    for (const spec of specs) {
      const st = this._state(spec.id);
      if (spec.autostart && !st.held && !st.pid) {
        this.start(spec.id, { auto: true }).catch((err) => console.error(`[supervisor] autostart ${spec.id}: ${err.message}`));
      }
    }

    this.timer = setInterval(() => this._tick(), config.pollIntervalMs);
  }

  _tick() {
    this.tickCount++;
    for (const [id, st] of this.procs) {
      // Children we spawned report exit through their handle; adopted ones are polled.
      if (st.pid && !st.child && !procfs.isRunning(st.pid, st.procStart)) {
        this._handleExit(id, st.pid, { code: null, signal: null });
      }
      if (this.tickCount % 10 === 0) logs.rotateIfNeeded(id);
    }
    if (this.tickCount % RESOURCE_EVERY_TICKS === 0) {
      this.resources.sample(new Map([...this.procs].map(([id, st]) => [id, st.pid])));
    }
  }

  async _spawn(spec) {
    const st = this._state(spec.id);
    const fd = logs.openLog(spec.id);
    let child;
    try {
      logs.writeMarker(spec.id, `starting: ${spec.command}  (cwd ${spec.cwd})`, fd);
      child = spawn(SHELL, ['-c', spec.command], {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } finally {
      fs.closeSync(fd);
    }
    child.on('error', (err) => console.error(`[supervisor] ${spec.id}: ${err.message}`));
    child.unref();

    const pid = child.pid;
    Object.assign(st, {
      status: 'running',
      pid,
      procStart: procfs.readStat(pid)?.startTime ?? null,
      startedAt: new Date().toISOString(),
      specHash: launchHash(spec),
      child,
      error: null,
    });
    child.on('exit', (code, signal) => this._handleExit(spec.id, pid, { code, signal }));
    this._persist(spec.id);
    logs.writeMarker(spec.id, `started pid ${pid}`);
  }

  _handleExit(id, pid, { code, signal }) {
    const st = this.procs.get(id);
    if (!st || st.pid !== pid) return; // already handled, or a stale event

    const uptimeMs = Date.now() - new Date(st.startedAt).getTime();
    const procStart = st.procStart;
    st.lastExit = { code, signal, at: new Date().toISOString(), uptimeMs };
    Object.assign(st, { pid: null, procStart: null, child: null, startedAt: null, specHash: null });
    logs.writeMarker(id, `process ${describeExit(st.lastExit)} after ${Math.round(uptimeMs / 1000)}s`);

    if (st.expectingExit) {
      st.expectingExit = false;
      st.status = 'stopped';
      this._persist(id);
      return;
    }

    // Unexpected exit: clean up anything the process left behind in its group.
    const spec = store.getSpec(id);
    this._reapGroup(pid, procStart, spec?.stopTimeoutSec ?? config.defaultStopTimeoutSec);

    if (spec?.autostart && !st.held) this._scheduleRestart(id, uptimeMs);
    else st.status = 'stopped';
    this._persist(id);
    // A one-off command finishing successfully isn't a failure; anything else that exits unasked is.
    if (code !== 0 || spec?.autostart) {
      this._reportFailure(id, { kind: 'crash', description: capitalize(describeExit(st.lastExit)), uptimeMs, next: this._nextStep(st) });
    }
  }

  _nextStep(st) {
    if (st.status !== 'backoff') return 'Keep running is off, so it stays stopped.';
    const delay = Math.max(0, new Date(st.nextRestartAt).getTime() - Date.now());
    return `Restarting in ${Math.round(delay / 1000)}s (attempt ${st.crashCount}).`;
  }

  _reportFailure(id, event) {
    try {
      this.onFailure(id, { at: new Date().toISOString(), ...event });
    } catch (err) {
      console.error(`[supervisor] failure hook for ${id}: ${err.message}`);
    }
  }

  /** Signal the whole process group, unless the pid has since been reused by another process. */
  _signalGroup(pgid, procStart, signal) {
    if (procfs.isRecycled(pgid, procStart)) return;
    try {
      process.kill(-pgid, signal);
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
    }
  }

  async _reapGroup(pgid, procStart, timeoutSec) {
    if (!procfs.groupAlive(pgid)) return;
    this._signalGroup(pgid, procStart, 'SIGTERM');
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline && procfs.groupAlive(pgid)) await sleep(200);
    if (procfs.groupAlive(pgid)) this._signalGroup(pgid, procStart, 'SIGKILL');
  }

  _scheduleRestart(id, uptimeMs) {
    const st = this._state(id);
    const { initialMs, maxMs, stableAfterMs } = config.backoff;
    st.crashCount = uptimeMs >= stableAfterMs ? 1 : st.crashCount + 1;
    const delay = Math.min(initialMs * 2 ** (st.crashCount - 1), maxMs);
    st.status = 'backoff';
    st.nextRestartAt = new Date(Date.now() + delay).toISOString();
    logs.writeMarker(id, `restarting in ${delay / 1000}s (attempt ${st.crashCount})`);
    st.restartTimer = setTimeout(() => {
      st.restartTimer = null;
      this.start(id, { auto: true }).catch((err) => console.error(`[supervisor] restart ${id}: ${err.message}`));
    }, delay);
  }

  _cancelRestart(st) {
    if (st.restartTimer) clearTimeout(st.restartTimer);
    st.restartTimer = null;
    st.nextRestartAt = null;
  }

  start(id, { auto = false } = {}) {
    return this._locked(id, () => this._start(id, { auto }));
  }

  async _start(id, { auto }) {
    const spec = store.getSpec(id);
    if (!spec) throw new NotFoundError(`no such process: ${id}`);
    const st = this._state(id);
    if (st.pid) return;
    if (auto && st.held) return;
    this._cancelRestart(st);
    if (!auto) {
      st.held = false;
      st.crashCount = 0;
    }
    try {
      await this._spawn(spec);
    } catch (err) {
      st.error = `Failed to start: ${err.message}`;
      st.lastExit = { code: null, signal: null, at: new Date().toISOString(), error: err.message };
      logs.writeMarker(id, st.error);
      if (spec.autostart && !st.held) this._scheduleRestart(id, 0);
      else st.status = 'failed';
      this._persist(id);
      // A manual start reports its error in the UI instead.
      if (auto) this._reportFailure(id, { kind: 'start-failed', description: st.error, next: this._nextStep(st) });
      if (!auto) throw new Error(st.error);
    }
  }

  stop(id, { hold = true } = {}) {
    return this._locked(id, () => this._stop(id, { hold }));
  }

  async _stop(id, { hold }) {
    const st = this._state(id);
    this._cancelRestart(st);
    if (hold) st.held = true;
    st.crashCount = 0;
    if (!st.pid) {
      st.status = 'stopped';
      st.error = null;
      this._persist(id);
      return;
    }

    const spec = store.getSpec(id);
    const signal = spec?.stopSignal ?? 'SIGTERM';
    const timeoutSec = spec?.stopTimeoutSec ?? config.defaultStopTimeoutSec;
    const { pid, procStart } = st;
    st.expectingExit = true;
    st.status = 'stopping';
    logs.writeMarker(id, `stopping (${signal})`);
    this._signalGroup(pid, procStart, signal);

    // Wait for the leader and everything in its group to go away.
    const waitGone = async (ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (st.pid === pid && !st.child && !procfs.isRunning(pid, procStart)) {
          this._handleExit(id, pid, { code: null, signal: null });
        }
        if (st.pid !== pid && !procfs.groupAlive(pid)) return true;
        await sleep(100);
      }
      return false;
    };

    if (!(await waitGone(timeoutSec * 1000))) {
      logs.writeMarker(id, `did not exit within ${timeoutSec}s, sending SIGKILL`);
      this._signalGroup(pid, procStart, 'SIGKILL');
      if (!(await waitGone(5000)) && st.pid === pid) {
        st.expectingExit = false;
        st.status = 'running';
        st.error = 'Process did not exit after SIGKILL';
        throw new Error(st.error);
      }
    }
    st.error = null;
    this._persist(id);
  }

  restart(id) {
    return this._locked(id, async () => {
      if (!store.getSpec(id)) throw new NotFoundError(`no such process: ${id}`);
      await this._stop(id, { hold: false });
      await this._start(id, { auto: false });
    });
  }

  async create(input) {
    const spec = store.createSpec(input);
    this._persist(spec.id);
    if (spec.autostart) await this.start(spec.id).catch(() => {});
    return this.view(spec.id);
  }

  async update(id, input) {
    const before = store.getSpec(id);
    if (!before) throw new NotFoundError(`no such process: ${id}`);
    const spec = store.updateSpec(id, input);
    const st = this._state(id);
    if (spec.autostart && !before.autostart && !st.pid) {
      await this.start(id).catch(() => {});
    } else if (!spec.autostart && st.status === 'backoff') {
      this._cancelRestart(st);
      st.status = 'stopped';
    }
    return this.view(id);
  }

  remove(id) {
    return this._locked(id, async () => {
      if (!store.getSpec(id)) throw new NotFoundError(`no such process: ${id}`);
      await this._stop(id, { hold: true });
      store.deleteSpec(id);
      removeFile(runPath(id));
      logs.removeLogs(id);
      this.procs.delete(id);
    });
  }

  view(id, spec = store.getSpec(id)) {
    if (!spec) return null;
    const st = this._state(id);
    return {
      ...spec,
      status: st.status,
      pid: st.pid,
      startedAt: st.startedAt,
      held: st.held,
      lastExit: st.lastExit,
      crashCount: st.crashCount,
      nextRestartAt: st.nextRestartAt,
      error: st.error,
      usage: st.pid ? this.resources.summary(id, st.pid) : null,
      // Command/cwd/env changed since this instance was launched.
      needsRestart: Boolean(st.pid && st.specHash && st.specHash !== launchHash(spec)),
    };
  }

  resourceDetail(id) {
    const st = this._state(id);
    return this.resources.detail(id, st.pid);
  }

  list() {
    return store.listSpecs().map((spec) => this.view(spec.id, spec));
  }
}
