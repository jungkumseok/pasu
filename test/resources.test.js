import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ResourceMonitor } from '../src/resources.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('usage covers the whole session, including CPU of children', async () => {
  // A shell (own session, like a managed process) running a busy child and an idle one.
  const child = spawn('/bin/sh', ['-c', 'while :; do :; done & sleep 30 & wait'], { detached: true, stdio: 'ignore' });
  try {
    await sleep(200);
    const mon = new ResourceMonitor({ intervalMs: 500 });
    const targets = new Map([['busy', child.pid], ['stopped', null]]);
    mon.sample(targets);
    assert.equal(mon.summary('busy', child.pid).cpu, null, 'no CPU figure before there is a delta');
    await sleep(500);
    mon.sample(targets);

    const s = mon.summary('busy', child.pid);
    assert.ok(s.cpu > 50 && s.cpu < 150, `about one core busy, got ${s.cpu}`);
    assert.equal(s.processes, 3);
    assert.ok(s.rss > 0);
    assert.equal(mon.summary('busy', 12345678), null, 'a sample of another pid is not reported');
    assert.equal(mon.summary('stopped', null), null);

    const d = mon.detail('busy', child.pid);
    assert.equal(d.history.length, 2);
    assert.equal(d.current.members.length, 3);
    assert.ok(d.current.members.some((m) => m.command.includes('sleep 30')));
    assert.equal(mon.detail('stopped', null).history.length, 0, 'never-run processes get no history');
  } finally {
    process.kill(-child.pid, 'SIGKILL');
  }
});

test('a process that stops leaves a gap in its history', async () => {
  const child = spawn('/bin/sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
  const mon = new ResourceMonitor();
  await sleep(100);
  mon.sample(new Map([['p', child.pid]]));
  process.kill(-child.pid, 'SIGKILL');
  await new Promise((r) => child.once('exit', r));
  mon.sample(new Map([['p', null]]));
  const { current, history } = mon.detail('p', null);
  assert.equal(current, null);
  assert.deepEqual(history.at(-1).slice(1), [null, null]);
});
