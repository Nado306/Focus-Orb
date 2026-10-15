'use strict';
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  Notification,
  globalShortcut,
  nativeImage,
  nativeTheme,
  powerMonitor,
  screen,
  dialog,
  shell,
  session,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const { createStartup } = require('./startup.js');
const { createLog } = require('./log.js');
const U = require('./updater.js');
const E = require('./engine.js');
const D = require('./distraction.js');
const S = require('./stats.js');
const { createWatcher } = require('./watcher.js');
const { createBridge } = require('./bridge.js');

const ORB = 220; // the orb's size in px at scale 1
const MAXSCALE = 1.35;
const WIN = 304; // fixed window size; the orb (220 x up to 1.35) is scaled inside it, centred (see style.css #stage)
const SHORTCUT = 'Control+Alt+P';
const LOCK_RESUME_MS = 3 * 60 * 1000; // locked for less than this: resume by itself on unlock

const DEFAULTS = {
  focus: 25,
  short: 5,
  long: 15,
  rounds: 4,
  sound: true,
  notifications: true,
  driftToast: true,
  blockInFocus: false,
  autoBreak: true,
  autoFocus: false,
  onTop: true,
  scale: 1,
  theme: 'ember',
  dailyGoal: 6,
  shortcuts: true,
  hideFullscreen: true,
  hideApps: [], // process names, e.g. 'obs64': the orb hides while one of these is in front
  autoUpdate: true, // the installed copy checks for, downloads and installs new versions
  // distraction
  distractEnabled: true,
  nudgeDings: 3,
  repeatSec: 90,
  graceSec: 20,
  idleMin: 2,
  switchLimit: 12,
  meetingMode: 'neutral', // neutral | pause | off
  pauseOnLock: true,
  askIntent: true,
  profileId: 'general',
  profiles: D.DEFAULT_PROFILES,
  lastSession: '',
  // browser link
  bridgeOn: false,
  bridgeToken: '',
  bridgePort: 47615,
  // bookkeeping
  x: null,
  y: null,
};

// Settings the timer window never needs to see.
const PRIVATE_KEYS = ['x', 'y', 'profiles', 'lastSession', 'bridgeOn', 'bridgeToken', 'bridgePort'];
const THEMES = {
  ember: 'Ember (default)',
  ocean: 'Ocean',
  aurora: 'Aurora',
  dusk: 'Dusk',
  graphite: 'Graphite',
  plasma: 'Plasma core',
  liquid: 'Liquid',
  // not planets
  tomato: 'Tomato',
  hourglass: 'Hourglass',
  candle: 'Candle',
  enso: 'Ens\u014d',
  seedling: 'Seedling',
  ring: 'Ring',
  lava: 'Lava lamp',
  tea: 'Tea',
  coffee: 'Coffee',
  // the future
  reactor: 'Reactor Core',
  hologlobe: 'Hologlobe',
  hexshield: 'Hex Shield',
  warpgate: 'Warp Gate',
  dyson: 'Dyson Sphere',
};
const FUTURE_THEMES = ['reactor', 'hologlobe', 'hexshield', 'warpgate', 'dyson'];
const PLANET_THEMES = ['ember', 'ocean', 'aurora', 'dusk', 'graphite', 'plasma'];
const hasRing = (theme) => PLANET_THEMES.includes(theme);

// Ticks rather than radio buttons: Windows treats each run of radio items between
// headings as its own group and ticks the first of any group with nothing chosen,
// which showed two themes as selected.
function themeMenu() {
  const item = (v) => ({
    label: THEMES[v],
    type: 'checkbox',
    checked: settings.theme === v,
    click: () => {
      update({ theme: v });
      send('preview-chime'); // each theme has its own end-of-session sound
    },
  });
  const keys = Object.keys(THEMES);
  return [
    { label: 'Planets', enabled: false },
    ...keys.filter((k) => PLANET_THEMES.includes(k) || k === 'liquid').map(item),
    { type: 'separator' },
    { label: 'Future', enabled: false },
    ...FUTURE_THEMES.map(item),
    { type: 'separator' },
    { label: 'Other things', enabled: false },
    ...keys.filter((k) => !PLANET_THEMES.includes(k) && k !== 'liquid' && !FUTURE_THEMES.includes(k)).map(item),
  ];
}
const TRACKER_KEYS = ['graceSec', 'idleMin', 'switchLimit', 'repeatSec'];

// Windows only shows toasts for an app it can identify; an unpackaged dev run has no shortcut, so use its path.
app.setAppUserModelId(app.isPackaged ? 'com.focusorb.app' : process.execPath);

let win = null;
let tray = null;
let settings = { ...DEFAULTS };
let sessions = [];
let uiState = { running: false, started: false, phase: 'focus' };

/* ---------- settings and history ---------- */

const userFile = (name) => path.join(app.getPath('userData'), name);

// What happened, for when something goes wrong: events and errors only, never window
// titles, addresses or intentions. Settings…, About, Open log.
const log = createLog({ dir: path.join(app.getPath('userData'), 'logs') });
let quitting = false; // from here on, processes ending is expected
process.on('uncaughtException', (err) => log.error('Uncaught error in the app', err));
process.on('unhandledRejection', (err) => log.error('Unhandled promise rejection', err instanceof Error ? err : String(err)));

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(userFile('settings.json'), 'utf8')) || {};
  } catch {
    saved = {};
  }
  settings = { ...DEFAULTS, ...saved };
  if (!THEMES[settings.theme]) settings.theme = 'ember';
  if (settings.winv !== 2) {
    // before 1.2 the window was as big as the orb; it is now a fixed square, so keep the orb where it was
    if (Number.isFinite(settings.x) && Number.isFinite(settings.y)) {
      const old = Math.round(ORB * (settings.scale || 1));
      settings.x += Math.round(old / 2 - WIN / 2);
      settings.y += Math.round(old / 2 - WIN / 2);
    }
    settings.winv = 2;
  }
  delete settings.stats; // older versions kept the daily count here; history lives in sessions.json now
  // The break tips went in 1.6.1, and the "still working?" nudge in 1.7.1.
  delete settings.breakCoaching;
  delete settings.breakNudge;
  if (settings.nudgeTone === false) settings.nudgeDings = 0; // older on/off switch
  delete settings.nudgeTone;
  settings.hideApps = cleanApps(Array.isArray(settings.hideApps) ? settings.hideApps : []);
  settings.profiles = D.sanitiseProfiles(settings.profiles);
  if (!settings.profiles.some((p) => p.id === settings.profileId)) settings.profileId = settings.profiles[0].id;
}

function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(userFile('settings.json')), { recursive: true });
    fs.writeFileSync(userFile('settings.json'), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Could not save settings:', err);
  }
}

function loadSessions() {
  try {
    sessions = S.sanitiseList(JSON.parse(fs.readFileSync(userFile('sessions.json'), 'utf8')));
  } catch {
    sessions = [];
  }
}

