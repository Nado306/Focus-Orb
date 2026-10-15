/*
 * Session history: records, daily/weekly numbers, streaks, top distractions,
 * and CSV export. Pure functions; the main process does the file reading.
 * Dates are local calendar days as 'YYYY-MM-DD' strings.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FocusStats = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_SESSIONS = 5000;
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // Noon avoids daylight-saving edges when stepping between days.
  function dateAdd(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return fmt(new Date(y, m - 1, d + days, 12));
  }

  function lastDays(todayStr, n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(dateAdd(todayStr, -i));
    return out;
  }

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  // One finished focus session, in the shape stored on disk.
  function makeRecord(input) {
    const sum = input.summary || {};
    const longest = sum.longest ? { label: String(sum.longest.label || '').slice(0, 30), ms: num(sum.longest.ms) } : null;
    return {
      v: 1,
      date: String(input.date),
      start: input.start || null,
      end: input.end || null,
      focusMin: num(input.focusMin),
      intent: String(input.intent || '').slice(0, 80),
      profile: String(input.profile || '').slice(0, 40),
      onPct: sum.onPct == null ? null : num(sum.onPct),
      drifts: num(sum.drifts),
      longest,
      distractions: (sum.distractions || []).slice(0, 20).map((d) => ({ label: String(d.label || '').slice(0, 30), ms: num(d.ms) })),
      offMs: num(sum.offMs),
      awayMs: num(sum.awayMs),
      snoozeMs: num(sum.snoozeMs),
      meetingMs: num(sum.meetingMs),
    };
  }

  function addSession(list, record) {
    const out = (Array.isArray(list) ? list : []).concat(record);
    return out.length > MAX_SESSIONS ? out.slice(out.length - MAX_SESSIONS) : out;
  }

  function sanitiseList(list) {
    return (Array.isArray(list) ? list : []).filter((r) => r && typeof r === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date)));
  }

  const countOn = (sessions, date) => sanitiseList(sessions).filter((r) => r.date === date).length;

  function aggregate(sessions, todayStr, goal) {
    const list = sanitiseList(sessions);
    const days = lastDays(todayStr, 14);
    const byDate = new Map(days.map((d) => [d, { date: d, sessions: 0, minutes: 0 }]));
    list.forEach((r) => {
      const day = byDate.get(r.date);
      if (day) {
        day.sessions += 1;
        day.minutes += num(r.focusMin);
      }
    });
    const daily = days.map((d) => byDate.get(d));
    const today = byDate.get(todayStr);
    const week = daily.slice(-7).reduce((a, d) => ({ sessions: a.sessions + d.sessions, minutes: a.minutes + d.minutes }), { sessions: 0, minutes: 0 });

    // Streak: consecutive days with at least one session. Today not having one
    // yet doesn't break it; the day isn't over.
    const have = new Set(list.map((r) => r.date));
    let streak = 0;
    let cursor = have.has(todayStr) ? todayStr : dateAdd(todayStr, -1);
    while (have.has(cursor)) {
      streak += 1;
      cursor = dateAdd(cursor, -1);
    }

    const recent14 = list.filter((r) => byDate.has(r.date));
    let w = 0;
    let acc = 0;
    recent14.forEach((r) => {
      if (r.onPct != null) {
        const weight = num(r.focusMin) || 1;
        acc += num(r.onPct) * weight;
        w += weight;
      }
    });

    const tally = new Map();
    recent14.forEach((r) =>
      (r.distractions || []).forEach((d) => {
        const t = tally.get(d.label) || { label: d.label, times: 0, ms: 0 };
        t.times += 1;
        t.ms += num(d.ms);
        tally.set(d.label, t);
      })
    );
    const top = [...tally.values()].sort((a, b) => b.ms - a.ms).slice(0, 5);

    const g = num(goal);
    return {
      today: { sessions: today.sessions, minutes: today.minutes },
      week,
      daily,
      streak,
      onTaskPct: w > 0 ? Math.round(acc / w) : null,
      topDistractions: top,
      goal: { goal: g, done: today.sessions, pct: g > 0 ? Math.min(100, Math.round((100 * today.sessions) / g)) : 0 },
      recent: list.slice().sort((a, b) => `${a.date} ${a.end || ''}`.localeCompare(`${b.date} ${b.end || ''}`)).slice(-10).reverse(),
      total: list.length,
    };
  }

  /* ---------- the week in review ---------- */

  // Parts of the day, by the local hour a session started.
  const SLOTS = [
    { id: 'early', name: 'Early', from: 5, to: 9 },
    { id: 'morning', name: 'Morning', from: 9, to: 12 },
    { id: 'midday', name: 'Midday', from: 12, to: 14 },
    { id: 'afternoon', name: 'Afternoon', from: 14, to: 17 },
    { id: 'evening', name: 'Evening', from: 17, to: 21 },
    { id: 'late', name: 'Late', from: 21, to: 29 }, // 21:00 to 05:00
  ];
  const slotOf = (hour) => SLOTS.find((s) => (hour >= s.from && hour < s.to) || (hour + 24 >= s.from && hour + 24 < s.to));

  function weighted(list) {
    let w = 0;
    let acc = 0;
    list.forEach((r) => {
      if (r.onPct == null) return;
      const weight = num(r.focusMin) || 1;
      acc += num(r.onPct) * weight;
      w += weight;
    });
    return w > 0 ? Math.round(acc / w) : null;
  }

  function totals(list) {
    return { sessions: list.length, minutes: list.reduce((a, r) => a + num(r.focusMin), 0), onPct: weighted(list) };
  }

  // `hourOf` turns a record's start time into a local hour (the caller knows the time zone).
  function weeklyReview(sessions, todayStr, hourOf) {
    const list = sanitiseList(sessions);
    const thisDays = new Set(lastDays(todayStr, 7));
    const lastDaysSet = new Set(lastDays(dateAdd(todayStr, -7), 7));
    const month = new Set(lastDays(todayStr, 28));
    const thisWeek = list.filter((r) => thisDays.has(r.date));
    const lastWeek = list.filter((r) => lastDaysSet.has(r.date));

    const hours = (hourOf || ((iso) => new Date(iso).getHours()));
    const slots = SLOTS.map((s) => ({ id: s.id, name: s.name, sessions: 0, onPct: null, _list: [] }));
    list
      .filter((r) => month.has(r.date) && r.start)
      .forEach((r) => {
        const h = hours(r.start);
        if (!Number.isFinite(h)) return;
        const slot = slots.find((x) => x.id === slotOf(h).id);
        slot.sessions += 1;
        slot._list.push(r);
      });
    slots.forEach((s) => {
      s.onPct = weighted(s._list);
      delete s._list;
    });
    // Best: the highest on-task figure with at least three sessions behind it; else simply the busiest.
    const solid = slots.filter((s) => s.sessions >= 3 && s.onPct != null).sort((a, b) => b.onPct - a.onPct || b.sessions - a.sessions);
    const busiest = slots.filter((s) => s.sessions > 0).sort((a, b) => b.sessions - a.sessions);
    const best = solid[0] ? { ...solid[0], by: 'on-task' } : busiest[0] ? { ...busiest[0], by: 'sessions' } : null;

    const tally = new Map();
    thisWeek.forEach((r) =>
      (r.distractions || []).forEach((d) => {
        const t = tally.get(d.label) || { label: d.label, times: 0, ms: 0 };
        t.times += 1;
        t.ms += num(d.ms);
        tally.set(d.label, t);
      })
    );
    const topDistraction = [...tally.values()].sort((a, b) => b.ms - a.ms)[0] || null;

    return { thisWeek: totals(thisWeek), lastWeek: totals(lastWeek), slots, best, topDistraction };
  }

  /* ---------- one day in full ---------- */

  function daySummary(sessions, date) {
    const list = sanitiseList(sessions)
      .filter((r) => r.date === date)
      .sort((a, b) => String(a.start || a.end || '').localeCompare(String(b.start || b.end || '')));
    const tally = new Map();
    list.forEach((r) =>
      (r.distractions || []).forEach((d) => {
        const t = tally.get(d.label) || { label: d.label, times: 0, ms: 0 };
        t.times += 1;
        t.ms += num(d.ms);
        tally.set(d.label, t);
      })
    );
    const sum = (k) => list.reduce((a, r) => a + num(r[k]), 0);
    return {
      date,
      totals: {
        sessions: list.length,
        minutes: sum('focusMin'),
        onPct: weighted(list),
        drifts: sum('drifts'),
        awayMs: sum('awayMs'),
        snoozeMs: sum('snoozeMs'),
        meetingMs: sum('meetingMs'),
      },
      distractions: [...tally.values()].sort((a, b) => b.ms - a.ms).slice(0, 8),
      sessions: list,
    };
  }

  /* ---------- CSV ---------- */

  // Cells starting with = + - @ are treated as formulas by spreadsheets, and
  // intents are typed by a person. Neutralise them.
  function cell(v) {
    let t = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  }

  const CSV_HEADER = [
    'date', 'start', 'end', 'focus_min', 'intent', 'profile', 'on_task_pct',
    'drifts', 'longest_drift', 'longest_drift_s', 'away_s', 'detour_s', 'call_s',
  ];

  function sessionsToCsv(sessions) {
    const rows = sanitiseList(sessions).map((r) =>
      [
        r.date, r.start, r.end, r.focusMin, r.intent, r.profile, r.onPct == null ? '' : r.onPct,
        r.drifts, r.longest ? r.longest.label : '', r.longest ? Math.round(num(r.longest.ms) / 1000) : '',
        Math.round(num(r.awayMs) / 1000), Math.round(num(r.snoozeMs) / 1000), Math.round(num(r.meetingMs) / 1000),
      ]
        .map(cell)
        .join(',')
    );
    return [CSV_HEADER.join(',')].concat(rows).join('\r\n') + '\r\n';
  }

  return { makeRecord, addSession, sanitiseList, countOn, aggregate, weeklyReview, daySummary, SLOTS, sessionsToCsv, dateAdd, lastDays, MAX_SESSIONS };
});
