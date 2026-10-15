'use strict';
const assert = require('node:assert/strict');
const S = require('../stats.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('ok  -', name);
}

const rec = (date, o = {}) =>
  S.makeRecord({
    date,
    start: `${date}T09:00:00.000Z`,
    end: `${date}T09:25:00.000Z`,
    focusMin: 25,
    intent: o.intent || '',
    profile: o.profile || 'General',
    summary: {
      onPct: o.onPct === undefined ? 90 : o.onPct,
      drifts: o.drifts || 0,
      longest: o.longest || null,
      distractions: o.distractions || [],
      awayMs: o.awayMs || 0,
      snoozeMs: o.snoozeMs || 0,
      meetingMs: o.meetingMs || 0,
    },
  });

test('date arithmetic survives month, year and daylight-saving edges', () => {
  assert.equal(S.dateAdd('2026-03-01', -1), '2026-02-28');
  assert.equal(S.dateAdd('2026-01-01', -1), '2025-12-31');
  assert.equal(S.dateAdd('2026-10-04', 1), '2026-10-05'); // AU daylight saving starts
  assert.equal(S.dateAdd('2026-04-05', 1), '2026-04-06'); // and ends
  const days = S.lastDays('2026-10-11', 14);
  assert.equal(days.length, 14);
  assert.equal(days[0], '2026-09-28');
  assert.equal(days[13], '2026-10-11');
  assert.equal(new Set(days).size, 14);
});

test('today, week and daily buckets', () => {
  const sessions = [rec('2026-10-11'), rec('2026-10-11'), rec('2026-10-10'), rec('2026-10-04'), rec('2026-09-01')];
  const a = S.aggregate(sessions, '2026-10-11', 6);
  assert.deepEqual(a.today, { sessions: 2, minutes: 50 });
  assert.deepEqual(a.week, { sessions: 3, minutes: 75 }); // 05 Oct to 11 Oct; the 4th is outside
  assert.equal(a.daily.length, 14);
  assert.equal(a.daily[13].sessions, 2);
  assert.equal(a.goal.pct, 33);
  assert.equal(a.total, 5);
});

test('streak: counts back from today, forgives a day that has not happened yet', () => {
  const run = (dates) => S.aggregate(dates.map((d) => rec(d)), '2026-10-11', 0).streak;
  assert.equal(run(['2026-10-11', '2026-10-10', '2026-10-09']), 3);
  assert.equal(run(['2026-10-10', '2026-10-09']), 2, 'nothing yet today does not break it');
  assert.equal(run(['2026-10-11', '2026-10-09']), 1, 'a gap does');
  assert.equal(run(['2026-10-08']), 0);
  assert.equal(run([]), 0);
});

test('on-task average is weighted by session length and ignores unwatched sessions', () => {
  const a = S.aggregate(
    [rec('2026-10-11', { onPct: 100 }), rec('2026-10-10', { onPct: 50 }), rec('2026-10-09', { onPct: null })],
    '2026-10-11',
    0
  );
  assert.equal(a.onTaskPct, 75);
  assert.equal(S.aggregate([rec('2026-10-11', { onPct: null })], '2026-10-11', 0).onTaskPct, null);
});

test('top distractions add up across sessions and sort by time lost', () => {
  const a = S.aggregate(
    [
      rec('2026-10-11', { distractions: [{ label: 'reddit', ms: 120000 }, { label: 'youtube', ms: 60000 }] }),
      rec('2026-10-10', { distractions: [{ label: 'reddit', ms: 60000 }] }),
      rec('2026-08-01', { distractions: [{ label: 'old', ms: 9e9 }] }),
    ],
    '2026-10-11',
    0
  );
  assert.deepEqual(a.topDistractions.map((d) => [d.label, d.times, d.ms]), [['reddit', 2, 180000], ['youtube', 1, 60000]]);
});

test('records are capped, newest kept, and junk rows are ignored', () => {
  let list = [];
  for (let i = 0; i < S.MAX_SESSIONS + 25; i++) list = S.addSession(list, rec('2026-10-11', { intent: `n${i}` }));
  assert.equal(list.length, S.MAX_SESSIONS);
  assert.equal(list[list.length - 1].intent, `n${S.MAX_SESSIONS + 24}`);
  assert.equal(S.sanitiseList([null, 5, { date: 'nope' }, rec('2026-10-11')]).length, 1);
  assert.equal(S.countOn([rec('2026-10-11'), rec('2026-10-10')], '2026-10-11'), 1);
});

