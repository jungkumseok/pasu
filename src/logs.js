import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Child processes write straight into their log file (O_APPEND), so they keep
// logging even while Pasu is down. Rotation is copy-then-truncate, which
// works for a file another process holds open in append mode.

const TAIL_BYTES = 64 * 1024;
const MAX_CHUNK = 1024 * 1024;

export function logPath(id) {
  return path.join(config.logsDir, `${id}.log`);
}

export function openLog(id) {
  return fs.openSync(logPath(id), 'a', 0o600);
}

/** Append a Pasu-authored line, visually distinct from the process' own output. */
export function writeMarker(id, message, fd = null) {
  const line = `[pasu ${new Date().toISOString()}] ${message}\n`;
  try {
    if (fd !== null) fs.writeSync(fd, line);
    else fs.appendFileSync(logPath(id), line, { mode: 0o600 });
  } catch (err) {
    console.error(`[logs] cannot write marker for ${id}: ${err.message}`);
  }
}

export function rotateIfNeeded(id) {
  const file = logPath(id);
  try {
    if (fs.statSync(file).size <= config.logMaxBytes) return;
    fs.copyFileSync(file, `${file}.1`);
    fs.truncateSync(file, 0);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[logs] rotate ${id}: ${err.message}`);
  }
}

export function removeLogs(id) {
  fs.rmSync(logPath(id), { force: true });
  fs.rmSync(`${logPath(id)}.1`, { force: true });
}

/** Number of bytes at the end of buf that form an incomplete UTF-8 sequence. */
function incompleteUtf8Tail(buf) {
  for (let i = 1; i <= Math.min(3, buf.length); i++) {
    const b = buf[buf.length - i];
    if ((b & 0xc0) === 0x80) continue; // continuation byte, keep looking back
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > i ? i : 0;
  }
  return 0;
}

/**
 * Read log output. Without `offset`, returns the tail of the file. With `offset`,
 * returns what was appended since then. `reset` tells the client to discard what
 * it has (the file was rotated/truncated under it).
 */
export function readLog(id, offset) {
  const file = logPath(id);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return { text: '', offset: 0, reset: offset == null || offset > 0 };
    throw err;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let start;
    let reset = false;
    if (offset == null || offset > size) {
      start = Math.max(0, size - TAIL_BYTES);
      reset = true;
    } else {
      start = Math.max(offset, size - MAX_CHUNK);
      reset = start !== offset;
    }
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let body = buf.subarray(0, buf.length - incompleteUtf8Tail(buf));
    const end = start + body.length;
    // When starting mid-file, drop the partial first line.
    if (reset && start > 0) {
      const nl = body.indexOf(0x0a);
      body = nl >= 0 ? body.subarray(nl + 1) : body;
    }
    return { text: body.toString('utf8'), offset: end, reset };
  } finally {
    fs.closeSync(fd);
  }
}
