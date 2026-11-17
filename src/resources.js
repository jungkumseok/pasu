import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

// Resource usage of managed processes, sampled from /proc.
//
// A managed process runs in its own session, so everything it spawns (a shell,
// npm, the node it starts, workers) shares its session id. Usage is the sum over
// that session. CPU counts each process's own time plus that of children it has
// already reaped (cutime/cstime), so the total doesn't drop when a short-lived
// child exits between samples.

function getconf(name, fallback) {
  try {
    return Number(execFileSync('getconf', [name], { encoding: 'utf8' }).trim()) || fallback;
  } catch {
    return fallback;
  }
}

const CLK_TCK = getconf('CLK_TCK', 100);
const PAGE_SIZE = getconf('PAGESIZE', 4096);

/** One pass over /proc: every live process, with the fields we need. */
function scan() {
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.charCodeAt(0) < 48 || e.charCodeAt(0) > 57) continue;
    let raw;
    try {
      raw = fs.readFileSync(`/proc/${e}/stat`, 'utf8');
    } catch {
      continue; // exited since readdir
    }
    const close = raw.lastIndexOf(')');
    const f = raw.slice(close + 2).split(' ');
    if (f[0] === 'Z' || f[0] === 'X') continue;
    // Field n of /proc/<pid>/stat is f[n - 3].
    out.push({
      pid: Number(e),
      name: raw.slice(raw.indexOf('(') + 1, close),
      ppid: Number(f[1]),
      session: Number(f[3]),
      ticks: Number(f[11]) + Number(f[12]) + Number(f[13]) + Number(f[14]),
      threads: Number(f[17]),
      startTime: f[19],
      rss: Number(f[21]) * PAGE_SIZE,
    });
  }
  return out;
}

function readCmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ');
  } catch {
    return '';
  }
}

const cpuPercent = (dTicks, dMs) => (dMs > 0 ? Math.max(0, (dTicks / CLK_TCK) * 1000 / dMs) * 100 : null);

export class ResourceMonitor {
  constructor({ intervalMs = 2000, historyMs = 15 * 60_000 } = {}) {
    this.intervalMs = intervalMs;
    this.historyMs = historyMs;
    this.entries = new Map(); // id -> { pid, ticks, at, current, history: [[t, cpu, rss]] }
    this.memberTicks = new Map(); // `${pid}:${startTime}` -> ticks at the last sample
  }

  /** `targets` maps process id -> pid of the running leader (or null when not running). */
  sample(targets) {
    const now = Date.now();
    const running = [...targets].filter(([, pid]) => pid);
    const sessions = new Map();
    if (running.length) {
      for (const p of scan()) {
        if (!sessions.has(p.session)) sessions.set(p.session, []);
        sessions.get(p.session).push(p);
      }
    }
    const lastAt = this.lastAt;
    const memberTicks = new Map();

    for (const [id, pid] of targets) {
      let entry = this.entries.get(id);
      const members = pid ? sessions.get(pid) ?? [] : [];
      if (!members.length) {
        // Not running: record a gap, but only for processes that have a history to break.
        if (entry) {
          entry.pid = null;
          entry.current = null;
          entry.history.push([now, null, null]);
        }
      } else {
        if (!entry) {
          entry = { pid: null, ticks: 0, at: 0, current: null, history: [] };
          this.entries.set(id, entry);
        }
        const ticks = members.reduce((s, p) => s + p.ticks, 0);
        const rss = members.reduce((s, p) => s + p.rss, 0);
        // A restart starts a new session, so its first sample has nothing to diff against.
        const cpu = entry.pid === pid ? cpuPercent(ticks - entry.ticks, now - entry.at) : null;
        for (const p of members) {
          const key = `${p.pid}:${p.startTime}`;
          const prev = this.memberTicks.get(key);
          p.cpu = prev == null || lastAt == null ? null : cpuPercent(p.ticks - prev, now - lastAt);
          memberTicks.set(key, p.ticks);
        }
        Object.assign(entry, { pid, ticks, at: now });
        entry.current = {
          at: now,
          cpu,
          rss,
          processes: members.length,
          threads: members.reduce((s, p) => s + p.threads, 0),
          members,
        };
        entry.history.push([now, cpu, rss]);
      }
      if (entry) {
        const cutoff = now - this.historyMs;
        while (entry.history.length && entry.history[0][0] < cutoff) entry.history.shift();
      }
    }
    for (const id of this.entries.keys()) if (!targets.has(id)) this.entries.delete(id);
    this.memberTicks = memberTicks;
    this.lastAt = now;
  }

  // The latest sample, if it belongs to `pid` (not to an instance that has since exited).
  _current(id, pid) {
    const entry = this.entries.get(id);
    return pid && entry?.pid === pid ? entry.current : null;
  }

  /** Latest totals for the process list, or null when not running. */
  summary(id, pid) {
    const c = this._current(id, pid);
    return c ? { cpu: c.cpu, rss: c.rss, processes: c.processes } : null;
  }

  /** Everything the Resources view shows. */
  detail(id, pid) {
    const entry = this.entries.get(id);
    const c = this._current(id, pid);
    return {
      intervalMs: this.intervalMs,
      historyMs: this.historyMs,
      cpus: os.availableParallelism(),
      totalMemory: os.totalmem(),
      current: c && {
        at: c.at,
        cpu: c.cpu,
        rss: c.rss,
        processes: c.processes,
        threads: c.threads,
        members: c.members
          .map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name, command: readCmdline(p.pid).slice(0, 500), cpu: p.cpu, rss: p.rss, threads: p.threads }))
          .sort((a, b) => a.pid - b.pid),
      },
      history: entry?.history ?? [],
    };
  }
}
