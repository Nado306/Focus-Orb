'use strict';
/*
 * Automatic updates, for the installed copy only (the portable .exe stays manual).
 *
 * Checks the public releases page shortly after start and every few hours,
 * downloads a newer version in the background, and installs it when the app quits.
 * It never restarts the app by itself: "Restart to update" in the menu does it
 * now, at a moment of your choosing, and nothing interrupts a focus session.
 */

const FIRST_CHECK_MS = 30 * 1000;
const EVERY_MS = 4 * 60 * 60 * 1000;

function createUpdater(opts) {
  const updater = opts.autoUpdater; // electron-updater's autoUpdater, or a stand-in in tests
  const log = opts.log;
  const onChange = opts.onChange || (() => {});
  const now = opts.now || Date.now;
  const timers = { setTimeout: opts.setTimeout || setTimeout, setInterval: opts.setInterval || setInterval };

  let state = { status: 'idle', version: '', percent: 0, checkedAt: 0, error: '' };
  let first = null;
  let every = null;
  let wired = false;

  function set(patch) {
    state = { ...state, ...patch };
    onChange(state);
  }

  function wire() {
    if (wired) return;
    wired = true;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.logger = null; // our own log says what matters
    updater.on('checking-for-update', () => set({ status: 'checking', error: '' }));
    updater.on('update-not-available', () => set({ status: 'current', checkedAt: now() }));
    updater.on('update-available', (info) => {
      log.info(`Update found: ${info && info.version}`);
      set({ status: 'downloading', version: String((info && info.version) || ''), percent: 0, checkedAt: now() });
    });
    updater.on('download-progress', (p) => {
      const percent = Math.floor(Number(p && p.percent) / 10) * 10; // a change every 10%, not every packet
      if (percent !== state.percent) set({ percent });
    });
    updater.on('update-downloaded', (info) => {
      log.info(`Update ready: ${info && info.version}, installs on quit`);
      set({ status: 'ready', version: String((info && info.version) || state.version), percent: 100 });
    });
    updater.on('error', (err) => {
      // a failed check is not an app error: no network, the releases page down, and so on
      log.warn('Update check failed', err && err.message ? err.message : String(err));
      set({ status: 'error', error: String((err && err.message) || err).split('\n')[0].slice(0, 120), checkedAt: now() });
    });
  }

  function check() {
    if (state.status === 'checking' || state.status === 'downloading' || state.status === 'ready') return false;
    wire();
    try {
      const p = updater.checkForUpdates();
      if (p && p.catch) p.catch(() => {}); // reported through the 'error' event
    } catch (err) {
      set({ status: 'error', error: String(err.message || err).slice(0, 120), checkedAt: now() });
    }
    return true;
  }

  function start() {
    stop();
    wire();
    first = timers.setTimeout(check, FIRST_CHECK_MS);
    every = timers.setInterval(check, EVERY_MS);
    [first, every].forEach((t) => t && t.unref && t.unref());
  }

  function stop() {
    clearTimeout(first);
    clearInterval(every);
  }

  // Quit and install now. Only ever on request.
  function install() {
    if (state.status !== 'ready') return false;
    log.info(`Restarting to install ${state.version}`);
    updater.quitAndInstall(true, true); // quietly, then start the new version
    return true;
  }

  return { start, stop, check, install, state: () => state };
}

// What the settings window says.
function describe(s, current) {
  switch (s.status) {
    case 'off':
      return s.why || 'Off.';
    case 'checking':
      return 'Checking…';
    case 'downloading':
      return `Downloading ${s.version}… ${s.percent}%`;
    case 'ready':
      return `${s.version} is ready. It installs when you quit, or use Restart to update in the menu.`;
    case 'current':
      return `Up to date (${current}).`;
    case 'error':
      return `Could not check: ${s.error || 'no connection'}.`;
    default:
      return `Version ${current}. Checks for updates shortly after start, then every 4 hours.`;
  }
}

module.exports = { createUpdater, describe, FIRST_CHECK_MS, EVERY_MS };
