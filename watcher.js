'use strict';
/*
 * Foreground-window watcher.
 *
 * Once a second it asks Windows which window is in front, its title, which
 * program owns it, and whether it fills its screen, and reports whenever that
 * changes (and every 5 s regardless, so the app knows it is still being told).
 *
 * It calls Windows directly from the app (see winapi.js): no PowerShell, no
 * extra process. Nothing leaves the machine. If the calls cannot be set up,
 * status becomes 'unavailable' and the rest of the orb carries on: idle
 * detection does not depend on this.
 */

const HEARTBEAT = 5; // report the same window again after this many quiet seconds
const NAME_TTL_MS = 60000; // remember which program a process is for a minute

// Covers its whole monitor, is not merely maximised, and is not the desktop or taskbar.
function isFullScreen(api, h) {
  const r = api.rect(h);
  if (!r || api.zoomed(h)) return false;
  const cls = api.className(h);
  if (cls === 'Progman' || cls === 'WorkerW' || cls === 'Shell_TrayWnd') return false;
  const m = api.monitor(h);
  if (!m) return false;
  return r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom;
}

function createWatcher(opts) {
  const onWindow = opts.onWindow;
  const onStatus = opts.onStatus || (() => {});
  const platform = opts.platform || process.platform;
  const now = opts.now || Date.now;
  const every = opts.intervalMs || 1000;
  const load =
    opts.load ||
    (() => {
      // eslint-disable-next-line global-require
      const { bindWin32 } = require('./winapi.js');
      // eslint-disable-next-line global-require
      return bindWin32(require('koffi'));
    });

  let api = null;
  let timer = null;
  let status = platform === 'win32' ? 'starting' : 'unsupported'; // starting | ok | unavailable | unsupported
  let lastKey = null;
  let quiet = 0;
  let failures = 0;
  const names = new Map(); // pid -> { name, at }

  function setStatus(s, why) {
    if (s === status) return;
    status = s;
    onStatus(s, why);
  }

  function nameOf(pid) {
    const hit = names.get(pid);
    if (hit && now() - hit.at < NAME_TTL_MS) return hit.name;
    const name = api.exeName(pid);
    if (names.size > 256) names.clear();
    names.set(pid, { name, at: now() });
    return name;
  }

  function read() {
    const h = api.foreground();
    // nothing in front (a window just closed, or focus is changing hands): say so
    if (!h) return { title: '', process: '', pid: 0, fs: false };
    const pid = api.pid(h);
    let fs = false;
    try {
      fs = isFullScreen(api, h);
    } catch (err) {
      fs = false;
    }
    return { title: api.title(h), process: pid ? nameOf(pid) : '', pid, fs };
  }

  function tick() {
    try {
      const w = read();
      failures = 0;
      setStatus('ok');
      const key = `${w.pid}|${w.process}|${w.title}|${w.fs}`;
      quiet += 1;
      if (key !== lastKey || quiet >= HEARTBEAT) {
        lastKey = key;
        quiet = 0;
        onWindow(w);
      }
    } catch (err) {
      // one bad read never stops the watching; a run of them means it is not working
      failures += 1;
      if (failures === 10) {
        onWindow(null); // stop trusting the last window reported
        setStatus('unavailable', err);
      }
    }
  }

  function start() {
    if (platform !== 'win32' || timer) return;
    if (!api) {
      try {
        api = load();
      } catch (err) {
        setStatus('unavailable', err);
        return;
      }
    }
    tick();
    timer = setInterval(tick, every);
    if (timer.unref) timer.unref();
  }

  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // Kept for the app's housekeeping; with no separate process there is nothing to restart.
  function check() {}

  return { start, stop, check, status: () => status, tick };
}

module.exports = { createWatcher, isFullScreen };