function saveSessions() {
  try {
    fs.mkdirSync(path.dirname(userFile('sessions.json')), { recursive: true });
    const tmp = `${userFile('sessions.json')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(sessions));
    fs.renameSync(tmp, userFile('sessions.json'));
  } catch (err) {
    console.error('Could not save sessions:', err);
  }
}

const today = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const todayCount = () => S.countOn(sessions, today());

function rendererSettings() {
  // the profile in use can bring its own timings; the global ones fill any gaps
  const t = activeProfile().timing || {};
  const out = { ...settings, ...t, todayCount: todayCount() };
  PRIVATE_KEYS.forEach((k) => delete out[k]);
  return out;
}

const pushSettings = () => win && win.webContents.send('settings', rendererSettings());

function update(patch) {
  settings = { ...settings, ...patch };
  saveSettings();
  if (TRACKER_KEYS.some((k) => k in patch)) tracker.setOptions(trackerOptions());
  if (!win) return;
  if ('scale' in patch) applyScale();
  if ('theme' in patch) applyShape();
  if ('onTop' in patch) win.setAlwaysOnTop(settings.onTop, 'screen-saver');
  if ('shortcuts' in patch) applyShortcuts();
  if ('hideFullscreen' in patch || 'hideApps' in patch) fullscreenCheck(currentWin);
  if ('autoUpdate' in patch) applyUpdates();
  pushSettings();
  if (auxWins.settings) auxWins.settings.webContents.send('settings:changed', settingsSnapshot());
}

function toastNudge(out) {
  if (out.nudge.reason === 'off-topic') notify(`Off task: ${out.label || 'elsewhere'}`, 'The timer is still running.');
  else if (out.nudge.reason === 'switching') notify('Lots of window switching', 'Pick one.');
  else if (out.nudge.reason === 'away') notify('Still there?', 'The timer is still running.');
}

function notify(title, body) {
  if (!settings.notifications || !Notification.isSupported()) return;
  new Notification({ title: String(title), body: String(body), silent: true }).show();
}

/* ---------- distraction watching ---------- */

// Kept so you can see exactly what the orb saw and how it judged it (a test call, say).
// The same window is updated in place, so a page whose address arrives a moment later
// shows its final verdict.
function noteRecent(w, r) {
  if (!w || !w.process || w.pid === process.pid || r.why === 'pending') return;
  const title = String(w.title).slice(0, 80);
  const last = recentWins[recentWins.length - 1];
  if (last && last.process === w.process && last.title === title) {
    last.cls = r.cls;
    last.why = r.why;
    if (w.url) last.host = D.urlHost(w.url);
    return;
  }
  recentWins.push({ at: Date.now(), process: w.process, title, host: w.url ? D.urlHost(w.url) : '', cls: r.cls, why: r.why });
  if (recentWins.length > 30) recentWins.shift();
}


function trackerOptions() {
  return {
    graceMs: settings.graceSec * 1000,
    idleMs: settings.idleMin * 60000,
    switchLimit: settings.switchLimit,
    repeatMs: settings.repeatSec * 1000,
  };
}

const tracker = D.createTracker(trackerOptions());
const tabIndex = D.createTabIndex();

let tracking = false;
let currentWin = null; // whatever is in front right now
let lastOther = null; // the last window that wasn't ours, for the profile editor
let lastReal = null; // the last window that wasn't ours or the shell, for quick block and allow
const recentWins = []; // the last few windows and how each was judged; memory only, for the profile editor
let lastDriftKey = 'ok||';
let lastDay = '';

let snoozeUntil = 0; // "allow a detour" ends at this time
let intent = '';
let sessionStart = null;
let pausedBy = null; // 'lock' | 'meeting' | null: why we paused the timer
let lockedAt = 0;
let screenLocked = false;
let meetingFor = 0;
let calmFor = 0;
let meetingActive = false;

const watcher = createWatcher({
  onStatus: (s, why) => (s === 'ok' ? log.info('Window watcher running') : log.warn(`Window watcher ${s}`, why)),
  onWindow: (w) => {
    currentWin = w; // null when the watcher has gone quiet: nothing is judged until it is back
    if (w && w.process && w.pid !== process.pid) lastOther = w;
    if (w && w.process && w.pid !== process.pid && D.classify(w, null).why !== 'system') {
      lastReal = w;
      noteApp(w);
    }
    fullscreenCheck(w);
  },
});

// Apps seen lately, newest last, for the "hide for these apps" picker. Memory only.
const recentApps = new Map(); // name -> last window title
const appName = (w) => String((w && w.process) || '').trim().toLowerCase().replace(/\.exe$/, '');
function noteApp(w) {
  const name = appName(w);
  if (!name) return;
  recentApps.delete(name);
  recentApps.set(name, String(w.title || '').slice(0, 80));
  if (recentApps.size > 40) recentApps.delete(recentApps.keys().next().value);
}

const activeProfile = () => settings.profiles.find((p) => p.id === settings.profileId) || settings.profiles[0];

// If the browser extension is on, give browser windows the real address of the tab.
// When the extension is working, a page you have just opened is given a moment for its
// address to arrive (the title changes first), rather than being judged on its title
// alone and called off task for a second on every click.
const URL_WAIT_MS = 3000;
const titleSeen = new Map(); // window title -> when the watcher first reported it

function decorate(w) {
  if (!w || !bridge || !D.isBrowser(w.process)) return w;
  const url = tabIndex.lookup(w.title);
  if (url) return { ...w, url };
  const seen = tabIndex.latest();
  if (!seen || Date.now() - seen.at > 10 * 60000) return w; // no extension reporting in: titles it is
  const key = String(w.title);
  if (!titleSeen.has(key)) {
    titleSeen.set(key, Date.now());
    if (titleSeen.size > 200) titleSeen.delete(titleSeen.keys().next().value);
  }
  return Date.now() - titleSeen.get(key) < URL_WAIT_MS ? { ...w, pendingUrl: true } : w;
}

// One judgement for every window, used by the timer, the profile editor and the log.
function judge(w) {
  if (settings.meetingMode !== 'off' && D.isMeeting(w)) return { cls: 'neutral', rule: null, why: 'meeting' };
  if (w && w.pendingUrl) return { cls: 'neutral', rule: null, why: 'pending' };
  return D.classify(w, activeProfile(), { selfPid: process.pid });
}

function liveSnapshot() {
  const w = decorate(lastOther);
  if (!w) return null;
  const result = judge(w);
  return {
    title: w.title,
    process: w.process,
    host: w.url ? D.urlHost(w.url) : '',
    cls: result.cls,
    why: result.why,
    rule: result.rule,
    recent: recentWins.slice(-12).reverse(),
  };
}

const send = (type) => win && win.webContents.send('cmd', { type });
const sendDrift = (payload) => win && win.webContents.send('drift', payload);

function updateMeeting(w) {
  const inCall = settings.meetingMode !== 'off' && D.isMeeting(w);
  if (inCall) {
    meetingFor += 1;
    calmFor = 0;
  } else {
    calmFor += 1;
    meetingFor = 0;
  }
  const was = meetingActive;
  if (!meetingActive && meetingFor >= 3) meetingActive = true;
  if (meetingActive && calmFor >= 5) meetingActive = false;

  if (meetingActive && !was && settings.meetingMode === 'pause' && uiState.running && uiState.phase === 'focus' && !pausedBy) {
    pausedBy = 'meeting';
    send('pause');
  }
  if (!meetingActive && was && pausedBy === 'meeting') {
    pausedBy = null;
    notify('Call finished', 'The timer is paused. Click the orb when you are ready.');
  }
}

function pollDistraction() {
  if (!win) return;
  const nowMs = Date.now();
  const idleSec = powerMonitor.getSystemIdleTime();
  if (today() !== lastDay) {
    lastDay = today();
    pushSettings(); // a new day: the orb's counter starts again
  }

  const w = decorate(currentWin);
  const result = judge(w);
  noteRecent(w, result);
  healthTick(w);
  updateMeeting(w);
  const snoozed = nowMs < snoozeUntil;
  if (auxWins.profiles) auxWins.profiles.webContents.send('profiles:live', liveSnapshot());

  if (!(settings.distractEnabled && tracking)) {
    if (lastDriftKey !== 'ok||') {
      lastDriftKey = 'ok||';
      sendDrift({ status: 'ok', reason: null, label: '', nudge: null });
    }
    return;
  }

  // judge() never judges a call window, even in the few seconds before the orb is sure it
  // is a call, nor a page whose address is still on its way.
  const out = tracker.sample(nowMs, { win: w, result, idleSec, meeting: meetingActive, snoozed });
  if (out.status === 'snoozed') out.label = `${Math.max(1, Math.ceil((snoozeUntil - nowMs) / 60000))} min`;
  const key = `${out.status}|${out.reason || ''}|${out.label}`;
  if (key !== lastDriftKey || out.nudge) {
    const wasFlagged = /^(drifting|away)\|/.test(lastDriftKey);
    lastDriftKey = key;
    sendDrift({ status: out.status, reason: out.reason, label: out.label, nudge: out.nudge ? out.nudge.reason : null });
    // One toast when a drift starts. Repeat nudges are just dings.
    if (out.nudge && !wasFlagged && settings.driftToast) toastNudge(out);
  }
}

function setUiState(s) {
  const prev = uiState;
  uiState = { running: !!s.running, started: !!s.started, phase: String(s.phase || 'focus'), endAt: Number(s.endAt) || 0 };

  // A fresh focus session, or any break, starts the tally from nothing.
  if (uiState.phase !== 'focus' || !uiState.started) tracker.reset();
  tracking = uiState.running && uiState.phase === 'focus';
  if (!tracking) tracker.hold();

  if (uiState.phase !== 'focus') pausedBy = null;

  if (uiState.phase === 'focus' && !uiState.started) {
    intent = '';
    sessionStart = null;
  }
  if (uiState.running && uiState.phase === 'focus' && uiState.started && !prev.started) {
    sessionStart = Date.now();
    intent = '';
    if (settings.askIntent && !settings.autoFocus) openIntent();
  }
}

/* ---------- lock, sleep ---------- */

function onLock() {
  if (!settings.pauseOnLock) return;
  if (!lockedAt) lockedAt = Date.now();
  if (uiState.running && uiState.phase === 'focus' && !pausedBy) {
    pausedBy = 'lock';
    send('pause');
  }
}

function onUnlock() {
  const away = lockedAt ? Date.now() - lockedAt : Infinity;
  lockedAt = 0;
  if (pausedBy !== 'lock') return;
  pausedBy = null;
  if (away < LOCK_RESUME_MS && !uiState.running) send('resume');
}

/* ---------- window ---------- */

function initialPosition(size) {
  const wa = screen.getPrimaryDisplay().workArea;
  if (Number.isFinite(settings.x) && Number.isFinite(settings.y)) {
    const d = screen.getDisplayMatching({ x: settings.x, y: settings.y, width: size, height: size });
    const a = d.workArea;
    const half = size / 2;
    if (
      settings.x >= a.x - half &&
      settings.x <= a.x + a.width - half &&
      settings.y >= a.y - half &&
      settings.y <= a.y + a.height - half
    ) {
      return { x: settings.x, y: settings.y };
    }
  }
  return { x: wa.x + wa.width - size - 24, y: wa.y + wa.height - size - 24 };
}

function createWindow() {
  const size = WIN;
  const pos = initialPosition(size);

  win = new BrowserWindow({
    width: size,
    height: size,
    x: pos.x,
    y: pos.y,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: 'Focus Orb',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(settings.onTop, 'screen-saver');
  applyShape();
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Chromium remembers page zoom per origin across restarts. Version 1.1 sized the orb with
  // page zoom, so a size picked then lingers and shifts the orb away from the window's shape.
  // The orb is now sized in CSS, so the page is always at 100%.
  const unzoom = () => {
    win.webContents.setZoomFactor(1);
    win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  };
  win.webContents.on('dom-ready', unzoom);
  win.webContents.on('did-finish-load', unzoom);
  win.webContents.on('zoom-changed', unzoom);
  win.once('ready-to-show', () => win.show());
  // The page keeps running while hidden (it must, for the timer), so it is told when
  // nobody can see it and skips drawing until it is shown again.
  win.on('hide', () => send('hidden'));
  win.on('show', () => send('shown'));
  win.on('closed', () => {
    win = null;
    app.quit();
  });

  win.on('moved', () => {
    if (!drag) settle();
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

// The window is a fixed square and the page scales the orb inside it, so changing
// the size never resizes a transparent window (which Windows handles badly).
// The orb stays centred where it was; the renderer reads `scale` from the settings.
function applyScale() {
  applyShape();
  savePosition();
}

/* Click-through. The window is a transparent square, so only the planet, its ring
   and a soft margin for the glow are given to the window as its shape (a window
   region): everywhere else the system sends the mouse to whatever is underneath, and
   nothing here polls or hooks the mouse. If the platform refuses a shape, fall back
   to checking the pointer position a few times a second. */
function shapeRects(scale, theme) {
  // Everything the orb paints (glow, goal, dots) fits inside 98 px of its centre, and the ring's
  // far ends and the moon reach a little further, so the shape never cuts anything off.
  const o = { planetR: 100, band: hasRing(theme) ? 24 : 0 };
  const step = 2;
  const rects = [];
  const c = WIN / 2;
  for (let wy = 0; wy < WIN; wy += step) {
    let run = -1;
    for (let wx = 0; wx <= WIN; wx += step) {
      const hit = wx < WIN && E.orbHit((wx + step / 2 - c) / scale + ORB / 2, (wy + step / 2 - c) / scale + ORB / 2, o);
      if (hit && run < 0) run = wx;
      if (!hit && run >= 0) {
        // in DIPs: Chromium scales window shapes to the display itself
        rects.push({ x: run, y: wy, width: wx - run, height: step });
        run = -1;
      }
    }
  }
  return rects;
}

let shaped = false;
function applyShape() {
  if (!win) return;
  try {
    win.setShape(shapeRects(settings.scale || 1, settings.theme));
    if (!shaped) {
      shaped = true;
    }
  } catch (err) {
    if (!shaped && !hitTimer) {
      console.error('Window shape unavailable, checking the pointer instead:', err.message);
      win.setIgnoreMouseEvents(true);
      startHitTest();
    }
  }
}

let ignoring = false;
let hitTimer = null; // only used when the window shape is unavailable
const hitShape = () => (hasRing(settings.theme) ? {} : { planetR: 84, band: 0 });

function setIgnore(v) {
  if (!win || v === ignoring) return;
  ignoring = v;
  if (v) win.setIgnoreMouseEvents(true);
  else win.setIgnoreMouseEvents(false);
}

function hitTick() {
  if (!win) return;
  if (drag) return setIgnore(false);
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const lx = c.x - b.x;
  const ly = c.y - b.y;
  if (lx < 0 || ly < 0 || lx >= b.width || ly >= b.height) return setIgnore(true);
  const k = settings.scale || 1;
  const ux = (lx - b.width / 2) / k + ORB / 2;
  const uy = (ly - b.height / 2) / k + ORB / 2;
  setIgnore(!E.orbHit(ux, uy, hitShape()));
}

function startHitTest() {
  clearInterval(hitTimer);
  ignoring = true;
  hitTimer = setInterval(hitTick, 40);
}

let saveTimer = null;
function savePosition() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win) return;
    const [x, y] = win.getPosition();
    settings.x = x;
    settings.y = y;
    saveSettings();
  }, 250);
}

function toggleVisible() {
  if (!win) return;
  hiddenForFullscreen = false; // you are in charge now
  win.isVisible() ? win.hide() : win.show();
}

/* ---------- secondary windows ---------- */

const AUX = {
  profiles: { file: 'profiles.html', preload: 'preload-profiles.js', title: 'Focus Orb profiles', w: 900, h: 720, minW: 780, minH: 580 },
  stats: { file: 'stats.html', preload: 'preload-stats.js', title: 'Focus Orb stats', w: 680, h: 780, minW: 480, minH: 560 },
  extension: { file: 'extension.html', preload: 'preload-extension.js', title: 'Focus Orb browser link', w: 560, h: 720, minW: 460, minH: 560 },
  settings: { file: 'settings.html', preload: 'preload-settings.js', title: 'Focus Orb settings', w: 820, h: 640, minW: 680, minH: 520 },
};
const auxWins = { profiles: null, stats: null, extension: null, settings: null };
// Each window may only use its own channels: the orb's, or one auxiliary window's.
const fromOrb = (e) => !!win && !!e && e.sender === win.webContents;
const fromAux = (kind, e) => !!auxWins[kind] && e.sender === auxWins[kind].webContents;

function openAux(kind) {
  const spec = AUX[kind];
  if (kind === 'settings') refreshStartup(); // it may have been changed in Task Manager since
  if (auxWins[kind]) {
    auxWins[kind].show();
    auxWins[kind].focus();
    return auxWins[kind];
  }
  const w = new BrowserWindow({
    width: spec.w,
    height: spec.h,
    minWidth: spec.minW,
    minHeight: spec.minH,
    title: spec.title,
    backgroundColor: '#16171b',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, spec.preload),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  w.setMenuBarVisibility(false);
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.once('ready-to-show', () => w.show());
  w.on('closed', () => {
    auxWins[kind] = null;
  });
  w.loadFile(path.join(__dirname, spec.file));
  auxWins[kind] = w;
  return w;
}

/* ---------- "what are you working on?" ---------- */

let intentWin = null;
let intentTimer = null;

function closeIntent() {
  if (!intentWin) return;
  const w = intentWin;
  intentWin = null;
  clearTimeout(intentTimer);
  w.close();
}

function openIntent() {
  if (intentWin || !win) return;
  const W = 340;
  const H = 100;
  const b = win.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  const x = Math.min(Math.max(Math.round(b.x + b.width / 2 - W / 2), wa.x + 8), wa.x + wa.width - W - 8);
  let y = b.y - H - 8;
  if (y < wa.y + 8) y = b.y + b.height + 8;

  intentWin = new BrowserWindow({
    width: W,
    height: H,
    x,
    y,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#1e2025',
    title: 'What are you working on?',
    webPreferences: {
      preload: path.join(__dirname, 'preload-intent.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  intentWin.webContents.on('will-navigate', (e) => e.preventDefault());
  intentWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  intentWin.once('ready-to-show', () => intentWin && intentWin.show());
  intentWin.on('blur', closeIntent);
  intentWin.on('closed', () => {
    intentWin = null;
    clearTimeout(intentTimer);
  });
  intentWin.loadFile(path.join(__dirname, 'intent.html'));
  intentTimer = setTimeout(closeIntent, 15000);
}

function applyIntent() {
  const id = D.intentProfile(intent, settings.profiles);
  if (id && id !== settings.profileId) update({ profileId: id });
}

/* ---------- browser link ---------- */

let bridge = null;

const newToken = () => crypto.randomBytes(16).toString('hex');

const extVersion = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'extension', 'manifest.json'), 'utf8')).version;
  } catch (err) {
    return '';
  }
};

async function startBridge() {
  if (bridge || !settings.bridgeOn) return;
  if (!settings.bridgeToken) update({ bridgeToken: newToken() });
  const b = createBridge({
    getToken: () => settings.bridgeToken,
    basePort: settings.bridgePort,
    onTab: (t) => {
      tabIndex.report(t.url, t.title);
      return siteBlock(t.url, t.title);
    },
    onCheck: (t) => siteBlock(t.url, t.title),
    extVersion,
  });
  try {
    const port = await b.start();
    bridge = b;
    log.info(`Browser link listening on 127.0.0.1:${port}`);
  } catch (err) {
    log.error('Browser link could not start', err);
  }
}

function stopBridge() {
  if (bridge) bridge.stop();
  bridge = null;
}

// Should the extension turn this page away? Only with the setting on, only during a
// focus session that is actually running (not paused, not a detour, not a break), and
// only for site rules on the block list. App rules are left out: "app:msedge" there is
// about the window, and would otherwise shut every page.
function siteBlock(url, title) {
  if (!settings.blockInFocus || !/^https?:\/\//i.test(String(url || ''))) return null;
  if (!uiState.running || uiState.phase !== 'focus' || pausedBy) return null;
  if (Date.now() < snoozeUntil) return null;
  const p = activeProfile();
  const sites = { block: ((p && p.block) || []).filter((r) => !/^\s*app:/i.test(String(r))) };
  const host = D.urlHost(url);
  const r = D.classify({ process: '', title: String(title || '') || host || url, url, pid: 0 }, sites);
  if (r.why !== 'block') return null;
  return { rule: D.labelFor(null, r), host, until: uiState.endAt > Date.now() ? uiState.endAt : 0 };
}

// The extension is copied somewhere a browser can load it from (not inside
// the app package), with this machine's port and secret written beside it.
function writeExtension() {
  if (!settings.bridgeToken) update({ bridgeToken: newToken() });
  const dest = userFile('browser-extension');
  fs.mkdirSync(dest, { recursive: true });
  ['manifest.json', 'background.js', 'blocked.html', 'blocked.css', 'blocked.js', 'icon16.png', 'icon32.png', 'icon48.png', 'icon128.png'].forEach((f) => {
    fs.writeFileSync(path.join(dest, f), fs.readFileSync(path.join(__dirname, 'extension', f)));
  });
  fs.writeFileSync(path.join(dest, 'config.json'), JSON.stringify({ token: settings.bridgeToken, port: settings.bridgePort }));
  return dest;
}

const extState = () => ({ enabled: !!settings.bridgeOn, port: bridge ? bridge.port() : 0, seen: tabIndex.latest() });


/* ---------- start-up health ---------- */

// Said once per launch, so a broken watcher or browser link doesn't go unnoticed.
const launchedAt = Date.now();
const health = { warned: new Set(), browserMs: 0 };

function healthIssues() {
  const out = [];
  const st = watcher.status();
  if (st === 'unavailable') out.push({ key: 'watcher', title: 'Window watcher not running', body: 'Only idle time is being watched. Settings…, About, Show log says why.' });
  if (settings.bridgeOn && !bridge && Date.now() - launchedAt > 20000) out.push({ key: 'bridge', title: 'Browser link could not start', body: 'Try Settings…, Browser link, Set up, and Make a new secret, or turn the link off.' });
  if (settings.bridgeOn && bridge && !tabIndex.latest() && health.browserMs >= 45000) out.push({ key: 'ext', title: 'No word from the extension', body: 'You have been in a browser for a while and the extension has not reported in. Check it is loaded and switched on in edge://extensions or chrome://extensions.' });
  return out;
}

function healthTick(w) {
  if (w && D.isBrowser(w.process)) health.browserMs += 1000;
  if (Date.now() - launchedAt < 25000) return;
  healthIssues().forEach((i) => {
    if (health.warned.has(i.key)) return;
    health.warned.add(i.key);
    notify(i.title, i.body);
  });
}

/* ---------- quick block and allow, from the menu ---------- */

// The rule for the last real window: a site when the browser link knows it, else the app.
function quickRule() {
  const w = decorate(lastReal);
  if (!w) return null;
  const host = w.url ? D.urlHost(w.url) : '';
  if (D.isBrowser(w.process) && !host) return null; // blocking the whole browser is never what you meant
  const rule = host ? `url:${host}` : `app:${String(w.process).toLowerCase().replace(/\.exe$/, '')}`;
  const p = activeProfile();
  const result = D.classify(w, p, { selfPid: process.pid });
  // "OUTLOOK" reads as shouting; "Outlook" does not
  const proc = String(w.process).replace(/\.exe$/i, '');
  const name = host || (proc === proc.toUpperCase() ? proc.charAt(0) + proc.slice(1).toLowerCase() : proc);
  // short enough not to widen the menu: "Block Spotify (General)"
  const say = (verb, what) => {
    const it = what.length > 16 ? `${what.slice(0, 15)}\u2026` : what;
    const full = `${verb} ${it} (${p.name})`;
    return full.length <= 28 ? full : `${verb} ${it}`;
  };
  if (result.cls === 'on') return { label: say('Block', name), apply: () => editRules(p.id, (q) => ({ block: q.block.concat(rule) })) };
  if (result.cls === 'off' && result.why === 'block') {
    return { label: say('Unblock', result.rule.replace(/^(app|title|url):/, '')), apply: () => editRules(p.id, (q) => ({ block: q.block.filter((r) => r !== result.rule) })) };
  }
  if (result.cls === 'off') return { label: say('Allow', name), apply: () => editRules(p.id, (q) => ({ allow: q.allow.concat(rule) })) };
  return null;
}

function editRules(id, change) {
  const profiles = D.sanitiseProfiles(settings.profiles.map((q) => (q.id === id ? { ...q, ...change(q) } : q)));
  update({ profiles });
  if (auxWins.profiles) auxWins.profiles.webContents.send('profiles:changed');
}

/* ---------- keyboard shortcuts ---------- */

const SHORTCUTS = [
  { keys: 'Control+Alt+P', label: 'Start or pause', run: () => send('toggle') },
  { keys: 'Control+Alt+R', label: 'Restart session', run: () => send('reset') },
  { keys: 'Control+Alt+N', label: 'Skip to next', run: () => send('skip') },
  {
    keys: 'Control+Alt+D',
    label: '10-minute detour',
    run: () => {
      snoozeUntil = Date.now() > snoozeUntil ? Date.now() + 10 * 60000 : 0;
    },
  },
  { keys: 'Control+Alt+O', label: 'Show or hide orb', run: () => toggleVisible() },
];
const shortcutState = {}; // keys -> 'ok' | 'taken'

function applyShortcuts() {
  globalShortcut.unregisterAll();
  SHORTCUTS.forEach((s) => {
    delete shortcutState[s.keys];
    if (!settings.shortcuts && s.keys !== SHORTCUT) return; // start/pause is always there
    let ok = false;
    try {
      ok = globalShortcut.register(s.keys, s.run) !== false;
    } catch (err) {
      ok = false;
    }
    shortcutState[s.keys] = ok ? 'ok' : 'taken';
  });
}

const prettyKeys = (k) => k.replace('Control', 'Ctrl').replace(/\+/g, '+');

/* ---------- getting out of the way of full-screen apps ---------- */

let hiddenForFullscreen = false;

// Hide while a full-screen window, or an app on the hide list, is in front.
function fullscreenCheck(w) {
  if (!win) return;
  const other = !!(w && w.pid !== process.pid);
  const listed = other && (settings.hideApps || []).includes(appName(w));
  const fs = !!(other && ((settings.hideFullscreen && w.fs) || listed));
  if (fs && !hiddenForFullscreen && win.isVisible()) {
    hiddenForFullscreen = true;
    win.hide();
  } else if (!fs && hiddenForFullscreen) {
    hiddenForFullscreen = false;
    win.showInactive(); // back where it was, without taking focus from what you are doing
  }
}


/* ---------- the settings window ---------- */

// What the settings window may change, and what counts as a sensible value.
const SETTING_RULES = {
  focus: ['int', 5, 180],
  short: ['int', 1, 60],
  long: ['int', 1, 90],
  rounds: ['int', 2, 8],
  dailyGoal: ['int', 0, 20],
  autoBreak: ['bool'],
  autoFocus: ['bool'],
  distractEnabled: ['bool'],
  askIntent: ['bool'],
  pauseOnLock: ['bool'],
  graceSec: ['int', 5, 300],
  idleMin: ['int', 0, 60],
  switchLimit: ['int', 0, 50],
  meetingMode: ['enum', 'neutral', 'pause', 'off'],
  nudgeDings: ['int', 0, 8],
  repeatSec: ['int', 15, 600],
  sound: ['bool'],
  notifications: ['bool'],
  driftToast: ['bool'],
  blockInFocus: ['bool'],
  scale: ['enum', 0.75, 1, 1.35],
  theme: ['theme'],
  onTop: ['bool'],
  hideFullscreen: ['bool'],
  hideApps: ['apps'],
  autoUpdate: ['bool'],
  shortcuts: ['bool'],
  profileId: ['profile'],
};

// App names as Windows reports them: lower case, no ".exe", nothing odd, no repeats.
function cleanApps(list) {
  const out = [];
  list.forEach((x) => {
    const n = String(x || '').trim().toLowerCase().replace(/\.exe$/, '');
    if (/^[a-z0-9][a-z0-9 ._+-]{0,63}$/.test(n) && !out.includes(n)) out.push(n);
  });
  return out.slice(0, 30);
}

function cleanPatch(patch) {
  const out = {};
  Object.keys(patch && typeof patch === 'object' ? patch : {}).forEach((k) => {
    const rule = SETTING_RULES[k];
    const v = patch[k];
    if (!rule) return;
    const [kind, ...args] = rule;
    if (kind === 'bool' && typeof v === 'boolean') out[k] = v;
    if (kind === 'int') {
      const n = Math.round(Number(v));
      if (Number.isFinite(n) && n >= args[0] && n <= args[1]) out[k] = n;
    }
    if (kind === 'enum' && args.includes(v)) out[k] = v;
    if (kind === 'theme' && THEMES[v]) out[k] = v;
    if (kind === 'profile' && settings.profiles.some((p) => p.id === v)) out[k] = v;
    if (kind === 'apps' && Array.isArray(v)) out[k] = cleanApps(v);
  });
  return out;
}

/* ---------- updates ---------- */

// Only the installed copy updates itself: the portable .exe is replaced by hand.
const canUpdate = () => app.isPackaged && process.platform === 'win32' && !process.env.PORTABLE_EXECUTABLE_FILE;
let updater = null;
let toldReady = '';

function updateState() {
  if (updater && settings.autoUpdate) return updater.state();
  if (!app.isPackaged) return { status: 'off', why: 'Only in the installed app.' };
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { status: 'off', why: 'The portable copy is updated by hand: download the new one.' };
  return { status: 'off', why: 'Off. Switch on to check for new versions.' };
}

function applyUpdates() {
  if (!canUpdate()) return;
  if (!settings.autoUpdate) {
    if (updater) updater.stop();
    return;
  }
  if (!updater) {
    // eslint-disable-next-line global-require
    const { autoUpdater } = require('electron-updater');
    updater = U.createUpdater({
      autoUpdater,
      log,
      onChange: (st) => {
        if (st.status === 'ready' && toldReady !== st.version) {
          toldReady = st.version;
          notify(`Focus Orb ${st.version} is ready`, 'It installs when you quit. Or right-click the orb: Restart to update.');
        }
        if (auxWins.settings) auxWins.settings.webContents.send('settings:changed', settingsSnapshot());
      },
    });
  }
  updater.start();
}

/* ---------- start with Windows ---------- */

// The copy running now: the portable .exe itself, not the folder it unpacks to.
const thisExe = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const canStartup = () => app.isPackaged && process.platform === 'win32';
const startup = createStartup({
  name: 'com.focusorb.app',
  current: thisExe,
  exists: (p) => {
    try {
      return fs.existsSync(p);
    } catch (err) {
      return false;
    }
  },
  run: (args) =>
    new Promise((resolve) => {
      const reg = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\reg.exe`;
      execFile(reg, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }));
    }),
});
let startupState = { on: false, here: false, others: [] };
let startupMoved = false; // this launch took over an entry that started another copy