test('csv: header, rows, quoting, and spreadsheet-formula neutralising', () => {
  const csv = S.sessionsToCsv([
    rec('2026-10-11', { intent: 'fix "auth", then lunch', onPct: 80, drifts: 1, longest: { label: 'reddit', ms: 95000 }, awayMs: 30000 }),
    rec('2026-10-10', { intent: '=HYPERLINK("http://evil.example")' }),
    rec('2026-10-09', { intent: '+1 plan', onPct: null }),
    rec('2026-10-08', { intent: 'line\nbreak' }),
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'date,start,end,focus_min,intent,profile,on_task_pct,drifts,longest_drift,longest_drift_s,away_s,detour_s,call_s');
  assert.match(lines[1], /^2026-10-11,.*,25,"fix ""auth"", then lunch",General,80,1,reddit,95,30,0,0$/);
  assert.ok(lines[2].includes(`"'=HYPERLINK(""http://evil.example"")"`), lines[2]);
  assert.ok(lines[3].includes(",'+1 plan,"), lines[3]);
  assert.ok(csv.includes('"line\nbreak"'));
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(S.sessionsToCsv([]), `${lines[0]}\r\n`, 'an empty history still gives a valid file');
});

test('recent sessions are the newest ten, newest first, whatever order they were stored in', () => {
  const dates = ['2026-10-03', '2026-10-11', '2026-10-05', '2026-10-09'];
  const shuffled = dates.map((d, i) => ({ ...rec(d), end: `${d}T0${i}:00:00Z` }));
  const a = S.aggregate(shuffled, '2026-10-11', 0);
  assert.deepEqual(a.recent.map((r) => r.date), ['2026-10-11', '2026-10-09', '2026-10-05', '2026-10-03']);
  const many = [];
  for (let i = 0; i < 30; i++) many.push({ ...rec(S.dateAdd('2026-10-11', -(i % 10))), end: `x${String(i).padStart(2, '0')}` });
  assert.equal(S.aggregate(many, '2026-10-11', 0).recent.length, 10);
});

test('week in review: this week against last, the best time of day, and the biggest distraction', () => {
  const at = (date, hour, o) => ({ ...rec(date, o), start: `${date}T${String(hour).padStart(2, '0')}:00:00.000Z` });
  const hourOf = (iso) => Number(iso.slice(11, 13)); // treat the stored hour as local, for the test
  const today = '2026-10-11';
  const list = [
    // this week: 4 sessions, mornings are good, an evening is not
    at('2026-10-11', 9, { onPct: 95, distractions: [{ label: 'youtube', ms: 300000 }] }),
    at('2026-10-10', 10, { onPct: 90, distractions: [{ label: 'reddit', ms: 60000 }] }),
    at('2026-10-09', 11, { onPct: 85, distractions: [{ label: 'youtube', ms: 120000 }] }),
    at('2026-10-08', 19, { onPct: 40 }),
    // last week: 2 sessions
    at('2026-10-03', 19, { onPct: 50 }),
    at('2026-10-02', 22, { onPct: 60 }),
    // older than four weeks: ignored for the time of day
    at('2026-08-01', 6, { onPct: 100 }),
  ];
  const r = S.weeklyReview(list, today, hourOf);
  assert.equal(r.thisWeek.sessions, 4);
  assert.equal(r.thisWeek.minutes, 100);
  assert.equal(r.lastWeek.sessions, 2);
  assert.equal(r.best.id, 'morning');
  assert.equal(r.best.by, 'on-task');
  assert.equal(r.best.onPct, 90);
  assert.equal(r.slots.find((s) => s.id === 'early').sessions, 0, 'August is outside the four weeks');
  assert.equal(r.slots.find((s) => s.id === 'late').sessions, 1, '22:00 is late');
  assert.deepEqual(r.topDistraction, { label: 'youtube', times: 2, ms: 420000 });

  const few = S.weeklyReview([at('2026-10-11', 15, {}), at('2026-10-10', 15, {})], today, hourOf);
  assert.equal(few.best.by, 'sessions', 'fewer than three in a slot: the busiest, not a percentage');
  assert.equal(few.best.id, 'afternoon');
  assert.equal(S.weeklyReview([], today, hourOf).best, null);
});

test('late covers midnight to five', () => {
  const at = (h) => ({ ...rec('2026-10-11', {}), start: `2026-10-11T0${h}:00:00.000Z` });
  const r = S.weeklyReview([at(1), at(4)], '2026-10-11', (iso) => Number(iso.slice(11, 13)));
  assert.equal(r.slots.find((s) => s.id === 'late').sessions, 2);
});

test('records keep the off-task seconds, so a calm session can say where its missing percent went', () => {
  const r = S.makeRecord({ date: '2026-10-13', focusMin: 25, summary: { onPct: 99, drifts: 0, offMs: 15000 } });
  assert.equal(r.offMs, 15000);
  assert.equal(S.makeRecord({ date: '2026-10-13', focusMin: 25, summary: {} }).offMs, 0);
});

test('one day in full: its sessions in time order, totals and distractions', () => {
  const at = (date, hour, o) => ({ ...rec(date, o), start: `${date}T${String(hour).padStart(2, '0')}:00:00.000Z` });
  const list = [
    at('2026-10-12', 14, { onPct: 60, drifts: 2, distractions: [{ label: 'youtube', ms: 120000 }, { label: 'reddit', ms: 60000 }], awayMs: 90000 }),
    at('2026-10-12', 9, { onPct: 100, drifts: 1, distractions: [{ label: 'youtube', ms: 30000 }] }),
    at('2026-10-11', 9, { onPct: 10 }),
  ];
  const d = S.daySummary(list, '2026-10-12');
  assert.equal(d.sessions.length, 2);
  assert.ok(d.sessions[0].start < d.sessions[1].start, 'earliest first');
  assert.deepEqual([d.totals.sessions, d.totals.minutes, d.totals.drifts, d.totals.awayMs], [2, 50, 3, 90000]);
  assert.equal(d.totals.onPct, 80);
  assert.deepEqual(d.distractions[0], { label: 'youtube', times: 2, ms: 150000 });
  assert.equal(S.daySummary(list, '2026-01-01').sessions.length, 0);
});

console.log(`\n${passed} stats tests passed`);
