'use strict';
/*
 * Checks that only mean anything on Windows: the real Windows calls, the real
 * window watcher, and the real start-up registry entries via reg.exe. Skipped
 * elsewhere. The registry part only runs with CI=true, because switching start
 * with Windows off removes every Focus Orb entry, including a real one.
 *
 * FO_FRONT_FROM_NOTEPAD=1 stands Notepad's window in for "the window in front",
 * for Wine, whose GetForegroundWindow does not answer calls made this way.
 */
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('windows tests skipped: not Windows');
  process.exit(0);
}

const koffi = require('koffi');
const { bindWin32 } = require('../winapi.js');
const { createWatcher } = require('../watcher.js');
const { createStartup } = require('../startup.js');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('ok  -', name);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const api = bindWin32(koffi);
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const notepad = spawn(`${sysRoot}\\System32\\notepad.exe`, [], { detached: false });
  let h = 0;
  for (let i = 0; i < 40 && !h; i++) {
    await wait(250);
    h = api.find('Notepad', null);
  }

  try {
    await test('the Windows calls: title, class, process, program name, size and screen of a real window', () => {
      assert.ok(h, 'Notepad has a window');
      assert.match(api.title(h), /notepad/i);
      assert.equal(api.className(h), 'Notepad');
      const pid = api.pid(h);
      assert.ok(pid > 0);
      assert.equal(api.exeName(pid).toLowerCase(), 'notepad');
      assert.equal(api.exeName(process.pid).toLowerCase(), 'node', 'its own process too');
      assert.equal(api.exeName(0x7ffffff0), '', 'a process that does not exist is an empty name, not an error');
      const r = api.rect(h);
      assert.ok(r && r.right > r.left && r.bottom > r.top, JSON.stringify(r));
      const m = api.monitor(h);
      assert.ok(m && m.right > m.left && m.bottom > m.top, JSON.stringify(m));
      assert.equal(typeof api.zoomed(h), 'boolean');
      if (!process.env.FO_FRONT_FROM_NOTEPAD) assert.equal(typeof api.foreground(), 'number');
    });

    await test('the watcher, for real: running, and reporting windows as plain values', async () => {
      const seen = [];
      const real = bindWin32(koffi);
      const load = process.env.FO_FRONT_FROM_NOTEPAD ? () => ({ ...real, foreground: () => h }) : undefined;
      const w = createWatcher({ platform: 'win32', load, intervalMs: 200, onWindow: (x) => seen.push(x) });
      w.start();
      await wait(1500);
      w.stop();
      assert.equal(w.status(), 'ok');
      assert.ok(seen.length >= 1);
      const last = seen[seen.length - 1];
      assert.deepEqual(Object.keys(last).sort(), ['fs', 'pid', 'process', 'title']);
      assert.equal(typeof last.title, 'string');
      if (process.env.FO_FRONT_FROM_NOTEPAD) assert.equal(last.process.toLowerCase(), 'notepad');
    });

    if (process.env.CI === 'true') {
      await test('start with Windows, through the real registry: on, read back, taken over, off', async () => {
        const run = (args) => new Promise((resolve) => execFile(`${sysRoot}\\System32\\reg.exe`, args, { windowsHide: true }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') })));
        const exe = 'C:\\Program Files\\Focus Orb CI\\Focus Orb.exe';
        const s = createStartup({ name: 'com.focusorb.ci-test', current: () => exe, exists: () => true, run });
        let st = await s.set(true);
        assert.deepEqual(st, { on: true, here: true, others: [] });
        // an older copy's entry, the way an earlier version would have left it
        await run(['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Focus Orb old', '/t', 'REG_SZ', '/d', '"C:\\Old\\Focus Orb 1.6.2.exe" --x', '/f']);
        st = await s.state();
        assert.equal(st.others.length, 1);
        const moved = await s.follow();
        assert.equal(moved.moved, true);
        assert.deepEqual(moved.state, { on: true, here: true, others: [] });
        st = await s.set(false);
        assert.equal(st.on, false);
      });
    } else {
      console.log('skip - registry round trip (only with CI=true)');
    }
  } finally {
    try {
      notepad.kill();
    } catch (err) {
      /* gone */
    }
  }
  console.log(`\n${passed} windows tests passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
