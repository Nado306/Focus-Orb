'use strict';
// The foreground-window watcher, against a fake Windows (winapi.js is tested for
// real under Wine and on Windows, in test/windows.test.js).
const assert = require('assert');
const { createWatcher, isFullScreen } = require('../watcher.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok  - ${name}`);
}

// A desk of windows; `front` is the handle in front.
function fakeWindows() {
  const wins = {
    1: { title: 'main.js - Code', pid: 10, cls: 'Chrome_WidgetWin_1', rect: { left: 0, top: 0, right: 1200, bottom: 900 } },
    2: { title: 'cats - YouTube - Google Chrome', pid: 20, cls: 'Chrome_WidgetWin_1', rect: { left: 0, top: 0, right: 1920, bottom: 1080 } },
    3: { title: 'Program Manager', pid: 30, cls: 'Progman', rect: { left: 0, top: 0, right: 1920, bottom: 1080 } },
    4: { title: 'Big film', pid: 40, cls: 'Video', rect: { left: 0, top: 0, right: 1920, bottom: 1080 }, zoomed: true },
  };
  const exes = { 10: 'Code', 20: 'chrome', 30: 'explorer', 40: 'vlc' };
  const calls = { exeName: 0 };
  const api = {
    front: 1,
    broken: false,
    foreground() {
      if (api.broken) throw new Error('call failed');
      return api.front;
    },
    title: (h) => wins[h].title,
    className: (h) => wins[h].cls,
    pid: (h) => wins[h].pid,
    exeName: (pid) => {
      calls.exeName++;
      return exes[pid] || '';
    },
    rect: (h) => wins[h].rect,
    zoomed: (h) => !!wins[h].zoomed,
    monitor: () => ({ left: 0, top: 0, right: 1920, bottom: 1080 }),
  };
  return { api, wins, exes, calls };
}

function watch(fake, extra) {
  const seen = [];
  const statuses = [];
  let t = 0;
  const w = createWatcher({
    platform: 'win32',
    load: () => fake.api,
    now: () => t,
    onWindow: (x) => seen.push(x),
    onStatus: (s) => statuses.push(s),
    ...extra,
  });
  return { w, seen, statuses, advance: (ms) => (t += ms) };
}

test('reports the window in front: title, program, process, and whether it fills the screen', () => {
  const fake = fakeWindows();
  const { w, seen, statuses } = watch(fake);
  w.start();
  w.stop();
  assert.deepEqual(seen.pop(), { title: 'main.js - Code', process: 'Code', pid: 10, fs: false });
  assert.equal(w.status(), 'ok');
  assert.deepEqual(statuses, ['ok']);
});

test('reports changes at once, the same window again every 5 s, and nothing in between', () => {
  const fake = fakeWindows();
  const { w, seen } = watch(fake);
  w.start();
  w.stop();
  for (let i = 0; i < 4; i++) w.tick();
  assert.equal(seen.length, 1, 'quiet while nothing changes');
  w.tick();
  assert.equal(seen.length, 2, 'a heartbeat after 5 s');
  fake.api.front = 2;
  w.tick();
  assert.equal(seen.length, 3);
  assert.deepEqual(seen.pop(), { title: 'cats - YouTube - Google Chrome', process: 'chrome', pid: 20, fs: true });
  fake.wins[2].title = 'dogs - YouTube - Google Chrome';
  w.tick();
  assert.equal(seen.pop().title, 'dogs - YouTube - Google Chrome', 'a new title is a change');
});

test('nothing in front is reported as an empty window, not skipped', () => {
  const fake = fakeWindows();
  const { w, seen } = watch(fake);
  fake.api.front = 0;
  w.start();
  w.stop();
  assert.deepEqual(seen.pop(), { title: '', process: '', pid: 0, fs: false });
});

test('full screen means covering the monitor; maximised, the desktop and the taskbar do not count', () => {
  const { api } = fakeWindows();
  assert.equal(isFullScreen(api, 2), true);
  assert.equal(isFullScreen(api, 1), false, 'smaller than the screen');
  assert.equal(isFullScreen(api, 3), false, 'the desktop');
  assert.equal(isFullScreen(api, 4), false, 'maximised is not full screen');
});

test('program names are remembered for a minute, not looked up every second', () => {
  const fake = fakeWindows();
  const { w, advance } = watch(fake);
  w.start();
  w.stop();
  for (let i = 0; i < 30; i++) {
    advance(1000);
    w.tick();
  }
  assert.equal(fake.calls.exeName, 1);
  advance(60000);
  w.tick();
  assert.equal(fake.calls.exeName, 2, 'looked up again once stale');
});

test('a bad read is shrugged off; a run of them marks it unavailable; recovery is noticed', () => {
  const fake = fakeWindows();
  const { w, seen, statuses } = watch(fake);
  w.start();
  w.stop();
  fake.api.broken = true;
  for (let i = 0; i < 9; i++) w.tick();
  assert.equal(w.status(), 'ok', 'a few failures change nothing');
  w.tick();
  assert.equal(w.status(), 'unavailable');
  assert.equal(seen.pop(), null, 'the last window is no longer trusted');
  fake.api.broken = false;
  w.tick();
  assert.equal(w.status(), 'ok');
  assert.deepEqual(statuses, ['ok', 'unavailable', 'ok']);
});

test('if the Windows calls cannot be set up, it says so and the app carries on', () => {
  const statuses = [];
  const w = createWatcher({ platform: 'win32', load: () => { throw new Error('no koffi'); }, onWindow: () => {}, onStatus: (s) => statuses.push(s) });
  w.start();
  assert.equal(w.status(), 'unavailable');
  assert.deepEqual(statuses, ['unavailable']);
  const off = createWatcher({ platform: 'linux', onWindow: () => {} });
  off.start();
  assert.equal(off.status(), 'unsupported');
});

console.log(`\n${passed} watcher tests passed`);
