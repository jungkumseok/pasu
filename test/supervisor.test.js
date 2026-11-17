import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pasu-test-'));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pasu-work-'));
process.env.PASU_DATA = dataDir;

const { config } = await import('../src/config.js');
const { Supervisor } = await import('../src/supervisor.js');
const procfs = await import('../src/procfs.js');
const logs = await import('../src/logs.js');

config.backoff = { initialMs: 200, maxMs: 1000, stableAfterMs: 5000 };
config.pollIntervalMs = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error('timed out waiting for condition');
}

const supervisors = [];
function makeSupervisor() {
  const s = new Supervisor();
  s.init();
  supervisors.push(s);
  return s;
}
function detach(s) {
  clearInterval(s.timer);
  for (const st of s.procs.values()) {
    clearTimeout(st.restartTimer);
    st.child?.removeAllListeners('exit');
    st.child = null;
  }
}

let sup;
before(() => {
  sup = makeSupervisor();
});
after(async () => {
  for (const s of supervisors) {
    for (const p of s.list()) await s.stop(p.id).catch(() => {});
    detach(s);
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

test('validates input', async () => {
  await assert.rejects(sup.create({ name: '', command: '', cwd: 'relative' }), (err) => {
    assert.ok(err.errors.name && err.errors.command && err.errors.cwd);
    return true;
  });
  await assert.rejects(sup.create({ name: 'x', command: 'true', cwd: workDir, env: { 'BAD-KEY': '1' } }), /Invalid variable name/);
});

test('start, env, cwd, logs and stop', async () => {
  const p = await sup.create({
    name: 'Echo Server',
    command: 'echo "cwd=$(pwd) foo=$FOO"; exec sleep 300',
    cwd: workDir,
    env: { FOO: 'bar baz' },
    autostart: false,
  });
  assert.equal(p.id, 'echo-server');
  assert.equal(p.status, 'stopped');

  await sup.start(p.id);
  const v = sup.view(p.id);
  assert.equal(v.status, 'running');
  assert.ok(procfs.isRunning(v.pid));

  await waitFor(() => logs.readLog(p.id).text.includes(`cwd=${workDir} foo=bar baz`));

  const pid = v.pid;
  await sup.stop(p.id);
  assert.equal(sup.view(p.id).status, 'stopped');
  assert.equal(sup.view(p.id).held, true);
  assert.ok(!procfs.isRunning(pid));
});

test('stop kills the whole process group and escalates to SIGKILL', async () => {
  const p = await sup.create({
    name: 'stubborn',
    autostart: true,
    // The shell ignores TERM and spawns a child that ignores it too.
    command: "trap '' TERM; bash -c \"trap '' TERM; sleep 300\" & wait",
    cwd: workDir,
    stopTimeoutSec: 1,
  });
  const pid = sup.view(p.id).pid;
  await waitFor(() => procfs.groupAlive(pid));
  const t0 = Date.now();
  await sup.stop(p.id);
  assert.ok(Date.now() - t0 >= 900, 'waited for the grace period');
  assert.ok(!procfs.groupAlive(pid), 'no group members remain');
  assert.match(logs.readLog(p.id).text, /sending SIGKILL/);
});

test('autostart restarts crashing processes with growing backoff', async () => {
  const p = await sup.create({ name: 'crasher', command: 'echo boom; exit 3', cwd: workDir, autostart: true });
  await waitFor(() => sup.view(p.id).crashCount >= 3, 8000);
  const v = sup.view(p.id);
  assert.equal(v.lastExit.code, 3);
  assert.ok(['backoff', 'running'].includes(v.status));
  const log = logs.readLog(p.id).text;
  assert.match(log, /restarting in 0\.2s \(attempt 1\)/);
  assert.match(log, /restarting in 0\.4s \(attempt 2\)/);

  // A manual stop holds it down: no more restarts.
  await sup.stop(p.id);
  const count = sup.view(p.id).crashCount;
  await sleep(800);
  assert.equal(sup.view(p.id).status, 'stopped');
  assert.equal(sup.view(p.id).crashCount, count);
});

test('a bad working directory is reported, not thrown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pasu-gone-'));
  const p = await sup.create({ name: 'gone', command: 'sleep 1', cwd: dir, autostart: false });
  fs.rmSync(dir, { recursive: true });
  await assert.rejects(sup.start(p.id), /Failed to start/);
  assert.equal(sup.view(p.id).status, 'failed');
});

test('processes survive the supervisor and are re-adopted', async () => {
  const p = await sup.create({ name: 'survivor', command: 'exec sleep 300', cwd: workDir, autostart: true });
  const pid = sup.view(p.id).pid;
  assert.ok(pid);

  // Simulate Pasu going away: drop handles without stopping anything.
  detach(sup);
  await sleep(200);
  assert.ok(procfs.isRunning(pid), 'still running without its supervisor');

  const sup2 = makeSupervisor();
  const v = sup2.view(p.id);
  assert.equal(v.status, 'running');
  assert.equal(v.pid, pid, 'adopted rather than started again');

  // Adopted processes are polled: an external kill is noticed and triggers a restart.
  process.kill(pid, 'SIGKILL');
  await waitFor(() => sup2.view(p.id).pid && sup2.view(p.id).pid !== pid, 5000);
  assert.equal(sup2.view(p.id).status, 'running');

  // Editing the command flags a pending restart.
  const edited = await sup2.update(p.id, { ...sup2.view(p.id), command: 'exec sleep 301' });
  assert.equal(edited.needsRestart, true);
  await sup2.restart(p.id);
  assert.equal(sup2.view(p.id).needsRestart, false);

  await sup2.remove(p.id);
  assert.equal(sup2.view(p.id), null);
  assert.ok(!fs.existsSync(logs.logPath(p.id)));
  sup = sup2;
});

test('a recycled pid is never adopted or signalled', async () => {
  const p = await sup.create({ name: 'recycled', command: 'exec sleep 300', cwd: workDir, autostart: false });
  // Pretend the run file points at an unrelated live process (this test runner).
  const runFile = path.join(config.runDir, `${p.id}.json`);
  fs.writeFileSync(runFile, JSON.stringify({ pid: process.pid, procStart: '1', startedAt: new Date().toISOString() }));
  detach(sup);
  const sup3 = makeSupervisor();
  assert.equal(sup3.view(p.id).status, 'stopped');
  assert.equal(sup3.view(p.id).pid, null);
  sup = sup3;
});

test('log reading handles offsets and truncation', () => {
  const id = 'logtest';
  fs.writeFileSync(logs.logPath(id), 'line1\nline2\n');
  const first = logs.readLog(id);
  assert.equal(first.text, 'line1\nline2\n');
  fs.appendFileSync(logs.logPath(id), 'line3\n');
  const next = logs.readLog(id, first.offset);
  assert.deepEqual([next.text, next.reset], ['line3\n', false]);
  fs.writeFileSync(logs.logPath(id), 'x\n');
  assert.equal(logs.readLog(id, next.offset).reset, true);
  // Never splits a multi-byte character.
  fs.writeFileSync(logs.logPath(id), Buffer.from([0x61, 0xe2, 0x82]));
  assert.equal(logs.readLog(id).text, 'a');
});
