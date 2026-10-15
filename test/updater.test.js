'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdater, describe, FIRST_CHECK_MS, EVERY_MS } = require('../updater.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('ok  -', name);
}

function rig() {
  const au = new EventEmitter();
  au.checks = 0;
  au.installs = [];
  au.checkForUpdates = () => {
    au.checks += 1;
    return Promise.resolve();
  };
  au.quitAndInstall = (...a) => au.installs.push(a);
  const lines = [];
  const log = { info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]) };
  const timers = [];
  const changes = [];
  const u = createUpdater({
    autoUpdater: au,
    log,
    onChange: (s) => changes.push(s.status),
    now: () => 1000,
    setTimeout: (fn, ms) => { const t = { fn, ms, kind: 'once' }; timers.push(t); return t; },
    setInterval: (fn, ms) => { const t = { fn, ms, kind: 'every' }; timers.push(t); return t; },
  });
  return { au, u, lines, timers, changes };
}

test('checks shortly after start and every 4 hours, and starting again does not double up', () => {
  const r = rig();
  r.u.start();
  assert.deepEqual(r.timers.map((t) => [t.kind, t.ms]), [['once', FIRST_CHECK_MS], ['every', EVERY_MS]]);
  assert.equal(FIRST_CHECK_MS, 30000);
  assert.equal(EVERY_MS, 4 * 3600 * 1000);
  assert.equal(r.au.checks, 0, 'nothing at the very start: the app settles first');
  r.timers[0].fn();
  assert.equal(r.au.checks, 1);
  assert.equal(r.au.autoDownload, true);
  assert.equal(r.au.autoInstallOnAppQuit, true);
  assert.equal(r.au.allowDowngrade, false);
  r.u.start();
  assert.equal(r.au.listenerCount('update-downloaded'), 1, 'listeners are attached once');
});

test('found, downloaded in the background, then ready: and it never restarts the app by itself', () => {
  const r = rig();
  r.u.start();
  r.u.check();
  r.au.emit('checking-for-update');
  r.au.emit('update-available', { version: '1.9.1' });
  for (let p = 0; p <= 100; p += 3) r.au.emit('download-progress', { percent: p });
  assert.equal(r.u.state().status, 'downloading');
  assert.ok(r.changes.filter((c) => c === 'downloading').length <= 12, 'progress is reported in 10% steps, not per packet');
  assert.equal(r.u.check(), false, 'no second check while downloading');
  r.au.emit('update-downloaded', { version: '1.9.1' });
  assert.deepEqual([r.u.state().status, r.u.state().version], ['ready', '1.9.1']);
  assert.deepEqual(r.au.installs, [], 'nothing installs until asked, or until the app quits');
  assert.equal(r.u.check(), false, 'nothing more to check once one is ready');
  assert.equal(r.u.install(), true);
  assert.deepEqual(r.au.installs, [[true, true]], 'quietly, then the new version starts');
  assert.ok(r.lines.some(([, m]) => m === 'Update ready: 1.9.1, installs on quit'));
});

test('install does nothing unless an update is ready', () => {
  const r = rig();
  r.u.start();
  assert.equal(r.u.install(), false);
  r.au.emit('update-not-available');
  assert.equal(r.u.install(), false);
  assert.deepEqual(r.au.installs, []);
});

test('a failed check is a warning, not an error, and the next check goes ahead', () => {
  const r = rig();
  r.u.start();
  r.u.check();
  r.au.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\n    at stack'));
  assert.equal(r.u.state().status, 'error');
  assert.equal(r.u.state().error, 'net::ERR_INTERNET_DISCONNECTED');
  assert.ok(r.lines.every(([level]) => level !== 'error'), 'nothing logged as an error');
  assert.equal(r.u.check(), true);
  assert.equal(r.au.checks, 2);
});

test('what Settings says, in each state', () => {
  assert.equal(describe({ status: 'off', why: 'Only in the installed app.' }, '1.9.0'), 'Only in the installed app.');
  assert.equal(describe({ status: 'idle' }, '1.9.0'), 'Version 1.9.0. Checks for updates shortly after start, then every 4 hours.');
  assert.equal(describe({ status: 'current' }, '1.9.0'), 'Up to date (1.9.0).');
  assert.equal(describe({ status: 'downloading', version: '1.9.1', percent: 40 }, '1.9.0'), 'Downloading 1.9.1… 40%');
  assert.match(describe({ status: 'ready', version: '1.9.1' }, '1.9.0'), /^1\.9\.1 is ready\. It installs when you quit/);
  assert.equal(describe({ status: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' }, '1.9.0'), 'Could not check: net::ERR_INTERNET_DISCONNECTED.');
});

console.log(`\n${passed} updater tests passed`);
