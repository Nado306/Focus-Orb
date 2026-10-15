'use strict';
/*
 * Loads the real main.js with Electron, the PowerShell watcher and the
 * browser listener stubbed out, then drives it the way the app would: window
 * changes, one-second polls, renderer state messages, menu clicks, power
 * events, the secondary windows.
 *
 * This proves the wiring (names, message shapes, ordering). It does not prove
 * anything about real Windows, real PowerShell or real pixels.
 */
// --no-shape runs the whole suite again as if the window shape were unavailable (works on every shell)
if (process.argv.includes('--no-shape')) process.env.NO_SHAPE = '1';
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-test-'));

/* ---------- fakes ---------- */

const ipc = { on: {}, handle: {} };
const power = {};
const windows = [];
const opened = [];
const tips = [];
let idleSeconds = 0;
let watcherOpts = null;
let bridgeOpts = null;
const guards = {};
const appEvents = {};
let bridgeStops = 0;
let saveDialog = { canceled: true };
let openDialog = { canceled: true };
let clock = 1_000_000_000_000;
let cursor = { x: 0, y: 0 };
const shortcuts = new Set();
let takenKeys = [];
let watcherStatus = 'ok';
let displaySf = 1;
Date.now = () => clock;

class FakeContents {
  constructor() { this.sent = []; this.handlers = {}; this.zoom = 0.75; }
  on(ev, cb) { (this.handlers[ev] = this.handlers[ev] || []).push(cb); }
  emit(ev) { (this.handlers[ev] || []).forEach((f) => f()); }
  setWindowOpenHandler() {}
  setZoomFactor(z) { this.zoom = z; }
  setVisualZoomLevelLimits() { return Promise.resolve(); }
  send(channel, payload) { this.sent.push([channel, payload]); }
}
class BrowserWindow {
  constructor(opts) {
    this.opts = opts;
    this.webContents = new FakeContents();
    this.handlers = {};
    this.closed = false;
    windows.push(this);
  }
  setAlwaysOnTop() {}
  setIgnoreMouseEvents(v, o) { this.ignore = { v, o }; }
  setShape(r) { if (process.env.NO_SHAPE) throw new Error('no shape here'); this.shape = r; this.shapes = (this.shapes || 0) + 1; }
  setMenuBarVisibility() {}
  once() {}
  on(ev, cb) { (this.handlers[ev] = this.handlers[ev] || []).push(cb); }
  loadFile(f) { this.file = path.basename(f); }
  emitWin(ev) { (this.handlers[ev] || []).forEach((f) => f()); }
  show() { this.visible = true; this.emitWin('show'); }
  showInactive() { this.visible = true; this.inactive = (this.inactive || 0) + 1; this.emitWin('show'); }
  hide() { this.visible = false; this.emitWin('hide'); }
  focus() {}
  close() { this.closed = true; (this.handlers.closed || []).forEach((f) => f()); }
  isVisible() { return this.visible !== false; }
  getBounds() { const p = this.pos || [1500, 800]; return { x: p[0], y: p[1], width: this.opts.width, height: this.opts.height }; }
  getPosition() { return this.pos || [1500, 800]; }
  setPosition(x, y) { this.pos = [x, y]; this.moves = (this.moves || 0) + 1; }
  setBounds() {}
}
class Tray { setToolTip(t) { tips.push(t); } on() {} popUpContextMenu() {} }
class Notification {
  constructor(o) { this.o = o; }
  static isSupported() { return true; }
  show() { Notification.shown.push(this.o); }
}
Notification.shown = [];

let lastMenu = null;
const fakeElectron = {
  session: {
    defaultSession: {
      setPermissionRequestHandler(fn) { guards.permission = fn; },
      setPermissionCheckHandler(fn) { guards.check = fn; },
    },
  },
  app: {
    setAppUserModelId() {},
    requestSingleInstanceLock: () => true,
    on(ev, fn) { appEvents[ev] = fn; },
    whenReady: () => Promise.resolve(),
    getPath: () => userData,
    getVersion: () => '1.1.0',
    isPackaged: false,
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings() {},
    quit() {},
  },
  BrowserWindow,
  Menu: { buildFromTemplate: (template) => (lastMenu = { template, popup() {} }) },
  Tray,
  Notification,
  ipcMain: {
    handle: (ch, fn) => { ipc.handle[ch] = fn; },
    on: (ch, fn) => { ipc.on[ch] = fn; },
  },
  globalShortcut: {
    register(k) { if (takenKeys.includes(k)) return false; shortcuts.add(k); return true; },
    unregisterAll() { shortcuts.clear(); },
  },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  powerMonitor: { getSystemIdleTime: () => idleSeconds, on: (ev, fn) => { power[ev] = fn; } },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    // two screens: 0-1920 at 100% (or displaySf), and from 1920 a screen at 150%
    getDisplayMatching: (b) => (b && b.x + b.width / 2 >= 1920
      ? { id: 2, workArea: { x: 1920, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 }
      : { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: displaySf }),
    getDisplayNearestPoint: (p) => (p.x >= 1920 ? { id: 2, scaleFactor: 1.5 } : { id: 1, scaleFactor: displaySf }),
    getCursorScreenPoint: () => cursor,
    // two screens: 0-1920 at 100%, and from 1920 a screen at 150% (Windows maps its DIPs from its own corner)
    dipToScreenPoint: (p) => (p.x >= 1920 ? { x: 1920 + (p.x - 1920) * 1.5, y: p.y * 1.5 } : { ...p }),
    screenToDipPoint: (p) => (p.x >= 1920 ? { x: 1920 + (p.x - 1920) / 1.5, y: p.y / 1.5 } : { ...p }),
  },
  dialog: { showSaveDialog: async () => saveDialog, showOpenDialog: async () => openDialog },
  shell: { openPath: async (p) => { opened.push(p); return ''; }, showItemInFolder: (p) => { opened.push(p); } },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request === './watcher.js') {
    return { createWatcher: (opts) => { watcherOpts = opts; return { start() {}, stop() {}, status: () => watcherStatus }; } };
  }
  if (request === './bridge.js') {
    return {
      createBridge: (opts) => {
        bridgeOpts = opts;
        return { start: async () => opts.basePort, stop() { bridgeStops += 1; }, port: () => opts.basePort };
      },
    };
  }
  return realLoad.call(this, request, parent, isMain);
};

let pollFn = null;
const realSetInterval = global.setInterval;
global.setInterval = (fn, ms) => { if (ms === 1000) { pollFn = fn; return 0; } return realSetInterval(fn, ms); };

/* ---------- helpers ---------- */

const inShapeAt = (w, x, y) => !w.shape || w.shape.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('ok  -', name);
}

const orb = () => windows[0];
const orbEv = () => ({ sender: orb().webContents });
const byFile = (f) => windows.find((w) => w.file === f && !w.closed);
const sentOf = (channel) => orb().webContents.sent.filter(([c]) => c === channel).map(([, p]) => p);
const driftMessages = () => sentOf('drift');
const commands = () => sentOf('cmd').map((c) => c.type);
const clearSent = () => { orb().webContents.sent.length = 0; };
const focusState = (o) => ipc.on['state'](orbEv(), { running: true, started: true, phase: 'focus', ...o });
const freshSession = () => { focusState({ started: false, running: false }); focusState({}); };
const tickSeconds = (n) => { for (let i = 0; i < n; i++) { clock += 1000; pollFn(); } };
const setWin = (title, proc, pid = 777) => watcherOpts.onWindow({ title, process: proc, pid });
const complete = () => ipc.handle['session:complete'](orbEv());

