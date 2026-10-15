'use strict';
/*
 * A small rolling log, so that when something misbehaves there is a record of
 * what the app saw and did: start-up, the window watcher, the browser link,
 * start with Windows, and anything that crashed.
 *
 * It never records window titles, page addresses or what you were working on:
 * only events, states and errors. One file, up to 512 KB, then the previous
 * file is kept as .1 and a new one started, so it can never grow unbounded.
 */
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 512 * 1024;

function createLog(opts) {
  const dir = opts.dir;
  const file = path.join(dir, 'focus-orb.log');
  const now = opts.now || (() => new Date());
  let size = -1;

  function rotate() {
    try {
      fs.renameSync(file, `${file}.1`);
    } catch (err) {
      /* nothing to rotate */
    }
    size = 0;
  }

  function write(level, msg, extra) {
    try {
      if (size < 0) {
        fs.mkdirSync(dir, { recursive: true });
        try {
          size = fs.statSync(file).size;
        } catch (err) {
          size = 0;
        }
      }
      let line = `${now().toISOString()} ${level.padEnd(5)} ${String(msg).replace(/\s+/g, ' ').slice(0, 500)}`;
      if (extra) {
        const detail = extra instanceof Error ? extra.stack || extra.message : typeof extra === 'string' ? extra : JSON.stringify(extra);
        line += ` | ${String(detail).replace(/\r?\n\s*/g, ' / ').slice(0, 2000)}`;
      }
      line += '\n';
      if (size + line.length > MAX_BYTES) rotate();
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch (err) {
      /* a log that cannot be written must never take the app down with it */
    }
  }

  return {
    file,
    info: (msg, extra) => write('info', msg, extra),
    warn: (msg, extra) => write('warn', msg, extra),
    error: (msg, extra) => write('error', msg, extra),
  };
}

module.exports = { createLog, MAX_BYTES };
