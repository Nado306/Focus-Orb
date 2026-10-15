'use strict';
/*
 * Start with Windows: the entries Windows uses to start Focus Orb at sign-in.
 *
 * They live in HKCU\Software\Microsoft\Windows\CurrentVersion\Run, one value per
 * app, each holding the command to run. Electron only reports an entry when it
 * points at the very file that is running now. The portable .exe has its version
 * in its file name, so an entry made by an older copy points somewhere else: the
 * switch read "off" while Windows went on starting the old file each morning.
 *
 * So this reads the Run key itself, finds every entry that starts a Focus Orb,
 * and can point them all at the copy in use, or remove them.
 */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
// Where Task Manager's Startup apps tab records an entry as disabled, by value name.
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const ORB = /focus[ ._-]?orb/i;

// `reg query` output: "    <name>    REG_SZ    <data>", one value per line.
function parseRunKey(text) {
  const out = [];
  String(text || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const m = /^ {4}(.+?) {4}REG_(?:EXPAND_)?SZ {4}(.*)$/.exec(line);
      if (m) out.push({ name: m[1], command: m[2].trim() });
    });
  return out;
}

// Task Manager's on/off per value name: first byte 02 or 06 is on, 03 or 07 is off.
function parseApproved(text) {
  const off = new Set();
  String(text || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const m = /^ {4}(.+?) {4}REG_BINARY {4}([0-9A-F]{2})/i.exec(line);
      if (m && parseInt(m[2], 16) & 1) off.add(m[1]);
    });
  return off;
}

// The program a command line runs: a quoted path, or everything up to ".exe".
function exeOf(command) {
  const c = String(command || '').trim();
  if (c.startsWith('"')) {
    const end = c.indexOf('"', 1);
    return end > 0 ? c.slice(1, end) : c.slice(1);
  }
  const m = /^(.*?\.exe)\b/i.exec(c);
  return m ? m[1] : c.split(' ')[0];
}

const samePath = (a, b) => String(a || '').replace(/\//g, '\\').toLowerCase() === String(b || '').replace(/\//g, '\\').toLowerCase();

// Entries that start Focus Orb, by value name or by the file they run.
function orbEntries(entries) {
  return entries.filter((e) => ORB.test(e.name) || ORB.test(exeOf(e.command)) || /\\focus-orb\\/i.test(e.command)).map((e) => ({ ...e, exe: exeOf(e.command) }));
}

function createStartup(opts) {
  const run = opts.run; // (args) => Promise<{ ok, stdout }>, runs reg.exe
  const exists = opts.exists; // (path) => boolean
  const current = opts.current; // () => the .exe of the copy running now
  const name = opts.name; // the value name this app writes

  // Every Focus Orb entry, including any switched off in Task Manager.
  async function all() {
    const r = await run(['query', RUN_KEY]);
    return r.ok ? orbEntries(parseRunKey(r.stdout)) : [];
  }

  // The ones Windows will actually start.
  async function read() {
    const entries = await all();
    if (!entries.length) return entries;
    const a = await run(['query', APPROVED_KEY]);
    const off = a.ok ? parseApproved(a.stdout) : new Set();
    return entries.filter((e) => !off.has(e.name));
  }

  // What the settings window shows.
  async function state() {
    const entries = await read();
    const here = entries.filter((e) => samePath(e.exe, current()));
    const others = entries.filter((e) => !samePath(e.exe, current()));
    return {
      on: entries.length > 0,
      here: here.length > 0,
      others: others.map((e) => ({ name: e.name, exe: e.exe, missing: !exists(e.exe) })),
    };
  }

  const remove = (n) => run(['delete', RUN_KEY, '/v', n, '/f']);
  // a fresh entry starts out enabled, whatever Task Manager said about the old one
  const approve = (n) => run(['delete', APPROVED_KEY, '/v', n, '/f']);
  const write = () => run(['add', RUN_KEY, '/v', name, '/t', 'REG_SZ', '/d', `"${current()}"`, '/f']);

  async function set(on) {
    // disabled ones too: off means none left behind, on means just the one, here
    for (const e of await all()) if (e.name !== name || !on) await remove(e.name);
    if (on) {
      await approve(name);
      await write();
    }
    return state();
  }

  // At launch: if Focus Orb is set to start but not this copy, it starts this copy now.
  async function follow() {
    const s = await state();
    if (s.on && (!s.here || s.others.length)) return { moved: true, state: await set(true) };
    return { moved: false, state: s };
  }

  return { state, set, follow };
}

module.exports = { RUN_KEY, APPROVED_KEY, parseRunKey, parseApproved, exeOf, orbEntries, samePath, createStartup };