function labels(items, out = []) {
  items.forEach((i) => { if (i.label) out.push(i.label); if (i.submenu) labels(i.submenu, out); });
  return out;
}
function find(label) {
  const walk = (items) => {
    for (const i of items) {
      if (i.label === label) return i;
      if (i.submenu) { const f = walk(i.submenu); if (f) return f; }
    }
    return null;
  };
  ipc.on['menu:show'](orbEv());
  const hit = walk(lastMenu.template);
  assert.ok(hit, `menu item "${label}" exists`);
  return hit;
}
// Settings live in the settings window now; the tests drive it the way the window does.
const settingsWin = () => {
  ipc.on['menu:show'](orbEv());
  lastMenu.template.find((i) => i.label === 'Settings…').click();
  return byFile('settings.html');
};
const setSetting = (patch) => ipc.handle['settings:set']({ sender: settingsWin().webContents }, patch);
const flip = (key) => () => ({ [key]: !savedSettings()[key] });
const SETTING_CLICKS = {
  'Use keyboard shortcuts': flip('shortcuts'),
  'Start focus automatically': flip('autoFocus'),
  'Pause when the screen locks': flip('pauseOnLock'),
  'Notify when I drift': flip('driftToast'),
  'Hide during full-screen apps': flip('hideFullscreen'),
  'Desktop notification': flip('notifications'),
  'Ask what I am working on': flip('askIntent'),
  Medium: { scale: 1 },
  Large: { scale: 1.35 },
  'Pause the timer': { meetingMode: 'pause' },
  'Never judge them': { meetingMode: 'neutral' },
  'Again every 90 s': { repeatSec: 90 },
  'Again every 30 s': { repeatSec: 30 },
  '5 dings': { nudgeDings: 5 },
  '3 dings': { nudgeDings: 3 },
  '4 sessions': { dailyGoal: 4 },
  '30 seconds': { graceSec: 30 },
  '20 seconds': { graceSec: 20 },
};
// Like Electron: a checkbox flips before its handler runs.
const click = (label) => {
  if (SETTING_CLICKS[label]) {
    const p = SETTING_CLICKS[label];
    setSetting(typeof p === 'function' ? p() : p);
    return;
  }
  if (label === 'Set up…') {
    ipc.handle['settings:action']({ sender: settingsWin().webContents }, 'browser-link');
    return;
  }
  const item = find(label);
  if (item.type === 'checkbox') item.checked = !item.checked;
  item.click(item);
};
const savedSettings = () => JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));

/* ---------- run ---------- */