function startupNote() {
  if (!canStartup()) return 'Only in the installed app.';
  if (startupMoved) return 'It was starting another copy of Focus Orb. It starts this one now.';
  if (startupState.on && !startupState.here) return 'Starts another copy of Focus Orb. Switch off and on to start this one.';
  return '';
}

async function refreshStartup() {
  if (!canStartup()) return;
  startupState = await startup.state();
  if (auxWins.settings) auxWins.settings.webContents.send('settings:changed', settingsSnapshot());
}

function settingsSnapshot() {
  const values = {};
  Object.keys(SETTING_RULES).forEach((k) => (values[k] = settings[k]));
  const p = activeProfile();
  return {
    values,
    themes: Object.keys(THEMES).map((id) => ({
      id,
      name: THEMES[id],
      group: PLANET_THEMES.includes(id) || id === 'liquid' ? 'planets' : FUTURE_THEMES.includes(id) ? 'future' : 'things',
    })),
    profiles: settings.profiles.map((q) => ({ id: q.id, name: q.name })),
    profileTiming: p.timing ? { name: p.name, ...{ focus: settings.focus, short: settings.short, long: settings.long, ...p.timing } } : null,
    shortcuts: SHORTCUTS.map((s) => ({ keys: prettyKeys(s.keys), label: s.label, state: shortcutState[s.keys] || 'off' })),
    watcher: watcherLine(),
    watcherOk: watcher.status() === 'ok',
    bridge: { on: !!settings.bridgeOn, seen: tabIndex.latest() },
    recentApps: [...recentApps].reverse().map(([name, title]) => ({ name, title })),
    version: app.getVersion(),
    updateLine: U.describe(updateState(), app.getVersion()),
    updateReady: updateState().status === 'ready',
    canUpdate: canUpdate(),
    packaged: app.isPackaged,
    startWithWindows: canStartup() && startupState.on,
    startupNote: startupNote(),
    dataFolder: app.getPath('userData'),
  };
}

