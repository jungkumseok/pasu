import fs from 'node:fs';

// Thin helpers over Linux /proc. A process is identified by (pid, startTime):
// startTime is the kernel's start time in clock ticks since boot, which makes
// the pair unique even if the pid is recycled.

export function readStat(pid) {
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  // The command name (field 2) is in parentheses and may itself contain spaces or ')'.
  const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  return { pid, state: fields[0], pgrp: Number(fields[2]), startTime: fields[19] };
}

function isLive(stat) {
  return stat && stat.state !== 'Z' && stat.state !== 'X';
}

/** True if `pid` is alive and (when known) is the same process that started at `startTime`. */
export function isRunning(pid, startTime) {
  const stat = readStat(pid);
  if (!isLive(stat)) return false;
  return !startTime || stat.startTime === startTime;
}

/** True if `pid` now belongs to a different process than the one we started. */
export function isRecycled(pid, startTime) {
  const stat = readStat(pid);
  return Boolean(stat && startTime && stat.startTime !== startTime);
}

/** True if any live process is still in process group `pgid`. */
export function groupAlive(pgid) {
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.charCodeAt(0) < 48 || e.charCodeAt(0) > 57) continue;
    const stat = readStat(e);
    if (stat && stat.pgrp === pgid && isLive(stat)) return true;
  }
  return false;
}

let cachedBootId;
/** Changes on every boot, so a saved value tells whether the machine restarted since. */
export function bootId() {
  if (cachedBootId === undefined) {
    try {
      cachedBootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      cachedBootId = null;
    }
  }
  return cachedBootId;
}