(async () => {
  require('../main.js');
  await new Promise((r) => setImmediate(r));

  await test('boots: orb window, poll timer, and settings without private data', async () => {
    assert.equal(windows.length, 1);
    assert.equal(orb().file, 'index.html');
    assert.equal(typeof pollFn, 'function');
    const s = await ipc.handle['settings:get'](orbEv());
    assert.equal(s.graceSec, 20);
    assert.equal(s.nudgeDings, 3);
    assert.equal(s.nudgeTone, undefined, 'the old on/off switch is gone');
    assert.equal(s.theme, 'ember');
    assert.equal(s.driftToast, true);
    assert.equal(s.dailyGoal, 6);
    assert.equal(s.todayCount, 0);
    assert.equal(s.breakCoaching, undefined, 'the break tips are gone');
    assert.equal(s.breakNudge, undefined, 'and so is the "still working?" nudge');
    ['profiles', 'lastSession', 'bridgeToken', 'bridgePort', 'bridgeOn'].forEach((k) => assert.equal(s[k], undefined, `${k} stays private`));
    ['lock-screen', 'unlock-screen', 'suspend', 'resume'].forEach((ev) => assert.equal(typeof power[ev], 'function', `listening for ${ev}`));
  });

  await test('polls say nothing while no session is running', () => {
    setWin('cats - YouTube', 'chrome');
    tickSeconds(40);
    assert.equal(driftMessages().length, 0);
  });

  await test('YouTube during a focus session: nudge after the grace period, labelled', () => {
    freshSession();
    clearSent();
    tickSeconds(15);
    assert.equal(driftMessages().length, 0, 'inside the grace period');
    tickSeconds(10);
    const nudged = driftMessages().find((m) => m.nudge);
    assert.ok(nudged, 'a nudge was sent');
    assert.equal(nudged.nudge, 'off-topic');
    assert.equal(nudged.label, 'youtube');
  });

  await test('going back to work clears the drift; pausing clears one in progress', () => {
    clearSent();
    setWin('main.js - Code', 'Code');
    tickSeconds(6);
    assert.equal(driftMessages().pop().status, 'ok');
    setWin('cats - YouTube', 'chrome');
    tickSeconds(25);
    clearSent();
    focusState({ running: false });
    tickSeconds(2);
    assert.equal(driftMessages().pop().status, 'ok');
  });

  await test('the orb itself never counts as a distraction; going idle gives one away nudge', () => {
    freshSession();
    clearSent();
    setWin('Focus Orb', 'electron', process.pid);
    tickSeconds(60);
    assert.equal(driftMessages().length, 0);
    setWin('main.js - Code', 'Code');
    idleSeconds = 150;
    tickSeconds(3);
    assert.equal(driftMessages().filter((m) => m.nudge === 'away').length, 1);
    idleSeconds = 0;
    tickSeconds(2);
    assert.equal(driftMessages().pop().status, 'ok');
  });

  await test('session end: plain-English summary, saved history, and a fresh tally afterwards', async () => {
    freshSession();
    setWin('main.js - Code', 'Code');
    tickSeconds(60);
    setWin('r/all - Reddit', 'chrome');
    tickSeconds(40);
    setWin('main.js - Code', 'Code');
    tickSeconds(10);
    const res = await complete();
    assert.match(res.text, /\d+% on task\./);
    assert.match(res.text, /Drifted once, longest \d+ s on reddit\./);
    assert.equal(res.done, 1);
    assert.equal(savedSettings().lastSession, res.text);
    const history = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'));
    assert.equal(history.length, 1);
    assert.equal(history[0].focusMin, 25);
    assert.equal(history[0].distractions[0].label, 'reddit');
    assert.equal((await complete()).text, '', 'the next session starts from nothing');
  });

  await test('menu: the things you reach for, with themes, and everything else in the settings window', () => {
    ipc.on['menu:show'](orbEv());
    const all = labels(lastMenu.template);
    ['Pause', 'Finish session now', 'Restart this session', 'Skip to next', 'Allow a detour', 'Task profile', 'Edit profiles…', 'Theme', 'Ocean', 'Tomato', 'Settings…', 'Hide orb', 'Quit', 'General', 'Coding', 'Writing']
      .forEach((l) => assert.ok(all.includes(l), `menu has "${l}"`));
    ['Timing', 'Distraction', 'Alerts', 'Orb', 'Nudges'].forEach((l) => assert.ok(!all.includes(l), `"${l}" has moved to the settings window`));
    assert.ok(all.includes('Stats (2 of 6 today)…'), 'the count rides on the Stats line');
    const s = ipc.handle['settings:all']({ sender: settingsWin().webContents });
    assert.equal(s.version, '1.1.0', 'the version is in the settings window');
    assert.equal(s.values.graceSec, 20);
    assert.equal(ipc.handle['settings:all']({ sender: orb().webContents }), null, 'only the settings window may read them');
    assert.equal(ipc.handle['settings:set']({ sender: orb().webContents }, { focus: 50 }), null, 'or change them');
    const bad = setSetting({ focus: 0, scale: 2, theme: 'nonsense', bridgeToken: 'x', x: 9, autoBreak: 'yes', profileId: 'nope' });
    assert.deepEqual([bad.values.focus, bad.values.scale, bad.values.theme, bad.values.autoBreak], [25, 1, savedSettings().theme, true], 'nonsense is ignored');
    assert.notEqual(savedSettings().bridgeToken, 'x', 'and private settings cannot be set from there');
    assert.equal(setSetting({ focus: 50 }).values.focus, 50);
    setSetting({ focus: 25 });
    ipc.on['menu:show'](orbEv());
    const top = lastMenu.template.filter((i) => i.label).map((i) => i.label);
    assert.ok(top.length <= 12, `a short top level (${top.length} lines)`);
    assert.ok(Math.max(...top.map((l) => l.length)) <= 30, 'and a narrow one');
    const every = labels(lastMenu.template);
    const widest = every.reduce((a, l) => (l.length > a.length ? l : a), '');
    assert.ok(widest.length <= 28, `no menu line is long enough to stretch its menu ("${widest}")`);
    clearSent();
    click('30 seconds');
    assert.equal(sentOf('settings').pop().graceSec, 30);
    click('20 seconds');
    click('Coding');
    assert.equal(savedSettings().profileId, 'coding');
  });

  await test('Coding profile: a non-listed app is off task, an allowed one is not', () => {
    freshSession();
    clearSent();
    setWin('Some song', 'spotify');
    tickSeconds(35);
    assert.ok(driftMessages().some((m) => m.nudge === 'off-topic' && m.label === 'spotify'));
    clearSent();
    setWin('main.js - Code', 'Code');
    tickSeconds(10);
    assert.equal(driftMessages().pop().status, 'ok');
  });

  await test('profile editor: opens once, only talks to its own window, saves sanitised rules', async () => {
    click('Edit profiles…');
    const editor = byFile('profiles.html');
    assert.ok(editor);
    const count = windows.length;
    click('Edit profiles…');
    assert.equal(windows.length, count, 'a second click reuses the window');
    assert.equal(await ipc.handle['profiles:get']({ sender: orb().webContents }), null, 'the orb window is refused');
    const got = await ipc.handle['profiles:get']({ sender: editor.webContents });
    assert.equal(got.activeId, 'coding');
    assert.equal(got.live.process, 'Code');
    const edited = got.profiles.map((p) => (p.id === 'coding' ? { ...p, allow: [...p.allow, '  APP:Spotify ', ''] } : p));
    const res = await ipc.handle['profiles:save']({ sender: editor.webContents }, { profiles: edited, activeId: 'coding' });
    assert.ok(res.profiles.find((p) => p.id === 'coding').allow.includes('app:spotify'));
    assert.equal(await ipc.handle['profiles:save']({ sender: orb().webContents }, { profiles: [], activeId: 'x' }), null);
    freshSession();
    clearSent();
    setWin('Some song', 'spotify');
    tickSeconds(40);
    assert.equal(driftMessages().length, 0, 'spotify is allowed now');
    assert.ok(editor.webContents.sent.some(([c]) => c === 'profiles:live'), 'the editor gets live window updates');
    const bad = await ipc.handle['profiles:save']({ sender: editor.webContents }, { profiles: 'nonsense', activeId: 'nope' });
    assert.ok(bad.profiles.length >= 1 && bad.profiles.some((p) => p.id === bad.activeId));
    click('General');
    assert.equal(savedSettings().profileId, 'general');
  });

  /* ---------- the new features ---------- */

  await test('detour: anything goes for a while, the orb is told how long is left, then the rules return', () => {
    freshSession();
    setWin('cats - YouTube', 'chrome');
    clearSent();
    click('10 minutes');
    tickSeconds(60);
    assert.equal(driftMessages().filter((m) => m.nudge).length, 0, 'no nudges during a detour');
    const snoozed = driftMessages().filter((m) => m.status === 'snoozed');
    assert.ok(snoozed.length >= 1);
    assert.match(snoozed[snoozed.length - 1].label, /^(9|10) min$/);
    assert.ok(labels((find('Allow a detour'), lastMenu.template)).some((l) => l.startsWith('End detour (')));
    click(find('Allow a detour').submenu.find((i) => i.label && i.label.startsWith('End detour')).label);
    clearSent();
    tickSeconds(25);
    assert.ok(driftMessages().some((m) => m.nudge === 'off-topic'), 'back to normal once the detour ends');
  });

  await test('calls: ignored by default, never judged; "pause" mode pauses and says so when the call ends', () => {
    freshSession();
    clearSent();
    setWin('Zoom Meeting', 'Zoom');
    tickSeconds(40);
    assert.ok(driftMessages().some((m) => m.status === 'meeting'));
    assert.equal(driftMessages().filter((m) => m.nudge).length, 0);
    assert.ok(!commands().includes('pause'), 'default mode does not pause');
    setWin('main.js - Code', 'Code');
    tickSeconds(6);

    click('Pause the timer');
    freshSession();
    clearSent();
    Notification.shown.length = 0;
    setWin('Weekly meeting | Microsoft Teams', 'ms-teams');
    tickSeconds(2);
    assert.ok(!commands().includes('pause'), 'a couple of seconds is not yet a call');
    tickSeconds(3);
    assert.ok(commands().includes('pause'), 'paused once the call is established');
    focusState({ running: false });
    setWin('main.js - Code', 'Code');
    tickSeconds(7);
    assert.ok(Notification.shown.some((n) => n.title === 'Call finished'));
    click('Never judge them');
    assert.equal(savedSettings().meetingMode, 'neutral');
  });

  await test('lock and sleep: pauses, resumes by itself after a short absence, and stays paused after a long one', () => {
    freshSession();
    setWin('main.js - Code', 'Code');
    clearSent();
    power['lock-screen']();
    assert.deepEqual(commands(), ['pause']);
    focusState({ running: false });
    clock += 60 * 1000;
    power['unlock-screen']();
    assert.deepEqual(commands(), ['pause', 'resume'], 'a minute away: carries on');

    focusState({});
    clearSent();
    power['lock-screen']();
    focusState({ running: false });
    clock += 4 * 60 * 1000;
    power['unlock-screen']();
    assert.deepEqual(commands(), ['pause'], 'four minutes away: stays paused');

    focusState({});
    clearSent();
    power['lock-screen']();
    power['suspend']();
    focusState({ running: false });
    clock += 30 * 1000;
    power['resume'](); // wake, but still on the lock screen
    assert.deepEqual(commands(), ['pause'], 'does not resume while still locked');
    power['unlock-screen']();
    assert.deepEqual(commands(), ['pause', 'resume']);

    focusState({ phase: 'short' });
    clearSent();
    power['lock-screen']();
    assert.deepEqual(commands(), [], 'breaks are left to run');
    power['unlock-screen']();

    click('Pause when the screen locks');
    freshSession();
    clearSent();
    power['lock-screen']();
    assert.deepEqual(commands(), [], 'switched off');
    power['unlock-screen']();
    click('Pause when the screen locks');
  });

  await test('daily goal: counted from history, announced when reached, and pushed to the orb', async () => {
    let r;
    do { r = await complete(); } while (r.done < 3);
    click('4 sessions');
    assert.equal(sentOf('settings').pop().dailyGoal, 4);
    r = await complete();
    assert.deepEqual([r.done, r.goal, r.goalHit], [4, 4, true]);
    assert.equal(sentOf('settings').pop().todayCount, 4, 'the orb is told the new count');
    r = await complete();
    assert.deepEqual([r.done, r.goalHit], [5, false], 'only announced once');
  });

  await test('intent: prompt appears on a hand-started session, picks a profile, shows in the tooltip, is recorded', async () => {
    freshSession();
    const prompt = byFile('intent.html');
    assert.ok(prompt, 'the prompt opened');
    assert.equal(prompt.opts.alwaysOnTop, true);
    assert.ok(prompt.opts.y < 800, 'placed above the orb when there is room');
    ipc.on['intent:submit']({ sender: orb().webContents }, 'sneaky');
    assert.equal(prompt.closed, false, 'only the prompt itself may answer it');
    ipc.on['intent:submit']({ sender: prompt.webContents }, '  coding the settings page  ');
    assert.equal(prompt.closed, true);
    assert.equal(savedSettings().profileId, 'coding');
    ipc.on['tooltip'](orbEv(), 'Focus: 24:10');
    assert.equal(tips[tips.length - 1], 'Focus: 24:10 (coding the settings page)');
    setWin('main.js - Code', 'Code');
    tickSeconds(30);
    await complete();
    const history = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'));
    const last = history[history.length - 1];
    assert.equal(last.intent, 'coding the settings page');
    assert.equal(last.profile, 'Coding');
    ipc.on['tooltip'](orbEv(), 'Focus: 25:00');
    assert.equal(tips[tips.length - 1], 'Focus: 25:00', 'cleared once the session is over');
    click('General');
  });

  await test('intent: skipped when focus starts automatically, switched off, or dismissed', () => {
    click('Start focus automatically');
    const before = windows.length;
    freshSession();
    assert.equal(windows.length, before, 'no prompt when sessions start by themselves');
    click('Start focus automatically');
    click('Ask what I am working on');
    freshSession();
    assert.equal(windows.length, before, 'no prompt when switched off');
    click('Ask what I am working on');
    freshSession();
    const prompt = byFile('intent.html');
    ipc.on['intent:cancel']({ sender: prompt.webContents });
    assert.equal(prompt.closed, true);
  });

  await test('stats window: aggregates, refuses strangers, exports a safe CSV', async () => {
    ipc.on['menu:show'](orbEv());
    lastMenu.template.find((i) => /^Stats \(/.test(i.label || '')).click();
    const stats = byFile('stats.html');
    assert.ok(stats);
    assert.equal(await ipc.handle['stats:get']({ sender: orb().webContents }), null);
    const a = await ipc.handle['stats:get']({ sender: stats.webContents });
    assert.equal(a.lastSession, savedSettings().lastSession, 'the last session summary now lives in Stats');
    const day = await ipc.handle['stats:day']({ sender: stats.webContents }, a.daily[a.daily.length - 1].date);
    assert.equal(day.sessions.length, a.today.sessions, 'a day opens with all its sessions');
    assert.equal(await ipc.handle['stats:day']({ sender: stats.webContents }, '../../etc'), null, 'only real dates');
    assert.equal(await ipc.handle['stats:day']({ sender: orb().webContents }, day.date), null, 'only the stats window may ask');
    assert.equal(a.today.sessions, 6);
    assert.equal(a.goal.goal, 4);
    assert.equal(a.streak, 1);
    assert.equal(a.topDistractions[0].label, 'reddit');

    assert.equal(await ipc.handle['stats:export']({ sender: orb().webContents }), null);
    saveDialog = { canceled: true };
    assert.deepEqual(await ipc.handle['stats:export']({ sender: stats.webContents }), { cancelled: true });
    const file = path.join(userData, 'out.csv');
    saveDialog = { canceled: false, filePath: file };
    const res = await ipc.handle['stats:export']({ sender: stats.webContents });
    assert.deepEqual([res.ok, res.count], [true, 6]);
    const csv = fs.readFileSync(file, 'utf8');
    assert.ok(csv.startsWith('\uFEFFdate,start,end,focus_min,intent,profile'), 'BOM so Excel reads accents, then the header');
    assert.ok(csv.includes('coding the settings page'));
    assert.equal(csv.trim().split('\r\n').length, 7);
  });

  await test('working through a break: nothing is said', () => {
    click('Coding');
    focusState({ phase: 'short' });
    setWin('main.js - Code', 'Code');
    idleSeconds = 0;
    clearSent();
    tickSeconds(200);
    assert.equal(sentOf('coach').length, 0);
    assert.equal(driftMessages().filter((m) => m.nudge).length, 0);
    click('General');
    freshSession();
  });

  await test('browser link: off until asked, secret stays private, extension folder written, URLs make rules precise', async () => {
    click('Set up…');
    const ext = byFile('extension.html');
    assert.ok(ext);
    assert.equal(await ipc.handle['ext:get']({ sender: orb().webContents }), null);
    let st = await ipc.handle['ext:get']({ sender: ext.webContents });
    assert.deepEqual([st.enabled, st.port, st.seen], [false, 0, null]);
    assert.equal(bridgeOpts, null, 'nothing is listening yet');

    // without the link, a vague title slips through
    freshSession();
    byFile('intent.html') && byFile('intent.html').close();
    setWin('Notifications - Google Chrome', 'chrome');
    clearSent();
    tickSeconds(40);
    assert.equal(driftMessages().filter((m) => m.nudge).length, 0);

    st = await ipc.handle['ext:enable']({ sender: ext.webContents }, true);
    assert.deepEqual([st.enabled, st.port], [true, 47615]);
    assert.ok(bridgeOpts.getToken().length >= 16);
    assert.equal((await ipc.handle['settings:get'](orbEv())).bridgeToken, undefined);

    const res = await ipc.handle['ext:install']({ sender: ext.webContents });
    assert.equal(res.ok, true);
    const cfg = JSON.parse(fs.readFileSync(path.join(res.dest, 'config.json'), 'utf8'));
    assert.deepEqual([cfg.port, cfg.token.length >= 16, cfg.token === bridgeOpts.getToken()], [47615, true, true]);
    ['manifest.json', 'background.js'].forEach((f) => assert.ok(fs.existsSync(path.join(res.dest, f))));
    assert.deepEqual(opened, [res.dest]);

    // the extension reports the real address of the tab in front
    bridgeOpts.onTab({ url: 'https://x.com/notifications', title: 'Notifications' });
    clearSent();
    tickSeconds(40);
    const nudge = driftMessages().find((m) => m.nudge === 'off-topic');
    assert.ok(nudge, 'x.com is caught by address');
    assert.equal(nudge.label, 'x.com');
    st = await ipc.handle['ext:get']({ sender: ext.webContents });
    assert.equal(st.seen.host, 'x.com');

    // the profile editor offers site-level buttons
    const editor = byFile('profiles.html');
    const live = (await ipc.handle['profiles:get']({ sender: editor.webContents })).live;
    assert.equal(live.host, 'x.com');

    // clicking to another page on an allowed site: the title changes a moment before the
    // address arrives, and that moment must not count as off task, here or in the log
    click('Coding');
    const coding = savedSettings().profiles.find((p) => p.id === 'coding');
    const allowSite = coding.allow.concat('url:portal.example.com');
    await ipc.handle['profiles:save']({ sender: editor.webContents }, { profiles: savedSettings().profiles.map((p) => (p.id === 'coding' ? { ...p, allow: allowSite } : p)), activeId: 'coding' });
    freshSession();
    await complete();
    focusState({});
    bridgeOpts.onTab({ url: 'https://portal.example.com/dashboard', title: 'Dashboard — Admin Portal' });
    setWin('Dashboard — Admin Portal and 5 more pages - Work - Microsoft Edge', 'msedge');
    tickSeconds(20);
    for (const page of ['Elevation Requests', 'Elevation Rules', 'Dashboard', 'Approvals']) {
      setWin(`${page} — Admin Portal and 5 more pages - Work - Microsoft Edge`, 'msedge');
      tickSeconds(1); // the watcher is quicker than the extension
      bridgeOpts.onTab({ url: `https://portal.example.com/${page.toLowerCase().replace(/ /g, '-')}`, title: `${page} — Admin Portal` });
      tickSeconds(20);
    }
    const nav = await complete();
    assert.ok(nav.text.startsWith('100% on task. No drifting.'), `page changes on an allowed site cost nothing: ${nav.text}`);
    const log = (await ipc.handle['profiles:get']({ sender: editor.webContents })).live.recent;
    assert.ok(log.filter((r) => r.process === 'msedge').every((r) => r.cls === 'on'), 'and the log shows them on task');
    assert.equal(log[0].host, 'portal.example.com');

    // with no address at all, the title is used after a short wait, so nothing slips through for long
    setWin('Some other page - Work - Microsoft Edge', 'msedge');
    tickSeconds(2);
    assert.equal((await ipc.handle['profiles:get']({ sender: editor.webContents })).live.why, 'pending');
    tickSeconds(3);
    assert.equal((await ipc.handle['profiles:get']({ sender: editor.webContents })).live.cls, 'off', 'judged by title once the wait is over');
    click('General');

    // a non-browser window is never matched against tab titles
    setWin('Notifications', 'notepad');
    clearSent();
    tickSeconds(30);
    assert.equal(driftMessages().filter((m) => m.nudge).length, 0);

    // blocking sites during focus: off unless asked for, and then only in a running focus session
    ['blocked.html', 'blocked.css', 'blocked.js'].forEach((f) => assert.ok(fs.existsSync(path.join(res.dest, f)), `${f} is installed`));
    const yt = { url: 'https://www.youtube.com/watch?v=1', title: 'cats - YouTube' };
    freshSession();
    assert.equal(bridgeOpts.onCheck(yt), null, 'off by default');
    assert.equal(savedSettings().blockInFocus === true, false);
    await setSetting({ blockInFocus: true });
    const endAt = Date.now() + 20 * 60000;
    focusState({ endAt });
    const v = bridgeOpts.onCheck(yt);
    assert.deepEqual(v, { rule: 'youtube', host: 'youtube.com', until: endAt }, 'a blocked site is turned away, with when focus ends');
    assert.deepEqual(bridgeOpts.onTab(yt), v, 'the regular report carries the same answer');
    assert.equal(bridgeOpts.onCheck({ url: 'https://github.com/', title: 'GitHub' }), null, 'other sites are fine');
    assert.equal(bridgeOpts.onCheck({ url: 'edge://newtab/', title: 'New tab' }), null, 'browser pages are never touched');
    focusState({ running: false });
    assert.equal(bridgeOpts.onCheck(yt), null, 'not while paused');
    focusState({ endAt });
    click('10 minutes');
    assert.equal(bridgeOpts.onCheck(yt), null, 'not during a detour');
    click(find('Allow a detour').submenu.find((i) => i.label && i.label.startsWith('End detour')).label);
    assert.ok(bridgeOpts.onCheck(yt), 'back once the detour ends');
    focusState({ phase: 'short' });
    assert.equal(bridgeOpts.onCheck(yt), null, 'not during a break');
    focusState({ phase: 'long' });
    assert.equal(bridgeOpts.onCheck(yt), null, 'nor a long one');
    await setSetting({ blockInFocus: false });
    freshSession();

    // a drift in the browser is named for the site, on the orb and in the saved session
    click('Coding');
    freshSession();
    bridgeOpts.onTab({ url: 'https://news.example.com/story/1', title: 'Big story' });
    setWin('Big story - Work - Microsoft Edge', 'msedge');
    clearSent();
    tickSeconds(70);
    const siteNudge = driftMessages().find((m) => m.nudge === 'off-topic');
    assert.ok(siteNudge, 'off task: not on the Coding allow list');
    assert.equal(siteNudge.label, 'news.example.com', 'named for the site, not "msedge"');
    const siteSession = await complete();
    assert.match(siteSession.text, /news\.example\.com/);
    const hist = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'));
    assert.equal(hist[hist.length - 1].distractions[0].label, 'news.example.com');
    click('General');

    const before = cfg.token;
    assert.deepEqual(await ipc.handle['ext:newtoken']({ sender: ext.webContents }), { ok: true });
    const after = JSON.parse(fs.readFileSync(path.join(res.dest, 'config.json'), 'utf8')).token;
    assert.notEqual(after, before);
    assert.equal(after, bridgeOpts.getToken(), 'the listener uses the new secret straight away');

    st = await ipc.handle['ext:enable']({ sender: ext.webContents }, false);
    assert.equal(st.enabled, false);
    assert.ok(bridgeStops >= 1, 'the listener is shut down');
    setWin('Notifications - Google Chrome', 'chrome');
    freshSession();
    clearSent();
    tickSeconds(40);
    assert.equal(driftMessages().filter((m) => m.nudge).length, 0, 'addresses are no longer used once the link is off');
  });

  const inShape = (w, x, y) => w.shape.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);

  if (!process.env.NO_SHAPE) {
    await test('click-through: the window is shaped to the planet and ring, with no polling or mouse hook', () => {
      const w = orb();
      assert.ok(w.shape && w.shape.length > 20, 'a shape is set');
      assert.equal(w.ignore, undefined, 'never switches mouse events off');
      assert.equal(inShape(w, 152, 152), true, 'the planet takes clicks');
      assert.equal(inShape(w, 3, 3), false, 'a transparent corner does not');
      assert.equal(inShape(w, 300, 3), false, 'nor the other corner');
      assert.equal(inShape(w, 152, 40), false, 'nor the empty space above the planet');
      const ring = inShape(w, 152 + 94 * Math.cos((22 * Math.PI) / 180), 152 - 94 * Math.sin((22 * Math.PI) / 180));
      assert.equal(ring, true, 'the ring end takes clicks');
    });

    await test('a page zoom left over from 1.1 is reset, so the orb lines up with its shape', () => {
      const wc = orb().webContents;
      wc.zoom = 0.75; // what 1.1 left behind after picking Small
      wc.emit('did-finish-load');
      assert.equal(wc.zoom, 1, 'reset on load');
      wc.zoom = 1.35;
      wc.emit('zoom-changed');
      assert.equal(wc.zoom, 1, 'and if anything zooms it later');
    });

    await test('the shape is in DIPs and does not change with display scaling (Chromium scales it)', () => {
      const w = orb();
      const before = JSON.stringify(w.shape);
      displaySf = 1.25;
      click('Large');
      click('Medium');
      displaySf = 1;
      assert.equal(JSON.stringify(w.shape), before);
      const top = Math.min(...w.shape.map((q) => q.y));
      assert.ok(top <= 152 - 98, 'the shape reaches above the goal counter (93 px above centre)');
    });

    await test('the shape follows the size and the theme', () => {
      const w = orb();
      const before = w.shapes;
      const area = () => w.shape.reduce((n, r) => n + r.width * r.height, 0);
      const medium = area();
      click('Large');
      assert.ok(w.shapes > before, 'resizing reshapes');
      assert.ok(area() > medium * 1.5, 'at Large the shape is bigger');
      click('Medium');
      assert.equal(area(), medium, 'and back to the same at Medium');
      click('Liquid');
      assert.equal(inShape(w, 152 + 80, 152), true, 'the liquid sphere is wider than the planet');
      assert.equal(inShape(w, 152 + 105, 152 + 40), false, 'and has no ring');
      click('Ember (default)');
    });
  } else {
    await test('click-through fallback: with no window shape the pointer is checked instead', async () => {
      assert.deepEqual(orb().ignore, { v: true, o: undefined }, 'starts click-through, without the forwarding hook');
      const b = orb().getBounds();
      const settle = () => new Promise((r) => setTimeout(r, 120));
      cursor = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      await settle();
      assert.equal(orb().ignore.v, false, 'pointer over the planet: the window takes clicks');
      cursor = { x: b.x + 4, y: b.y + 4 };
      await settle();
      assert.equal(orb().ignore.v, true, 'pointer over a transparent corner: clicks pass through');
      cursor = { x: b.x - 500, y: b.y };
      await settle();
      assert.equal(orb().ignore.v, true, 'pointer outside the window: clicks pass through');
    });
  }

  await test('a quiet or empty watcher report is never judged, and is not kept as the last window', async () => {
    freshSession();
    setWin('cats - YouTube', 'chrome');
    watcherOpts.onWindow(null); // the watcher went quiet
    clearSent();
    tickSeconds(40);
    assert.equal(driftMessages().filter((m) => m.nudge).length, 0, 'nothing judged while the watcher is quiet');
    watcherOpts.onWindow({ title: '', process: '', pid: 0 }); // nothing in front
    tickSeconds(40);
    assert.equal(driftMessages().filter((m) => m.nudge).length, 0, 'nor when no window has focus');
    click('Edit profiles…');
    const editor = byFile('profiles.html');
    const live = (await ipc.handle['profiles:get']({ sender: editor.webContents })).live;
    assert.equal(live.process, 'chrome', 'the editor still shows the last real window');
    editor.close();
    freshSession();
  });

  await test('start-up health: a broken window watcher is said once, and shown at the top of the menu', () => {
    Notification.shown.length = 0;
    watcherStatus = 'unavailable';
    tickSeconds(30);
    const said = Notification.shown.filter((n) => n.title === 'Window watcher not running');
    assert.equal(said.length, 1, 'one notification');
    tickSeconds(30);
    assert.equal(Notification.shown.filter((n) => n.title === 'Window watcher not running').length, 1, 'and only once');
    ipc.on['menu:show'](orbEv());
    assert.equal(lastMenu.template[0].label, '⚠ Window watcher not running');
    watcherStatus = 'ok';
    ipc.on['menu:show'](orbEv());
    assert.notEqual(lastMenu.template[0].label.slice(0, 1), '⚠', 'gone from the menu once it is running');
  });

  await test('quick block and allow from the menu follow the last real window and the profile in use', () => {
    click('General');
    const menuLabels = () => { ipc.on['menu:show'](orbEv()); return lastMenu.template.map((i) => i.label || ''); };
    setWin('An unknown page - Google Chrome', 'chrome');
    assert.ok(!menuLabels().some((l) => /\(General\)$/.test(l)), 'never offers to block a whole browser');
    setWin('Spotify Premium', 'Spotify');
    assert.ok(menuLabels().includes('Block Spotify (General)'));
    setWin('', '', process.pid); // the orb itself, then the shell: the last real window is still Spotify
    setWin('Program Manager', 'explorer');
    click('Block Spotify (General)');
    const general = () => savedSettings().profiles.find((p) => p.id === 'general');
    assert.ok(general().block.includes('app:spotify'));
    assert.ok(menuLabels().includes('Unblock spotify (General)'), 'and it can be undone');
    click('Unblock spotify (General)');
    assert.ok(!general().block.includes('app:spotify'));
    click('Coding');
    setWin('Spotify Premium', 'Spotify');
    assert.ok(menuLabels().includes('Allow Spotify (Coding)'), 'with an allow list, off-task apps can be allowed');
    click('Allow Spotify (Coding)');
    assert.ok(savedSettings().profiles.find((p) => p.id === 'coding').allow.includes('app:spotify'));
    click('General');
  });

  await test('profile timings replace the usual ones while that profile is in use', async () => {
    click('Edit profiles…');
    const editor = byFile('profiles.html');
    const got = await ipc.handle['profiles:get']({ sender: editor.webContents });
    assert.deepEqual(got.timing, { focus: savedSettings().focus, short: savedSettings().short, long: savedSettings().long }, 'the editor knows the usual timings');
    const edited = got.profiles.map((p) => (p.id === 'writing' ? { ...p, timing: { focus: 50, short: 10 } } : p));
    await ipc.handle['profiles:save']({ sender: editor.webContents }, { profiles: edited, activeId: 'general' });
    clearSent();
    click('Writing');
    const s = sentOf('settings').pop();
    assert.equal(s.focus, 50);
    assert.equal(s.short, 10);
    assert.equal(s.long, savedSettings().long, 'gaps are filled from the usual timings');
    assert.equal(savedSettings().focus, 25, 'the usual timings are untouched');
    const pt = ipc.handle['settings:all']({ sender: settingsWin().webContents }).profileTiming;
    assert.deepEqual([pt.name, pt.focus, pt.short], ['Writing', 50, 10], 'the settings window says so');
    click('General');
    assert.equal(sentOf('settings').pop().focus, 25);
    editor.close();
  });

  await test('keyboard shortcuts: five by default, a taken one is reported, and they can be turned off', () => {
    assert.deepEqual([...shortcuts].sort(), ['Control+Alt+D', 'Control+Alt+N', 'Control+Alt+O', 'Control+Alt+P', 'Control+Alt+R']);
    takenKeys = ['Control+Alt+N'];
    click('Use keyboard shortcuts');
    click('Use keyboard shortcuts');
    assert.equal(ipc.handle['settings:all']({ sender: settingsWin().webContents }).shortcuts.find((k) => k.label === 'Skip to next').state, 'taken');
    takenKeys = [];
    click('Use keyboard shortcuts');
    assert.deepEqual([...shortcuts], ['Control+Alt+P'], 'start and pause always stays');
    click('Use keyboard shortcuts');
    assert.equal(shortcuts.size, 5);
  });

  await test('full-screen apps hide the orb until they are gone, without stealing focus on the way back', () => {
    const w = orb();
    w.visible = true;
    watcherOpts.onWindow({ title: 'Game', process: 'game', pid: 900, fs: true });
    assert.equal(w.visible, false, 'hidden');
    const before = w.inactive || 0;
    watcherOpts.onWindow({ title: 'main.js - Code', process: 'Code', pid: 901, fs: false });
    assert.equal(w.visible, true, 'back');
    assert.equal(w.inactive, before + 1, 'shown without focus');
    click('Hide during full-screen apps');
    watcherOpts.onWindow({ title: 'Game', process: 'game', pid: 900, fs: true });
    assert.equal(w.visible, true, 'switched off: stays put');
    click('Hide during full-screen apps');
    assert.equal(w.visible, false, 'switched back on while a game is up: hides');
    watcherOpts.onWindow({ title: 'main.js - Code', process: 'Code', pid: 901, fs: false });
    assert.equal(w.visible, true);
  });

  await test('apps on the hide list hide the orb while they are in front, full screen or not', async () => {
    const w = orb();
    w.visible = true;
    assert.deepEqual((await ipc.handle['settings:all']({ sender: settingsWin().webContents })).values.hideApps, [], 'empty to begin with');
    watcherOpts.onWindow({ title: 'Scene 1 - OBS 30.2', process: 'obs64', pid: 910, fs: false });
    watcherOpts.onWindow({ title: 'main.js - Code', process: 'Code', pid: 901, fs: false });
    const snap = await ipc.handle['settings:all']({ sender: settingsWin().webContents });
    assert.deepEqual(snap.recentApps.slice(0, 2).map((a) => a.name), ['code', 'obs64'], 'apps used lately are offered, newest first');
    assert.equal(snap.recentApps[1].title, 'Scene 1 - OBS 30.2');
    assert.ok(!snap.recentApps.some((a) => a.name === 'explorer'), 'nothing from the shell');

    const res = await setSetting({ hideApps: ['OBS64.exe', 'obs64', '', '../evil', 'vlc'] });
    assert.deepEqual(res.values.hideApps, ['obs64', 'vlc'], 'names are tidied, repeats and junk dropped');
    assert.equal(w.visible, true, 'Code is in front: stays');
    clearSent();
    watcherOpts.onWindow({ title: 'Scene 1 - OBS 30.2', process: 'obs64', pid: 910, fs: false });
    assert.equal(w.visible, false, 'OBS in front: hidden');
    assert.deepEqual(commands(), ['hidden'], 'and the orb is told, so it stops drawing');
    const before = w.inactive || 0;
    watcherOpts.onWindow({ title: 'main.js - Code', process: 'Code', pid: 901, fs: false });
    assert.equal(w.visible, true, 'back when OBS is not in front');
    assert.equal(commands().pop(), 'shown', 'and told it is seen again');
    assert.equal(w.inactive, before + 1, 'without taking focus');

    click('Hide during full-screen apps');
    watcherOpts.onWindow({ title: 'film.mkv - VLC', process: 'vlc', pid: 911, fs: false });
    assert.equal(w.visible, false, 'the list works with full-screen hiding switched off');
    await setSetting({ hideApps: ['obs64'] });
    assert.equal(w.visible, true, 'taken off the list while it is up: back at once');
    click('Hide during full-screen apps');
    await setSetting({ hideApps: [] });
    watcherOpts.onWindow({ title: 'main.js - Code', process: 'Code', pid: 901, fs: false });
  });

  await test('the new themes have no ring, so their click area is the disc alone, and choosing one previews its sound', () => {
    const w = orb();
    const ringEnd = [152 + 108 * Math.cos((22 * Math.PI) / 180), 152 - 108 * Math.sin((22 * Math.PI) / 180)]; // beyond the disc, on the ring
    clearSent();
    click('Tomato');
    assert.ok(commands().includes('preview-chime'), 'its chime is played');
    if (!process.env.NO_SHAPE) {
      assert.equal(inShapeAt(w, ringEnd[0], ringEnd[1]), false, 'no ring band');
      assert.equal(inShapeAt(w, 152, 152), true);
    }
    click('Ember (default)');
    if (!process.env.NO_SHAPE) assert.equal(inShapeAt(w, ringEnd[0], ringEnd[1]), true, 'the planets keep theirs');
  });

  await test('dragging across screens with different scaling keeps the orb under the pointer, and reshapes it there', () => {
    const w = orb();
    w.pos = [900, 400];
    cursor = { x: 1000, y: 500 };
    const shapesBefore = w.shapes || 0;
    ipc.on['drag:start'](orbEv());
    cursor = { x: 1500, y: 500 };
    ipc.on['drag:move'](orbEv());
    assert.deepEqual(w.pos, [1400, 400], 'on the first screen it simply follows');
    // the pointer is now 480 physical pixels into the 150% screen
    cursor = { x: 1920 + 480 / 1.5, y: 500 / 1.5 };
    ipc.on['drag:move'](orbEv());
    // the grab point was 100 window units in from the corner; on a 150% screen that is
    // 150 real pixels, so the corner sits at 2400 - 150 = 2250 real, 2140 in window units
    assert.ok(Math.abs(w.pos[0] - 2140) <= 1, `x ${w.pos[0]} should be about 2140`);
    assert.ok(Math.abs(w.pos[1] - (350 / 1.5)) <= 1, `y ${w.pos[1]} should be about 233`);
    assert.ok(Math.abs(cursor.x - w.pos[0] - 100) <= 1, 'the pointer is still on the spot it grabbed');
    // and back again
    cursor = { x: 1500, y: 500 };
    ipc.on['drag:move'](orbEv());
    assert.deepEqual(w.pos, [1400, 400], 'back on the first screen it lands where it would have');
    cursor = { x: 1920 + 480 / 1.5, y: 500 / 1.5 };
    ipc.on['drag:move'](orbEv());
    ipc.on['drag:end'](orbEv());
    if (!process.env.NO_SHAPE) assert.ok(w.shapes > shapesBefore, 'the shape is redone for the new screen');
    w.pos = null;
    cursor = { x: 0, y: 0 };
  });

  await test('security: windows only use their own channels, and pages can do nothing a browser tab could', async () => {
    const stranger = { sender: { id: 'not-ours' } };
    const savedSessions = () => { try { return JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8')); } catch (e) { return []; } };
    const before = savedSessions().length;
    assert.equal(await ipc.handle['session:complete'](stranger, { minutes: 50 }), null, 'only the orb can record a session');
    assert.equal(savedSessions().length, before);
    assert.equal(await ipc.handle['settings:get'](stranger), null);
    const w = orb();
    const pos = w.pos;
    ipc.on['drag:start'](stranger);
    cursor = { x: 50, y: 50 };
    ipc.on['drag:move'](stranger);
    assert.equal(w.pos, pos, 'and only the orb can move itself');
    ipc.on['state'](stranger, { running: false, phase: 'short' });
    ipc.on['notify'](orbEv(), null); // junk from the orb is shrugged off, not a crash
    ipc.on['notify'](stranger, { title: 'x', body: 'y' });
    cursor = { x: 0, y: 0 };

    // browser permissions: always no
    let answer = null;
    guards.permission(null, 'media', (ok) => (answer = ok));
    assert.equal(answer, false);
    assert.equal(guards.check(null, 'notifications'), false);

    // every web contents, including ones made later, is fenced in
    const ev = {};
    const contents = { on: (n, fn) => (ev[n] = fn), setWindowOpenHandler: (fn) => (ev.open = fn) };
    appEvents['web-contents-created']({}, contents);
    ['will-navigate', 'will-redirect', 'will-attach-webview'].forEach((n) => {
      let stopped = false;
      ev[n]({ preventDefault: () => (stopped = true) });
      assert.ok(stopped, `${n} is stopped`);
    });
    assert.deepEqual(ev.open({ url: 'https://example.com' }), { action: 'deny' });
  });

  await test('the log: written from the start, opened from Settings, and never holds titles or addresses', async () => {
    const file = path.join(userData, 'logs', 'focus-orb.log');
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /info  Focus Orb .* starting/);
    assert.match(text, /Browser link listening on 127\.0\.0\.1:47615/);
    // by this point the tests have shown it YouTube, x.com, Teams calls, intents and more
    ['YouTube', 'youtube.com', 'x.com', 'Notifications', 'Microsoft Teams', 'Admin Portal', 'news.example.com', 'main.js - Code'].forEach((t) =>
      assert.ok(!text.includes(t), `no "${t}" in the log`));
    opened.length = 0;
    await ipc.handle['settings:action']({ sender: settingsWin().webContents }, 'open-log');
    assert.deepEqual(opened, [file]);
  });

  await test('the window never changes size: scaling is done inside the page', () => {
    const w = orb();
    assert.equal(w.opts.width, 304);
    assert.equal(w.opts.height, 304);
    let resized = 0;
    w.setBounds = () => { resized++; };
    click('Large');
    assert.equal(resized, 0, 'no setBounds call when the size changes');
    const last = w.webContents.sent.filter((m) => m[0] === 'settings').pop();
    assert.equal(last[1].scale, 1.35);
    click('Medium');
  });

  await test('drift toast: one Windows notification when a drift starts, not on every repeat, and it can be switched off', () => {
    click('General');
    freshSession();
    byFile('intent.html') && byFile('intent.html').close();
    setWin('cats - YouTube', 'chrome');
    Notification.shown.length = 0;
    tickSeconds(25);
    let toasts = Notification.shown.filter((n) => /^Off task/.test(n.title));
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].title, 'Off task: youtube');
    tickSeconds(400);
    assert.ok(driftMessages().filter((m) => m.nudge).length >= 4, 'the dings keep repeating');
    toasts = Notification.shown.filter((n) => /^Off task/.test(n.title));
    assert.equal(toasts.length, 1, 'but the toast does not');

    setWin('main.js - Code', 'Code');
    tickSeconds(100); // longer than the repeat gap, so only the switch under test can stop a toast
    setWin('cats - YouTube', 'chrome');
    Notification.shown.length = 0;
    tickSeconds(25);
    assert.equal(Notification.shown.filter((n) => /^Off task/.test(n.title)).length, 1, 'a fresh drift gets a fresh toast');

    click('Notify when I drift');
    setWin('main.js - Code', 'Code');
    tickSeconds(100); // longer than the repeat gap, so only the switch under test can stop a toast
    setWin('cats - YouTube', 'chrome');
    Notification.shown.length = 0;
    tickSeconds(25);
    assert.equal(Notification.shown.length, 0, 'switched off');
    click('Notify when I drift');

    click('Desktop notification'); // the master switch silences it as well
    setWin('main.js - Code', 'Code');
    tickSeconds(100); // longer than the repeat gap, so only the switch under test can stop a toast
    setWin('cats - YouTube', 'chrome');
    Notification.shown.length = 0;
    tickSeconds(25);
    assert.equal(Notification.shown.length, 0);
    click('Desktop notification');
  });

  await test('dings: the count is a setting, picking one plays a preview, the old on/off switch migrates', () => {
    clearSent();
    click('5 dings');
    assert.equal(sentOf('settings').pop().nudgeDings, 5);
    assert.ok(commands().includes('preview'), 'you hear what you picked');
    assert.equal(savedSettings().nudgeDings, 5);
    click('Again every 30 s');
    assert.equal(savedSettings().repeatSec, 30);
    click('3 dings');
    click('Again every 90 s');
  });

  await test('themes: the menu lists them, the choice reaches the orb and is remembered', () => {
    const items = find('Theme').submenu.filter((i) => i.type === 'checkbox').map((i) => i.label);
    assert.equal(find('Theme').submenu.filter((i) => i.checked).length, 1, 'exactly one theme is ticked');
    assert.ok(!find('Theme').submenu.some((i) => i.type === 'radio'), 'no radio groups for Windows to fill in by itself');
    assert.deepEqual(items, ['Ember (default)', 'Ocean', 'Aurora', 'Dusk', 'Graphite', 'Plasma core', 'Liquid',
      'Reactor Core', 'Hologlobe', 'Hex Shield', 'Warp Gate', 'Dyson Sphere',
      'Tomato', 'Hourglass', 'Candle', 'Ens\u014d', 'Seedling', 'Ring', 'Lava lamp', 'Tea', 'Coffee']);
    const headings = find('Theme').submenu.filter((i) => i.enabled === false).map((i) => i.label);
    assert.deepEqual(headings, ['Planets', 'Future', 'Other things']);
    clearSent();
    click('Liquid');
    assert.equal(sentOf('settings').pop().theme, 'liquid');
    assert.equal(savedSettings().theme, 'liquid');
    click('Ember (default)');
    assert.equal(savedSettings().theme, 'ember');
  });

  await test('profile import and export: only the editor may use them, files are safe, nothing is overwritten', async () => {
    click('Edit profiles…');
    const editor = byFile('profiles.html');
    assert.equal(await ipc.handle['profiles:export']({ sender: orb().webContents }, { scope: 'all' }), null);
    assert.equal(await ipc.handle['profiles:import']({ sender: orb().webContents }), null);

    saveDialog = { canceled: true };
    assert.deepEqual(await ipc.handle['profiles:export']({ sender: editor.webContents }, { scope: 'all' }), { cancelled: true });

    const one = path.join(userData, 'one.json');
    const all = path.join(userData, 'all.json');
    saveDialog = { canceled: false, filePath: one };
    let r = await ipc.handle['profiles:export']({ sender: editor.webContents }, { scope: 'one', id: 'coding' });
    assert.deepEqual([r.ok, r.count], [true, 1]);
    const oneFile = JSON.parse(fs.readFileSync(one, 'utf8'));
    assert.deepEqual(oneFile.profiles.map((p) => p.name), ['Coding']);
    assert.equal(oneFile.profiles[0].id, undefined);
    saveDialog = { canceled: false, filePath: all };
    r = await ipc.handle['profiles:export']({ sender: editor.webContents }, { scope: 'all' });
    assert.equal(r.count, JSON.parse(fs.readFileSync(all, 'utf8')).profiles.length);

    // importing what we just exported changes nothing
    const before = savedSettings().profiles;
    openDialog = { canceled: false, filePaths: [all] };
    r = await ipc.handle['profiles:import']({ sender: editor.webContents });
    assert.deepEqual([r.ok, r.added, r.skipped], [true, 0, before.length]);
    assert.deepEqual(savedSettings().profiles, before);

    // a new profile, and one that clashes by name
    const shared = path.join(userData, 'shared.json');
    fs.writeFileSync(shared, JSON.stringify({
      format: 'focus-orb-profiles', version: 1,
      profiles: [
        { name: 'Reading', allow: ['app:kindle'], block: ['reddit'], id: 'general' },
        { name: 'Coding', allow: ['app:vim'], block: [] },
      ],
    }));
    const activeBefore = savedSettings().profileId;
    openDialog = { canceled: false, filePaths: [shared] };
    r = await ipc.handle['profiles:import']({ sender: editor.webContents });
    assert.deepEqual([r.ok, r.added, r.renamed], [true, 2, 1]);
    const names = savedSettings().profiles.map((p) => p.name);
    assert.ok(names.includes('Reading') && names.includes('Coding (imported)'));
    assert.deepEqual(savedSettings().profiles.find((p) => p.id === 'coding'), before.find((p) => p.id === 'coding'), 'the original Coding is untouched');
    assert.equal(savedSettings().profileId, activeBefore, 'importing never changes the active profile');
    assert.ok(r.profiles.some((p) => p.name === 'Reading'), 'the editor is handed the new list');
    assert.ok(sentOf('settings').length >= 0);

    // bad files are refused with a reason, and nothing changes
    const bad = path.join(userData, 'bad.txt');
    const count = savedSettings().profiles.length;
    fs.writeFileSync(bad, 'hello');
    openDialog = { canceled: false, filePaths: [bad] };
    assert.equal((await ipc.handle['profiles:import']({ sender: editor.webContents })).error, 'not-json');
    fs.writeFileSync(bad, JSON.stringify({ some: 'other json' }));
    assert.equal((await ipc.handle['profiles:import']({ sender: editor.webContents })).error, 'not-profiles');
    fs.writeFileSync(bad, 'x'.repeat(300000));
    assert.equal((await ipc.handle['profiles:import']({ sender: editor.webContents })).error, 'too-big');
    openDialog = { canceled: false, filePaths: [path.join(userData, 'missing.json')] };
    assert.equal((await ipc.handle['profiles:import']({ sender: editor.webContents })).error, 'read');
    openDialog = { canceled: true };
    assert.deepEqual(await ipc.handle['profiles:import']({ sender: editor.webContents }), { cancelled: true });
    assert.equal(savedSettings().profiles.length, count);
  });

  await test('after an app update, installed extension files are refreshed and the listener says which version it wants', async () => {
    const dir = path.join(userData, 'browser-extension');
    assert.ok(fs.existsSync(dir), 'the extension folder was written earlier');
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version, manifest.version);
    assert.equal(typeof bridgeOpts.extVersion, 'function');
    assert.equal(bridgeOpts.extVersion(), manifest.version);
  });

  await test('recent windows: what the orb saw and how it judged each, newest first, for the profile editor', async () => {
    click('General');
    setWin('cats - YouTube', 'chrome');
    tickSeconds(4);
    setWin('Weekly meeting | Microsoft Teams', 'ms-teams');
    tickSeconds(2);
    setWin('main.js - Code', 'Code');
    tickSeconds(2);
    click('Edit profiles…');
    const editor = byFile('profiles.html');
    const live = (await ipc.handle['profiles:get']({ sender: editor.webContents })).live;
    assert.deepEqual(live.recent.slice(0, 3).map((r) => [r.process, r.cls, r.why === 'meeting']), [
      ['Code', 'on', false],
      ['ms-teams', 'neutral', true],
      ['chrome', 'off', false],
    ]);
    editor.close();
  });

  await test('the first seconds of a call are not counted as off task, even with an Allow list', async () => {
    click('Coding'); // has an Allow list that does not include Teams
    freshSession();
    await complete();
    focusState({});
    setWin('main.js - Code', 'Code');
    tickSeconds(30);
    setWin('Weekly meeting | Microsoft Teams', 'ms-teams');
    tickSeconds(14);
    setWin('main.js - Code', 'Code');
    tickSeconds(30);
    const r = await complete();
    assert.equal(r.text.startsWith('100% on task. No drifting.'), true, r.text);
    click('General');
  });

  await test('finish session now: only once a session has started, and it is recorded with the time actually spent', async () => {
    focusState({ started: false, running: false });
    ipc.on['menu:show'](orbEv());
    assert.equal(lastMenu.template.find((i) => i.label === 'Finish session now').enabled, false, 'nothing to finish yet');
    focusState({});
    ipc.on['menu:show'](orbEv());
    clearSent();
    lastMenu.template.find((i) => i.label === 'Finish session now').click();
    assert.ok(commands().includes('finish'), 'the orb is told to finish');
    await ipc.handle['session:complete'](orbEv(), { minutes: 12 });
    const history = JSON.parse(fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8'));
    assert.equal(history[history.length - 1].focusMin, 12, 'counted as 12 minutes, not the full length');
    focusState({ phase: 'short' });
    ipc.on['menu:show'](orbEv());
    assert.ok(lastMenu.template.some((i) => i.label === 'End break now'), 'in a break it ends the break');
    focusState({ phase: 'focus', started: false, running: false });
  });

  if (process.env.DUMP_MENU) {
    const out = [];
    const walk = (items, depth) => items.forEach((i) => {
      if (i.type === 'separator') { out.push(`${'  '.repeat(depth)}----`); return; }
      const mark = i.type === 'radio' ? (i.checked ? '(o) ' : '( ) ') : i.type === 'checkbox' ? (i.checked ? '[x] ' : '[ ] ') : '';
      out.push(`${'  '.repeat(depth)}${mark}${i.label}${i.enabled === false ? '   {grey}' : ''}${i.accelerator ? `   <${i.accelerator}>` : ''}${i.submenu ? '  >' : ''}`);
      if (i.submenu) walk(i.submenu, depth + 1);
    });
    ipc.on['menu:show'](orbEv());
    walk(lastMenu.template, 0);
    fs.writeFileSync(process.env.DUMP_MENU, out.join('\n'));
  }
  console.log(`\n${passed} smoke tests passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