/* ---------- menu (shared by right-click and tray) ---------- */

function watcherLine() {
  switch (watcher.status()) {
    case 'ok':
      return 'Window watcher: running';
    case 'starting':
      return 'Window watcher: starting…';
    case 'unsupported':
      return 'Window watcher needs Windows';
    default:
      return 'Window watcher off: idle only';
  }
}

function buildMenu() {
  const n = todayCount();
  const goal = settings.dailyGoal;
  const toggleLabel = uiState.running ? 'Pause' : uiState.started ? 'Resume' : 'Start';
  // Kept short: Windows draws every line of a menu tall, so the count rides on the Stats line
  const statsLabel = goal > 0 ? `Stats (${n} of ${goal} today)…` : `Stats (${n} today)…`;
  const left = Math.ceil((snoozeUntil - Date.now()) / 60000);
  const detour = [
    ...[5, 10, 20, 30].map((m) => ({ label: `${m} minutes`, click: () => { snoozeUntil = Date.now() + m * 60000; } })),
    ...(left > 0 ? [{ type: 'separator' }, { label: `End detour (${left} min left)`, click: () => { snoozeUntil = 0; } }] : []),
  ];

  const issues = healthIssues().map((i) => ({ label: `\u26a0 ${i.title}`, enabled: false }));
  const ready = updateState().status === 'ready';
  const quick = quickRule();
  const started = uiState.started;
  const inBreak = uiState.phase !== 'focus';
  return Menu.buildFromTemplate([
    ...(issues.length ? [...issues, { type: 'separator' }] : []),
    ...(ready ? [{ label: `Restart to update (${updateState().version})`, click: () => updater && updater.install() }, { type: 'separator' }] : []),
    // no shortcut column: it doubled the menu's width (the keys are listed in Settings, Keyboard)
    { label: toggleLabel, click: () => send('toggle') },
    // ends a focus session now and counts it; ends a break early
    { label: inBreak ? 'End break now' : 'Finish session now', enabled: !!started, click: () => send('finish') },
    { label: 'Restart this session', click: () => send('reset') },
    { label: 'Skip to next', click: () => send('skip') },
    ...(quick ? [{ label: quick.label, click: quick.apply }] : []),
    { type: 'separator' },
    { label: statsLabel, click: () => openAux('stats') },
    { label: 'Allow a detour', submenu: detour },
    {
      label: 'Task profile',
      submenu: [
        ...settings.profiles.map((p) => ({
          label: p.name,
          type: 'radio',
          checked: p.id === settings.profileId,
          click: () => update({ profileId: p.id }),
        })),
        { type: 'separator' },
        { label: 'Edit profiles…', click: () => openAux('profiles') },
      ],
    },
    { label: 'Theme', submenu: themeMenu() },
    { type: 'separator' },
    { label: 'Settings…', click: () => openAux('settings') },
    { label: win && win.isVisible() ? 'Hide orb' : 'Show orb', click: toggleVisible },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  if (!fs.existsSync(iconPath)) return;
  tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
  tray.setToolTip('Focus Orb');
  tray.on('click', toggleVisible);
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

/* ---------- IPC ---------- */

let drag = null;
let dragTimer = null;

const toPhysical = (p) => (typeof screen.dipToScreenPoint === 'function' ? screen.dipToScreenPoint(p) : p);
const toDip = (p) => (typeof screen.screenToDipPoint === 'function' ? screen.screenToDipPoint(p) : p);
const displayIdOf = (b) => {
  try {
    return screen.getDisplayMatching(b).id;
  } catch (err) {
    return 0;
  }
};

const scaleOf = (d) => (d && d.scaleFactor) || 1;
const displayAt = (p) => {
  try {
    return screen.getDisplayNearestPoint(p);
  } catch (err) {
    return null;
  }
};
const displayFor = (b) => {
  try {
    return screen.getDisplayMatching(b);
  } catch (err) {
    return null;
  }
};

// Where the window's corner goes so the point grabbed stays under the pointer.
// The grab point is held in window units (DIPs), and turned into real pixels with
// the scaling of the screen the window is landing on, because a 150% screen draws
// the same orb half as big again. Holding it in real pixels let the pointer slide
// across the orb on a screen with different scaling.
function dragTarget(cDip) {
  const c = toPhysical(cDip);
  const place = (s) => {
    const d = toDip({ x: c.x - drag.ox * s, y: c.y - drag.oy * s });
    return { x: Math.round(d.x), y: Math.round(d.y) };
  };
  const s = scaleOf(displayAt(cDip));
  let p = place(s);
  // Windows scales the window by the screen holding most of it, which near the seam
  // can be the other one: check, and place again with that screen's scaling.
  const s2 = scaleOf(displayFor({ x: p.x, y: p.y, width: WIN, height: WIN }));
  if (s2 !== s) p = place(s2);
  return p;
}

function dragTick() {
  if (!win || !drag) return;
  const p = dragTarget(screen.getCursorScreenPoint());
  win.setPosition(p.x, p.y);
  // crossing onto a screen with different scaling: redo the window's shape for it
  const id = displayIdOf(win.getBounds());
  if (id !== drag.display) {
    drag.display = id;
    settle();
  }
}

// After a move, or when Windows changes a screen's scaling: keep the window its proper
// size and give it a shape cut for the screen it is now on. A shape cut for the old
// screen's scaling is what clipped one side of the orb.
function settle() {
  if (!win) return;
  const b = win.getBounds();
  if (b.width !== WIN || b.height !== WIN) win.setBounds({ x: b.x, y: b.y, width: WIN, height: WIN });
  applyShape();
}
let watcherTimer = null;

function wireIpc() {
  ipcMain.handle('settings:get', (e) => (fromOrb(e) ? rendererSettings() : null));

  ipcMain.on('menu:show', (e) => {
    if (fromOrb(e)) buildMenu().popup({ window: win });
  });

  ipcMain.on('state', (e, s) => {
    if (fromOrb(e) && s && typeof s === 'object') setUiState(s);
  });

  ipcMain.on('tooltip', (e, text) => {
    if (tray && fromOrb(e)) tray.setToolTip(`${String(text)}${intent ? ` (${intent})` : ''}`.slice(0, 120));
  });

  // A focus session finished: record it, summarise the watching, start afresh.
  ipcMain.handle('session:complete', (e, info) => {
    if (!fromOrb(e)) return null;
    // how long it really ran: shorter when finished early
    const asked = Math.round(Number(info && info.minutes));
    const minutes = Number.isFinite(asked) && asked >= 1 && asked <= 600 ? asked : rendererSettings().focus;
    const sum = tracker.summary();
    const text = settings.distractEnabled ? D.describe(sum) : '';
    sessions = S.addSession(
      sessions,
      S.makeRecord({
        date: today(),
        start: sessionStart ? new Date(sessionStart).toISOString() : null,
        end: new Date().toISOString(),
        focusMin: minutes,
        intent,
        profile: activeProfile().name,
        summary: settings.distractEnabled ? sum : {},
      })
    );
    saveSessions();
    if (text) settings.lastSession = text;
    saveSettings();

    snoozeUntil = 0;
    tracker.reset();
    intent = '';
    sessionStart = null;
    pausedBy = null;
    pushSettings();

    const done = todayCount();
    const goal = settings.dailyGoal;
    return { text, done, goal, goalHit: goal > 0 && done === goal };
  });

  ipcMain.on('notify', (e, n) => {
    if (fromOrb(e) && n && typeof n === 'object') notify(String(n.title || '').slice(0, 120), String(n.body || '').slice(0, 300));
  });

  // Dragging is worked out in physical pixels. Windows' scaled coordinates jump where
  // two monitors with different scaling meet, which left the orb behind the pointer
  // when it crossed from one screen to the other. The main process follows the
  // pointer itself, so the orb keeps up even when the pointer outruns the window.
  ipcMain.on('drag:start', (e) => {
    if (!fromOrb(e)) return;
    const c = toPhysical(screen.getCursorScreenPoint());
    const [x, y] = win.getPosition();
    const p = toPhysical({ x, y });
    const s = scaleOf(displayFor(win.getBounds()));
    drag = { ox: (c.x - p.x) / s, oy: (c.y - p.y) / s, display: displayIdOf(win.getBounds()) };
    clearInterval(dragTimer);
    dragTimer = setInterval(dragTick, 16);
  });
  ipcMain.on('drag:move', (e) => {
    if (fromOrb(e)) dragTick();
  });
  ipcMain.on('drag:end', (e) => {
    if (!fromOrb(e)) return;
    clearInterval(dragTimer);
    dragTimer = null;
    if (!drag) return;
    dragTick();
    drag = null;
    settle();
    savePosition();
  });

  // intent prompt
  ipcMain.on('intent:submit', (e, text) => {
    if (!intentWin || e.sender !== intentWin.webContents) return;
    intent = String(text || '').trim().slice(0, 80);
    closeIntent();
    applyIntent();
  });
  ipcMain.on('intent:cancel', (e) => {
    if (intentWin && e.sender === intentWin.webContents) closeIntent();
  });

  // profile editor
  ipcMain.handle('profiles:get', (e) => {
    if (!fromAux('profiles', e)) return null;
    return {
      profiles: settings.profiles,
      activeId: settings.profileId,
      watcher: watcher.status(),
      live: liveSnapshot(),
      timing: { focus: settings.focus, short: settings.short, long: settings.long },
    };
  });
  ipcMain.handle('profiles:save', (e, payload) => {
    if (!fromAux('profiles', e)) return null;
    const profiles = D.sanitiseProfiles(payload && payload.profiles);
    const wanted = payload && payload.activeId;
    const profileId = profiles.some((p) => p.id === wanted) ? wanted : profiles[0].id;
    update({ profiles, profileId });
    return { profiles, activeId: profileId };
  });

  // profile import and export
  const PROFILE_MAX_BYTES = 200000;
  ipcMain.handle('profiles:export', async (e, payload) => {
    if (!fromAux('profiles', e)) return null;
    const one = payload && payload.scope === 'one' ? settings.profiles.find((p) => p.id === payload.id) : null;
    const ids = one ? [one.id] : null;
    const base = one ? one.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'profile' : 'focus-orb-profiles';
    const r = await dialog.showSaveDialog(auxWins.profiles, {
      title: one ? `Export "${one.name}"` : 'Export all profiles',
      defaultPath: path.join(app.getPath('documents'), `${base}.json`),
      filters: [{ name: 'Focus Orb profiles', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { cancelled: true };
    try {
      fs.writeFileSync(r.filePath, D.exportProfiles(settings.profiles, ids));
      return { ok: true, file: r.filePath, count: ids ? 1 : settings.profiles.length };
    } catch (err) {
      return { ok: false };
    }
  });
  ipcMain.handle('profiles:import', async (e) => {
    if (!fromAux('profiles', e)) return null;
    const r = await dialog.showOpenDialog(auxWins.profiles, {
      title: 'Import profiles',
      properties: ['openFile'],
      filters: [{ name: 'Focus Orb profiles', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { cancelled: true };
    let text;
    try {
      if (fs.statSync(r.filePaths[0]).size > PROFILE_MAX_BYTES) return { ok: false, error: 'too-big' };
      text = fs.readFileSync(r.filePaths[0], 'utf8');
    } catch (err) {
      return { ok: false, error: 'read' };
    }
    const parsed = D.parseProfilesFile(text);
    if (!parsed.ok) return parsed;
    const merged = D.mergeProfiles(settings.profiles, parsed.profiles);
    update({ profiles: merged.profiles });
    return {
      ok: true,
      added: merged.added,
      skipped: merged.skipped,
      renamed: merged.renamed,
      full: merged.full,
      profiles: settings.profiles,
      activeId: settings.profileId,
    };
  });

  // stats
  ipcMain.handle('stats:get', (e) =>
    fromAux('stats', e)
      ? { ...S.aggregate(sessions, today(), settings.dailyGoal), review: S.weeklyReview(sessions, today()), lastSession: settings.lastSession }
      : null
  );
  ipcMain.handle('stats:day', (e, date) =>
    fromAux('stats', e) && /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? S.daySummary(sessions, String(date)) : null
  );
  ipcMain.handle('stats:export', async (e) => {
    if (!fromAux('stats', e)) return null;
    const r = await dialog.showSaveDialog(auxWins.stats, {
      title: 'Export sessions',
      defaultPath: path.join(app.getPath('documents'), 'focus-sessions.csv'),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (r.canceled || !r.filePath) return { cancelled: true };
    try {
      fs.writeFileSync(r.filePath, `\uFEFF${S.sessionsToCsv(sessions)}`);
      return { ok: true, file: r.filePath, count: sessions.length };
    } catch (err) {
      return { ok: false };
    }
  });

  // browser link
  // settings window
  ipcMain.handle('settings:all', (e) => (fromAux('settings', e) ? settingsSnapshot() : null));
  ipcMain.handle('settings:set', (e, patch) => {
    if (!fromAux('settings', e)) return null;
    const clean = cleanPatch(patch);
    if (Object.keys(clean).length) update(clean);
    if ('nudgeDings' in clean) send('preview'); // hear what you picked
    if ('theme' in clean) send('preview-chime');
    return settingsSnapshot();
  });
  ipcMain.handle('settings:action', async (e, what, value) => {
    if (!fromAux('settings', e)) return null;
    if (what === 'profiles') openAux('profiles');
    else if (what === 'browser-link') openAux('extension');
    else if (what === 'data-folder') await shell.openPath(app.getPath('userData'));
    else if (what === 'preview-dings') send('preview');
    else if (what === 'preview-chime') send('preview-chime');
    else if (what === 'start-with-windows' && canStartup()) {
      startupState = await startup.set(!!value);
      startupMoved = false;
      log.info(`Start with Windows switched ${value ? 'on' : 'off'}`, { nowOn: startupState.on, thisCopy: startupState.here });
    }
    else if (what === 'open-log') shell.showItemInFolder(log.file);
    else if (what === 'check-updates' && updater) updater.check();
    else if (what === 'install-update' && updater) updater.install();
    else return null;
    return settingsSnapshot();
  });

  ipcMain.handle('ext:get', (e) => (fromAux('extension', e) ? extState() : null));
  ipcMain.handle('ext:enable', async (e, on) => {
    if (!fromAux('extension', e)) return null;
    update({ bridgeOn: !!on });
    if (on) await startBridge();
    else stopBridge();
    return extState();
  });
  ipcMain.handle('ext:install', async (e) => {
    if (!fromAux('extension', e)) return null;
    try {
      const dest = writeExtension();
      const failure = await shell.openPath(dest);
      return { ok: !failure, dest };
    } catch (err) {
      return { ok: false };
    }
  });
  ipcMain.handle('ext:newtoken', (e) => {
    if (!fromAux('extension', e)) return null;
    try {
      update({ bridgeToken: newToken() });
      writeExtension();
      return { ok: true };
    } catch (err) {
      return { ok: false };
    }
  });
}

/* ---------- lifecycle ---------- */

let pollTimer = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      win.show();
    }
  });

  // Belt and braces for every window, present and future: no navigating away from the
  // app's own pages, no pop-ups, no embedded web views, and no browser permissions
  // (camera, microphone, location, notifications from pages: the orb needs none).
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (ev) => ev.preventDefault());
    contents.on('will-redirect', (ev) => ev.preventDefault());
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, done) => done(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    loadSettings();
    // Set to start with Windows, but pointing at another copy (an older portable .exe,
    // say)? Point it at this one, so the switch and what Windows does agree.
    log.info(`Focus Orb ${app.getVersion()} starting`, { electron: process.versions.electron, windows: os.release(), packaged: app.isPackaged, exe: path.basename(thisExe()) });
    // Chromium reports processes ending cleanly, or being ended at shutdown, the same way
    // as crashes. Only real failures are errors; anything while quitting is ignored.
    const gone = (what, d, extra) => {
      if (quitting || d.reason === 'clean-exit') return;
      const details = { reason: d.reason, exitCode: d.exitCode, ...extra };
      if (d.reason === 'killed') log.warn(`${what} was ended`, details);
      else log.error(`${what} failed`, details);
    };
    app.on('render-process-gone', (_e, wc, d) => gone('A window', d, { page: path.basename(String(wc.getURL ? wc.getURL() : '')) }));
    app.on('child-process-gone', (_e, d) => gone('A helper process', d, { type: d.type, name: d.name }));
    app.on('before-quit', () => {
      quitting = true;
    });
    applyUpdates();
    if (canStartup()) {
      startup
        .follow()
        .then((r) => {
          startupState = r.state;
          startupMoved = r.moved;
          log.info('Start with Windows', { on: r.state.on, thisCopy: r.state.here, others: r.state.others.length, movedHere: r.moved });
        })
        .catch((err) => log.error('Could not read the start-up entries', err));
    }
    loadSessions();
    lastDay = today();
    tracker.setOptions(trackerOptions());
    // After an app update, quietly refresh the extension files you already installed;
    // the extension then reloads itself the next time it reports in.
    if (settings.bridgeOn && fs.existsSync(userFile('browser-extension'))) {
      try {
        writeExtension();
      } catch (err) {
        console.error('Could not refresh the browser extension files:', err.message);
      }
    }
    if (nativeTheme) nativeTheme.themeSource = 'dark'; // dark title bars to match the pages
    wireIpc();
    createWindow();
    if (typeof screen.on === 'function') {
      ['display-metrics-changed', 'display-added', 'display-removed'].forEach((ev) => screen.on(ev, () => settle()));
    }
    createTray();
    watcherTimer = setTimeout(() => watcher.start(), 500); // once the orb is on screen
    startBridge();
    pollTimer = setInterval(pollDistraction, 1000);

    powerMonitor.on('lock-screen', () => {
      screenLocked = true;
      onLock();
    });
    powerMonitor.on('unlock-screen', () => {
      screenLocked = false;
      onUnlock();
    });
    powerMonitor.on('suspend', onLock);
    powerMonitor.on('resume', () => {
      if (!screenLocked) onUnlock();
    });

    applyShortcuts();
  });

  app.on('will-quit', () => {
    quitting = true;
    log.info('Quitting');
    clearInterval(pollTimer);
    if (updater) updater.stop();
    clearInterval(hitTimer);
    clearInterval(dragTimer);
    clearTimeout(watcherTimer);
    watcher.stop();
    stopBridge();
    globalShortcut.unregisterAll();
  });
}
