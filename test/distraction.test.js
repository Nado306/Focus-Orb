'use strict';
const assert = require('node:assert/strict');
const D = require('../distraction.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('ok  -', name);
}

const win = (process_, title, pid = 100) => ({ process: process_, title, pid });
const SEC = 1000;

/* ---------- classification ---------- */

test('rules: bare word matches app or title, app: is exact, title: is title only', () => {
  const w = win('chrome', 'Funny cats - YouTube');
  assert.ok(D.matches(D.parseRule('youtube'), w));
  assert.ok(D.matches(D.parseRule('chrome'), w));
  assert.ok(D.matches(D.parseRule('app:chrome'), w));
  assert.ok(!D.matches(D.parseRule('app:chro'), w), 'app: is not a substring match');
  assert.ok(!D.matches(D.parseRule('title:chrome'), w));
  assert.ok(D.matches(D.parseRule('APP:Chrome.exe'), win('Chrome.exe', 'x')), 'case and .exe are ignored');
  assert.equal(D.parseRule('   '), null);
  assert.equal(D.parseRule('app:'), null);
});

test('block-only profile: blocked is off, everything else is on', () => {
  const p = { allow: [], block: ['youtube', 'reddit'] };
  assert.equal(D.classify(win('chrome', 'cats - YouTube'), p).cls, 'off');
  assert.equal(D.classify(win('chrome', 'Pull request #4'), p).cls, 'on');
});

test('allow profile: only listed things are on, the rest are off', () => {
  const p = { allow: ['app:code', 'github'], block: [] };
  assert.equal(D.classify(win('Code', 'main.js'), p).cls, 'on');
  assert.equal(D.classify(win('chrome', 'repo - GitHub'), p).cls, 'on');
  const r = D.classify(win('spotify', 'Some song'), p);
  assert.equal(r.cls, 'off');
  assert.equal(r.why, 'not-allowed');
});

test('block beats allow', () => {
  const p = { allow: ['chrome'], block: ['youtube'] };
  assert.equal(D.classify(win('chrome', 'docs'), p).cls, 'on');
  assert.equal(D.classify(win('chrome', 'cats - YouTube'), p).cls, 'off');
});

test('shell, empty titles, missing windows and the orb itself are neutral', () => {
  const p = { allow: ['app:code'], block: [] };
  assert.equal(D.classify(win('explorer', 'Downloads'), p).cls, 'neutral');
  assert.equal(D.classify(win('LockApp', 'Windows Default Lock Screen'), p).cls, 'neutral');
  assert.equal(D.classify(win('chrome', ''), p).cls, 'neutral');
  assert.equal(D.classify(null, p).cls, 'neutral');
  assert.equal(D.classify(win('Focus Orb', 'Focus Orb', 4242), p, { selfPid: 4242 }).cls, 'neutral');
});

test('labels name the thing you drifted to', () => {
  const p = { allow: [], block: ['reddit', 'app:steam'] };
  const a = win('chrome', 'r/programming - Reddit');
  assert.equal(D.labelFor(a, D.classify(a, p)), 'reddit');
  const b = win('steam', 'Library');
  assert.equal(D.labelFor(b, D.classify(b, p)), 'steam');
  const c = win('spotify.exe', 'Song');
  assert.equal(D.labelFor(c, { cls: 'off', why: 'not-allowed', rule: null }), 'spotify');
});

test('default profiles are valid and sanitising is idempotent', () => {
  const once = D.sanitiseProfiles(D.DEFAULT_PROFILES);
  assert.deepEqual(once, D.DEFAULT_PROFILES);
  assert.deepEqual(D.sanitiseProfiles(once), once);
});

