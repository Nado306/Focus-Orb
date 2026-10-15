'use strict';
// Start with Windows, against a fake registry that answers like reg.exe.
const assert = require('node:assert/strict');
const { RUN_KEY, APPROVED_KEY, parseRunKey, exeOf, createStartup } = require('../startup.js');

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('ok  -', name);
}

const NEW = 'C:\\Users\\me\\Downloads\\Focus Orb 1.7.5.exe';
const OLD = 'C:\\Users\\me\\Downloads\\Focus Orb 1.6.2.exe';

function fakeRegistry(run, approved, files) {
  const keys = { [RUN_KEY]: new Map(Object.entries(run || {})), [APPROVED_KEY]: new Map(Object.entries(approved || {})) };
  const calls = [];
  const exec = async (args) => {
    calls.push(args.join(' '));
    const [op, key] = args;
    const values = keys[key];
    if (op === 'query') {
      if (!values.size) return { ok: false, stdout: '' }; // reg.exe: "unable to find", exit code 1
      const type = key === APPROVED_KEY ? 'REG_BINARY' : 'REG_SZ';
      const lines = [...values].map(([n, d]) => `    ${n}    ${type}    ${d}`);
      return { ok: true, stdout: `\r\n${key.replace('HKCU', 'HKEY_CURRENT_USER')}\r\n${lines.join('\r\n')}\r\n\r\n` };
    }
    const name = args[args.indexOf('/v') + 1];
    if (op === 'delete') return { ok: values.delete(name), stdout: '' };
    if (op === 'add') {
      values.set(name, args[args.indexOf('/d') + 1]);
      return { ok: true, stdout: '' };
    }
    return { ok: false, stdout: '' };
  };
  const startup = createStartup({ name: 'com.focusorb.app', current: () => NEW, exists: (p) => (files || [NEW, OLD]).includes(p), run: exec });
  return { startup, run: keys[RUN_KEY], approved: keys[APPROVED_KEY], calls };
}

(async () => {
  await test('reads reg.exe output and the program each entry runs', () => {
    const out = `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    OneDrive    REG_SZ    "C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background\r\n    com.focusorb.app    REG_SZ    "${OLD}"\r\n\r\n`;
    const e = parseRunKey(out);
    assert.deepEqual(e.map((x) => x.name), ['OneDrive', 'com.focusorb.app']);
    assert.equal(exeOf(e[0].command), 'C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe');
    assert.equal(exeOf(e[1].command), OLD);
    assert.equal(exeOf('C:\\Apps\\Focus Orb.exe --hidden'), 'C:\\Apps\\Focus Orb.exe', 'unquoted: up to .exe');
  });

  await test('an entry for an older portable copy counts as on, and says it starts another copy', async () => {
    const r = fakeRegistry({ OneDrive: '"C:\\OneDrive.exe" /background', 'com.focusorb.app': `"${OLD}"` });
    const s = await r.startup.state();
    assert.equal(s.on, true, 'Windows does start Focus Orb, so the switch must say so');
    assert.equal(s.here, false);
    assert.deepEqual(s.others, [{ name: 'com.focusorb.app', exe: OLD, missing: false }]);
  });

  await test('at launch it takes the entry over for this copy, and leaves other apps alone', async () => {
    const r = fakeRegistry({ OneDrive: '"C:\\OneDrive.exe" /background', 'com.focusorb.app': `"${OLD}"`, 'electron.app.Focus Orb': `"${OLD}"` });
    const res = await r.startup.follow();
    assert.equal(res.moved, true);
    assert.deepEqual([...r.run.keys()].sort(), ['OneDrive', 'com.focusorb.app']);
    assert.equal(r.run.get('com.focusorb.app'), `"${NEW}"`, 'points at this copy');
    assert.deepEqual(res.state, { on: true, here: true, others: [] });
    const again = await r.startup.follow();
    assert.equal(again.moved, false, 'and once right, nothing more is touched');
  });

  await test('an entry for a copy that no longer exists is flagged, and taken over too', async () => {
    const r = fakeRegistry({ 'com.focusorb.app': `"${OLD}"` }, {}, [NEW]);
    assert.equal((await r.startup.state()).others[0].missing, true);
    await r.startup.follow();
    assert.equal(r.run.get('com.focusorb.app'), `"${NEW}"`);
  });

  await test('not set to start: nothing is added at launch', async () => {
    const r = fakeRegistry({ OneDrive: '"C:\\OneDrive.exe"' });
    const res = await r.startup.follow();
    assert.equal(res.moved, false);
    assert.equal(res.state.on, false);
    assert.ok(!r.calls.some((c) => c.startsWith('add')), 'never switched on behind your back');
  });

  await test('switched off in Task Manager: shown as off, left off at launch, and switching on enables it', async () => {
    const r = fakeRegistry({ 'com.focusorb.app': `"${OLD}"` }, { 'com.focusorb.app': '030000000000000000000000' });
    const s = await r.startup.state();
    assert.equal(s.on, false, 'Task Manager says it does not start');
    assert.equal((await r.startup.follow()).moved, false);
    assert.equal(r.run.get('com.focusorb.app'), `"${OLD}"`, 'untouched');
    const on = await r.startup.set(true);
    assert.deepEqual(on, { on: true, here: true, others: [] });
    assert.equal(r.approved.has('com.focusorb.app'), false, 'the Task Manager "disabled" mark is cleared');
  });

  await test('switching off removes every Focus Orb entry, whichever copy and whatever its name', async () => {
    const r = fakeRegistry({ OneDrive: '"C:\\OneDrive.exe"', 'com.focusorb.app': `"${NEW}"`, 'Focus Orb old': `"${OLD}"` });
    const off = await r.startup.set(false);
    assert.equal(off.on, false);
    assert.deepEqual([...r.run.keys()], ['OneDrive']);
  });

  console.log(`\n${passed} startup tests passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