test('sanitising repairs junk: names, duplicate ids, rule hygiene, empty lists', () => {
  const out = D.sanitiseProfiles([
    { id: 'a', name: '  Deep work ', allow: [' Code ', 'code', '', 7], block: 'nope' },
    { id: 'a', name: 'Also a', allow: [], block: ['x'] },
    { name: '   ' },
    null,
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Deep work');
  assert.deepEqual(out[0].allow, ['code', '7']);
  assert.deepEqual(out[0].block, []);
  assert.notEqual(out[0].id, out[1].id);
  assert.deepEqual(D.sanitiseProfiles([]), D.DEFAULT_PROFILES, 'never returns an empty list');
  assert.deepEqual(D.sanitiseProfiles('garbage'), D.DEFAULT_PROFILES);
});

/* ---------- tracker ---------- */

const REDDIT = win('chrome', 'r/all - Reddit');
const CODE = win('Code', 'main.js');
const profile = { allow: [], block: ['reddit'] };

function feed(tracker, from, to, w, idleSec = 0, step = SEC) {
  let last = null;
  const nudges = [];
  for (let t = from; t <= to; t += step) {
    last = tracker.sample(t, { win: w, result: D.classify(w, profile), idleSec });
    if (last.nudge) nudges.push({ t, ...last.nudge });
  }
  return { last, nudges };
}

test('off task shorter than the grace period never nudges', () => {
  const tr = D.createTracker();
  feed(tr, 0, 10 * SEC, CODE);
  const r = feed(tr, 11 * SEC, 25 * SEC, REDDIT); // 14 s off
  const back = feed(tr, 26 * SEC, 40 * SEC, CODE);
  assert.equal(r.nudges.length, 0);
  assert.equal(back.last.status, 'ok');
  assert.equal(tr.summary().drifts, 0);
});

test('a drift nudges once the grace period passes, labelled with the culprit', () => {
  const tr = D.createTracker({ graceMs: 20 * SEC });
  feed(tr, 0, 10 * SEC, CODE);
  const r = feed(tr, 11 * SEC, 45 * SEC, REDDIT);
  assert.equal(r.nudges.length, 1);
  assert.equal(r.nudges[0].reason, 'off-topic');
  assert.equal(r.nudges[0].label, 'reddit');
  assert.ok(r.nudges[0].t >= 30 * SEC && r.nudges[0].t <= 32 * SEC, `nudged at ${r.nudges[0].t}`);
  assert.equal(r.last.status, 'drifting');
});

test('the orb names where you are now, even when one drift moves from one off-task window to another', () => {
  const p = { allow: [], block: ['reddit', 'snipping'] };
  const tr = D.createTracker({ graceMs: 20 * SEC });
  const SNIP = win('SnippingTool', 'Snipping Tool');
  const run = (from, to, w) => {
    let last = null;
    for (let t = from; t <= to; t += SEC) last = tr.sample(t, { win: w, result: D.classify(w, p), idleSec: 0 });
    return last;
  };
  assert.equal(run(0, 30 * SEC, SNIP).label, 'snipping', 'flagged for the first culprit');
  assert.equal(run(31 * SEC, 40 * SEC, REDDIT).label, 'reddit', 'then it follows you to the next one');
  assert.equal(run(41 * SEC, 100 * SEC, REDDIT).status, 'drifting');
  assert.equal(tr.summary().offEpisodes, 1, 'still one episode');
  assert.equal(tr.summary().longest.label, 'reddit', 'the summary names where most of it went');
});

test('a long drift repeats the nudge, but not more often than the repeat gap', () => {
  const tr = D.createTracker({ graceMs: 20 * SEC, repeatMs: 90 * SEC });
  const r = feed(tr, 0, 300 * SEC, REDDIT);
  assert.ok(r.nudges.length >= 3 && r.nudges.length <= 4, `got ${r.nudges.length}`);
  for (let i = 1; i < r.nudges.length; i++) assert.ok(r.nudges[i].t - r.nudges[i - 1].t >= 90 * SEC);
});

test('coming back ends the episode after the recovery moment, and a second drift counts separately', () => {
  const tr = D.createTracker({ graceMs: 20 * SEC });
  feed(tr, 0, 40 * SEC, REDDIT);
  assert.equal(feed(tr, 41 * SEC, 42 * SEC, CODE).last.status, 'drifting', 'still flagged for a moment');
  assert.equal(feed(tr, 43 * SEC, 50 * SEC, CODE).last.status, 'ok');
  feed(tr, 51 * SEC, 80 * SEC, REDDIT);
  const s = tr.summary();
  assert.equal(s.offEpisodes, 2);
  assert.equal(s.longest.label, 'reddit');
});

test('a quick hop back to work does not reset a drift in progress', () => {
  const tr = D.createTracker({ graceMs: 20 * SEC });
  feed(tr, 0, 15 * SEC, REDDIT);
  feed(tr, 16 * SEC, 17 * SEC, CODE); // under the recovery time
  const r = feed(tr, 18 * SEC, 30 * SEC, REDDIT);
  assert.equal(r.nudges.length, 1, 'the off-task streak carried on');
});

test('neutral windows hold the streak instead of resetting it', () => {
  const tr = D.createTracker({ graceMs: 20 * SEC });
  feed(tr, 0, 15 * SEC, REDDIT);
  feed(tr, 16 * SEC, 30 * SEC, win('explorer', 'Downloads'));
  const r = feed(tr, 31 * SEC, 40 * SEC, REDDIT);
  assert.equal(r.nudges.length, 1);
});

test('idle: nudges once when you go away, judges nothing while away, resumes after', () => {
  const tr = D.createTracker({ idleMs: 120 * SEC });
  feed(tr, 0, 30 * SEC, CODE, 0);
  const away = feed(tr, 31 * SEC, 200 * SEC, REDDIT, 150);
  assert.equal(away.nudges.length, 1);
  assert.equal(away.nudges[0].reason, 'away');
  assert.equal(away.last.status, 'away');
  const back = feed(tr, 201 * SEC, 210 * SEC, CODE, 0);
  assert.equal(back.last.status, 'ok');
  const s = tr.summary();
  assert.equal(s.drifts, 0, 'being away while Reddit was open is not a drift');
  assert.ok(s.awayMs > 150 * SEC);
});

test('idle detection can be switched off', () => {
  const tr = D.createTracker({ idleMs: 0 });
  const r = feed(tr, 0, 600 * SEC, CODE, 590);
  assert.equal(r.nudges.length, 0);
  assert.equal(r.last.status, 'ok');
});

test('switching apps rapidly is flagged as thrashing', () => {
  const tr = D.createTracker({ switchLimit: 12 });
  const apps = ['Code', 'slack', 'outlook', 'teams'];
  let nudge = null;
  let status = null;
  for (let i = 0; i < 20; i++) {
    const w = win(apps[i % apps.length], `window ${i}`);
    const r = tr.sample(i * 2 * SEC, { win: w, result: D.classify(w, { allow: [], block: [] }), idleSec: 0 });
    if (r.nudge) nudge = r.nudge;
    status = r;
  }
  assert.equal(nudge.reason, 'switching');
  assert.equal(status.status, 'drifting');
  assert.equal(tr.summary().thrashEpisodes, 1);
});

test('browser tab changes count as switches, terminal retitling does not', () => {
  const none = { allow: [], block: [] };
  const run = (proc) => {
    const tr = D.createTracker({ switchLimit: 12 });
    let flagged = false;
    for (let i = 0; i < 40; i++) {
      const w = win(proc, `title ${i}`);
      const r = tr.sample(i * SEC, { win: w, result: D.classify(w, none), idleSec: 0 });
      if (r.reason === 'switching') flagged = true;
    }
    return flagged;
  };
  assert.equal(run('chrome'), true);
  assert.equal(run('WindowsTerminal'), false);
});

test('switch sensitivity 0 turns thrash detection off', () => {
  const tr = D.createTracker({ switchLimit: 0 });
  for (let i = 0; i < 40; i++) {
    const w = win(i % 2 ? 'a' : 'b', 't');
    const r = tr.sample(i * SEC, { win: w, result: { cls: 'on' }, idleSec: 0 });
    assert.equal(r.status, 'ok');
  }
});

test('time buckets add up and a long gap (sleep, pause) is not counted as watched', () => {
  const tr = D.createTracker();
  feed(tr, 0, 60 * SEC, CODE); // 60 s on
  feed(tr, 61 * SEC, 90 * SEC, win('chrome', 'Reddit')); // ~30 s off
  const before = tr.summary();
  tr.sample(8 * 3600 * SEC, { win: CODE, result: D.classify(CODE, profile), idleSec: 0 });
  const after = tr.summary();
  assert.ok(after.onMs - before.onMs <= 5 * SEC, 'a sleep adds at most one capped step');
  assert.ok(before.onPct >= 60 && before.onPct <= 72, `onPct ${before.onPct}`);
});

test('hold() stops a pause being counted', () => {
  const tr = D.createTracker();
  feed(tr, 0, 30 * SEC, CODE);
  const before = tr.summary().onMs;
  tr.hold();
  tr.sample(10 * 60 * SEC, { win: CODE, result: D.classify(CODE, profile), idleSec: 0 });
  assert.equal(tr.summary().onMs, before);
});

test('reset starts a clean session', () => {
  const tr = D.createTracker({ graceMs: 20 * SEC });
  feed(tr, 0, 60 * SEC, REDDIT);
  assert.ok(tr.summary().drifts > 0);
  tr.reset();
  const s = tr.summary();
  assert.equal(s.drifts, 0);
  assert.equal(s.onPct, null);
});

test('options can change mid-flight', () => {
  const tr = D.createTracker({ graceMs: 60 * SEC });
  tr.setOptions({ graceMs: 5 * SEC });
  const r = feed(tr, 0, 10 * SEC, REDDIT);
  assert.equal(r.nudges.length, 1);
});

/* ---------- words ---------- */

test('summary copy: clean, drifting, hopping, away, and nothing-to-say', () => {
  const base = { onMs: 0, offMs: 0, neutralMs: 0, awayMs: 0, offEpisodes: 0, thrashEpisodes: 0, drifts: 0, longest: null, onPct: null };
  assert.equal(D.describe(null), '');
  assert.equal(D.describe(base), '');
  assert.equal(D.describe({ ...base, onMs: 5 * SEC, onPct: 100 }), '', 'too little to comment on');
  assert.equal(D.describe({ ...base, onMs: 1500 * SEC, onPct: 100 }), '100% on task. No drifting.');
  assert.equal(
    D.describe({ ...base, onMs: 1485 * SEC, offMs: 15 * SEC, onPct: 99 }),
    '99% on task. No drifting, 15 s in short hops.',
    'a percent lost to quick looks is explained, not left looking like a mistake'
  );
  assert.equal(D.describe({ ...base, onMs: 1500 * SEC, offMs: 400, onPct: 100 }), '100% on task. No drifting.', 'under a second is not worth a mention');
  assert.equal(
    D.describe({ ...base, onMs: 1200 * SEC, offMs: 280 * SEC, onPct: 81, offEpisodes: 2, drifts: 2, longest: { ms: 240 * SEC, label: 'reddit' } }),
    '81% on task. Drifted twice, longest 4 min on reddit.'
  );
  assert.equal(
    D.describe({ ...base, onMs: 600 * SEC, onPct: 100, thrashEpisodes: 3, drifts: 3 }),
    '100% on task. Window-hopping got flagged 3 times.'
  );
  assert.equal(
    D.describe({ ...base, onMs: 600 * SEC, onPct: 100, awayMs: 95 * SEC }),
    '100% on task. No drifting. Away for 2 min.'
  );
  assert.equal(D.describe({ ...base, awayMs: 120 * SEC }), 'Away for 2 min.');
  assert.equal(D.duration(40 * SEC), '40 s');
  assert.equal(D.duration(90 * SEC), '2 min');
});

/* ---------- watcher output ---------- */

test('line parser copes with split chunks, a BOM, blank lines and junk', () => {
  const seen = [];
  const feedLines = D.createLineParser((w) => seen.push(w));
  feedLines('\uFEFF{"title":"Inbox - Outlook","process":"OUTLOOK","pid":12');
  assert.equal(seen.length, 0);
  feedLines('34}\r\n\r\nthis is not json\n');
  feedLines('{"title":"Caf\u00e9 \u2013 notes","process":"notepad","pid":7}\n{"title":null,"process":"x"}\n');
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[0], { title: 'Inbox - Outlook', process: 'OUTLOOK', pid: 1234, fs: false });
  assert.equal(seen[1].title, 'Caf\u00e9 \u2013 notes');
  assert.deepEqual(seen[2], { title: '', process: 'x', pid: 0, fs: false });
  feedLines('{"title":"Game","process":"game","pid":3,"fs":true}\n{"title":"x","process":"y","pid":4,"fs":"yes"}\n');
  assert.equal(seen[3].fs, true, 'full screen is passed on');
  assert.equal(seen[4].fs, false, 'only a real true counts');
});

test('profile timings: kept when sensible, dropped when not, and carried through export and import', () => {
  const p = D.sanitiseProfiles([
    { name: 'Coding', allow: [], block: [], timing: { focus: 50, short: 10, long: 'soon' } },
    { name: 'Odd', allow: [], block: [], timing: { focus: 2, short: 999 } },
  ]);
  assert.deepEqual(p[0].timing, { focus: 50, short: 10 });
  assert.equal(p[1].timing, undefined, 'out-of-range timings are dropped');
  const back = D.parseProfilesFile(D.exportProfiles(p));
  assert.deepEqual(back.profiles[0].timing, { focus: 50, short: 10 });
  const merged = D.mergeProfiles([{ id: 'general', name: 'General', allow: [], block: [] }], back.profiles);
  assert.deepEqual(merged.profiles.find((q) => q.name === 'Coding').timing, { focus: 50, short: 10 });
});


/* ---------- urls ---------- */

test('url rules match sites and subdomains, not lookalikes', () => {
  const u = (url) => ({ process: 'chrome', title: 'whatever', url });
  const x = D.parseRule('url:x.com');
  assert.ok(D.matches(x, u('https://x.com/home')));
  assert.ok(D.matches(x, u('https://www.x.com/')));
  assert.ok(D.matches(x, u('https://mobile.x.com/')));
  assert.ok(!D.matches(x, u('https://fedex.com/track')), 'fedex.com is not x.com');
  assert.ok(!D.matches(x, u('https://example.org/?q=x.com')));
  assert.ok(D.matches(D.parseRule('url:reddit'), u('https://old.reddit.com/r/all')), 'no dot: host contains');
  const path = D.parseRule('url:github.com/some-org');
  assert.ok(D.matches(path, u('https://github.com/some-org/repo')));
  assert.ok(!D.matches(path, u('https://github.com/other/repo')));
  assert.ok(D.matches(path, u('https://github.com/some-org')));
  assert.ok(D.matches(path, u('https://gist.github.com/some-org/x')), 'subdomains of the site count');
  assert.ok(!D.matches(path, u('https://www.reddit.com/?q=github.com/some-org')), 'another site that mentions it does not');
  assert.ok(!D.matches(path, u('https://evilgithub.com/some-org')), 'nor a lookalike site');
  assert.ok(!D.matches(path, u('https://github.com/some-organisation')), 'a path is matched by whole name');
  assert.ok(D.matches(D.parseRule('url:youtube.com/watch?v='), u('https://www.youtube.com/watch?v=abc')), 'a rule ending in punctuation is a plain prefix');
  assert.ok(!D.matches(x, { process: 'chrome', title: 'x.com is mentioned in this title' }), 'no url known, no match');
});

test('drift labels: the rule that caught it, else the site of a browser tab, else the app', () => {
  const allowOnly = { allow: ['app:code'], block: ['youtube'] };
  const label = (w) => D.labelFor(w, D.classify({ pid: 1, ...w }, allowOnly));
  assert.equal(label({ process: 'msedge', title: 'Big story - Microsoft Edge', url: 'https://www.news.example.com/a/1' }), 'news.example.com');
  assert.equal(label({ process: 'msedge.exe', title: 'Big story - Microsoft Edge' }), 'Edge', 'no address known: the browser, by name');
  assert.equal(label({ process: 'chrome', title: 'cats - YouTube', url: 'https://www.youtube.com/watch?v=1' }), 'youtube', 'a block rule names itself');
  assert.equal(label({ process: 'Spotify', title: 'Spotify' }), 'spotify');
});

test('bare rules also see the address; the X default catches x.com and "Home / X"', () => {
  const social = D.DEFAULT_PROFILES[0];
  assert.equal(D.classify({ process: 'chrome', title: 'Some page', url: 'https://www.reddit.com/r/all', pid: 1 }, social).cls, 'off');
  assert.equal(D.classify({ process: 'chrome', title: 'Notifications', url: 'https://x.com/notifications', pid: 1 }, social).cls, 'off');
  assert.equal(D.classify({ process: 'chrome', title: 'Home / X - Google Chrome', pid: 1 }, social).cls, 'off', 'title fallback without the extension');
  assert.equal(D.classify({ process: 'chrome', title: 'Fedex tracking', url: 'https://fedex.com', pid: 1 }, social).cls, 'on');
  const w = { process: 'chrome', title: 'x', url: 'https://x.com/home', pid: 1 };
  assert.equal(D.labelFor(w, D.classify(w, social)), 'x.com');
});

test('tab index: matches a window title to the right tab, longest title wins, stale entries expire', () => {
  const idx = D.createTabIndex();
  idx.report('https://www.youtube.com/', 'YouTube', 1000);
  idx.report('https://www.youtube.com/watch?v=1', 'Funny cats - YouTube', 2000);
  idx.report('https://www.youtube.com/', 'YouTube', 3000); // more recent, shorter
  assert.equal(idx.lookup('Funny cats - YouTube - Google Chrome'), 'https://www.youtube.com/watch?v=1');
  assert.equal(idx.lookup('YouTube and 3 more pages - Personal - Microsoft Edge'), 'https://www.youtube.com/');
  assert.equal(idx.lookup('Untitled - Notepad'), null);
  assert.equal(idx.lookup(''), null);
  assert.equal(idx.latest().host, 'youtube.com');
  const old = D.createTabIndex();
  old.report('https://a.example/', 'Some old tab', Date.now() - 13 * 3600 * 1000);
  old.report('https://b.example/', 'Fresh tab', Date.now());
  assert.equal(old.lookup('Some old tab - Chrome'), null, 'dropped after 12 hours');
  assert.equal(old.lookup('Fresh tab - Chrome'), 'https://b.example/');
  const tiny = D.createTabIndex();
  tiny.report('https://c.example/', 'a', Date.now());
  assert.equal(tiny.lookup('a b c'), null, 'one-character titles are too ambiguous to match');
});

/* ---------- meetings ---------- */

test('meetings: desktop apps and browser calls are recognised, ordinary windows are not', () => {
  const w = (process_, title, url) => ({ process: process_, title, url });
  assert.equal(D.isMeeting(w('Zoom', 'Zoom Meeting')), true);
  assert.equal(D.isMeeting(w('Zoom', 'Zoom Workplace')), false, 'the Zoom home screen is not a call');
  assert.equal(D.isMeeting(w('ms-teams', 'Weekly meeting | Microsoft Teams')), true);
  assert.equal(D.isMeeting(w('ms-teams', 'Chat | Microsoft Teams')), false);
  assert.equal(D.isMeeting(w('ms-teams', 'Microsoft Teams Notification')), true, 'the ringing pop-up');
  assert.equal(D.isMeeting(w('ms-teams', 'Incoming call from Sam')), true);
  assert.equal(D.isMeeting(w('ms-teams', 'Microsoft Teams')), false, 'the plain app window is not a call');
  assert.equal(D.isMeeting(w('slack', 'Huddle with Sam')), true);
  assert.equal(D.isMeeting(w('chrome', 'Meet', 'https://meet.google.com/abc-defg-hij')), true);
  assert.equal(D.isMeeting(w('chrome', 'Meet', 'https://meet.google.com/landing')), false);
  assert.equal(D.isMeeting(w('msedge', 'Meet - abc-defg-hij - Microsoft Edge')), true, 'title fallback without the extension');
  assert.equal(D.isMeeting(w('chrome', 'Join', 'https://us02web.zoom.us/wc/12345/join')), true);
  assert.equal(D.isMeeting(w('Code', 'meeting-notes.md')), false);
  assert.equal(D.isMeeting(null), false);
});

test('a call is never judged: no off task, no away, and it is counted separately', () => {
  const tr = D.createTracker({ graceMs: 20 * SEC, idleMs: 120 * SEC });
  let r;
  for (let t = 0; t <= 600 * SEC; t += SEC) {
    r = tr.sample(t, { win: REDDIT, result: D.classify(REDDIT, profile), idleSec: 400, meeting: true });
    assert.equal(r.nudge, null);
  }
  assert.equal(r.status, 'meeting');
  const s = tr.summary();
  assert.ok(s.meetingMs >= 595 * SEC);
  assert.equal(s.drifts, 0);
  assert.equal(s.awayMs, 0);
  assert.equal(s.onPct, null);
  assert.match(D.describe(s), /On calls for 10 min\./);
});

test('a detour (snooze) allows anything, ends any drift in progress, and is reported', () => {
  const tr = D.createTracker({ graceMs: 20 * SEC });
  feed(tr, 0, 40 * SEC, REDDIT);
  assert.equal(tr.summary().offEpisodes, 1);
  let r;
  for (let t = 41 * SEC; t <= 700 * SEC; t += SEC) {
    r = tr.sample(t, { win: REDDIT, result: D.classify(REDDIT, profile), idleSec: 0, snoozed: true });
    assert.equal(r.nudge, null);
  }
  assert.equal(r.status, 'snoozed');
  assert.equal(tr.summary().offEpisodes, 1, 'no new drift during the detour');
  const after = feed(tr, 701 * SEC, 715 * SEC, REDDIT);
  assert.equal(after.nudges.length, 0, 'the grace period starts afresh when the detour ends');
  assert.match(D.describe(tr.summary()), /Detour: 11 min\./);
});

/* ---------- intent ---------- */

test('intent picks a matching profile by name stem, or nothing', () => {
  const ps = D.DEFAULT_PROFILES;
  assert.equal(D.intentProfile('coding the settings page', ps), 'coding');
  assert.equal(D.intentProfile('Write the quarterly report', ps), 'writing');
  assert.equal(D.intentProfile('general tidy-up', ps), 'general');
  assert.equal(D.intentProfile('sort the invoices', ps), null);
  assert.equal(D.intentProfile('', ps), null);
  assert.equal(D.intentProfile('anything', []), null);
});

test('summary lists every distraction with its label for the stats view', () => {
  const tr = D.createTracker({ graceMs: 5 * SEC });
  feed(tr, 0, 20 * SEC, REDDIT);
  feed(tr, 21 * SEC, 30 * SEC, CODE);
  feed(tr, 31 * SEC, 60 * SEC, REDDIT);
  const d = tr.summary().distractions;
  assert.equal(d.length, 2);
  assert.ok(d.every((x) => x.label === 'reddit' && x.ms > 0));
});

/* ---------- sharing profiles ---------- */

test('export: names and rules only, no ids; one profile or all of them; round-trips', () => {
  const all = JSON.parse(D.exportProfiles(D.DEFAULT_PROFILES));
  assert.equal(all.format, 'focus-orb-profiles');
  assert.equal(all.version, 1);
  assert.equal(all.profiles.length, D.DEFAULT_PROFILES.length);
  assert.ok(all.profiles.every((p) => p.id === undefined && p.name && Array.isArray(p.allow) && Array.isArray(p.block)));
  const one = JSON.parse(D.exportProfiles(D.DEFAULT_PROFILES, ['coding']));
  assert.deepEqual(one.profiles.map((p) => p.name), ['Coding']);
  const back = D.parseProfilesFile(D.exportProfiles(D.DEFAULT_PROFILES));
  assert.equal(back.ok, true);
  assert.deepEqual(back.profiles.map((p) => p.name), D.DEFAULT_PROFILES.map((p) => p.name));
  assert.deepEqual(back.profiles[1].allow, D.DEFAULT_PROFILES[1].allow);
});

test('import parsing: refuses other files, cleans what it keeps, never throws', () => {
  const file = (o) => JSON.stringify(o);
  assert.equal(D.parseProfilesFile('{nope').error, 'not-json');
  assert.equal(D.parseProfilesFile(file({ hello: 1 })).error, 'not-profiles');
  assert.equal(D.parseProfilesFile(file([{ name: 'bare array', allow: [], block: [] }])).error, 'not-profiles', 'must be our format');
  assert.equal(D.parseProfilesFile(file({ format: 'focus-orb-profiles', profiles: [] })).error, 'empty');
  assert.equal(D.parseProfilesFile(file({ format: 'focus-orb-profiles', profiles: [null, 5, { name: '  ' }] })).error, 'empty');
  assert.equal(D.parseProfilesFile('x'.repeat(250000)).error, 'too-big');
  assert.equal(D.parseProfilesFile(null).error, 'too-big');
  const ok = D.parseProfilesFile('﻿' + file({
    format: 'focus-orb-profiles',
    profiles: [{ name: '  ' + 'N'.repeat(60), allow: [' APP:Code ', 'code', '', 7, { x: 1 }], block: 'nope', id: 'evil', extra: 1 }],
  }));
  assert.equal(ok.ok, true);
  assert.equal(ok.profiles[0].name.length, 40);
  assert.deepEqual(ok.profiles[0].block, []);
  assert.ok(ok.profiles[0].allow.includes('app:code'));
  assert.equal(ok.profiles[0].id, undefined, 'ids and unknown fields are dropped');
  const many = D.parseProfilesFile(file({ format: 'focus-orb-profiles', profiles: Array.from({ length: 50 }, (_, i) => ({ name: 'p' + i })) }));
  assert.equal(many.profiles.length, 20);
});

test('merging: adds new, skips identical copies, renames clashes, never overwrites, respects the cap', () => {
  const have = D.sanitiseProfiles(D.DEFAULT_PROFILES);
  const incoming = [
    { name: 'Reading', allow: ['app:kindle'], block: [] },
    { name: 'coding', allow: have[1].allow, block: have[1].block }, // identical, different case
    { name: 'Writing', allow: ['app:scrivener'], block: [] }, // same name, different rules
  ];
  const r = D.mergeProfiles(have, incoming);
  assert.deepEqual([r.added, r.skipped, r.renamed, r.full], [2, 1, 1, 0]);
  assert.deepEqual(r.profiles.map((p) => p.name), ['General', 'Coding', 'Writing', 'Reading', 'Writing (imported)']);
  assert.deepEqual(r.profiles[2], have[2], 'the existing Writing profile is untouched');
  assert.equal(new Set(r.profiles.map((p) => p.id)).size, r.profiles.length, 'ids stay unique');
  // importing the same file twice changes nothing the second time
  const again = D.mergeProfiles(r.profiles, incoming);
  assert.deepEqual([again.added, again.skipped], [0, 2 + 1]);
  // a second clash gets a numbered suffix
  const third = D.mergeProfiles(r.profiles, [{ name: 'Writing', allow: ['app:other'], block: [] }]);
  assert.equal(third.profiles[third.profiles.length - 1].name, 'Writing (imported 2)');
  // the cap
  const full = D.mergeProfiles(
    Array.from({ length: 19 }, (_, i) => ({ id: 'p' + i, name: 'p' + i, allow: [], block: [] })),
    [{ name: 'a', allow: [], block: [] }, { name: 'b', allow: [], block: [] }]
  );
  assert.deepEqual([full.profiles.length, full.added, full.full], [20, 1, 1]);
});

console.log(`\n${passed} distraction tests passed`);
