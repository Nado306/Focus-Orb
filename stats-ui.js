'use strict';
(() => {
  const api = window.statsApi;
  const $ = (id) => document.getElementById(id);

  const hm = (min) => {
    const m = Math.round(min);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
  };
  const dur = (ms) => {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
  };
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const weekday = (d) => {
    const [y, m, day] = d.split('-').map(Number);
    return ['S', 'M', 'T', 'W', 'T', 'F', 'S'][new Date(y, m - 1, day, 12).getDay()];
  };

  // A difference in minutes, said plainly.
  function delta(now, before) {
    const d = Math.round(now - before);
    if (before === 0 && now === 0) return { text: 'Nothing either week yet.', cls: 'quiet' };
    if (before === 0) return { text: 'Nothing the week before, so this is all new.', cls: 'up' };
    if (Math.abs(d) < 5) return { text: 'about the same as last week', cls: 'quiet' };
    return d > 0 ? { text: `up ${hm(d)} on last week`, cls: 'up' } : { text: `down ${hm(-d)} on last week`, cls: 'down' };
  }

  function renderReview(r) {
    if (!r) return;
    const cmp = $('r-compare');
    cmp.textContent = '';
    const tw = r.thisWeek;
    const lw = r.lastWeek;
    cmp.appendChild(document.createTextNode(`${hm(tw.minutes)} over ${plural(tw.sessions, 'session', 'sessions')}, `));
    const d = delta(tw.minutes, lw.minutes);
    cmp.appendChild(el('span', d.cls, d.text));
    if (tw.onPct != null && lw.onPct != null) {
      const p = tw.onPct - lw.onPct;
      cmp.appendChild(document.createTextNode('. '));
      cmp.appendChild(el('span', Math.abs(p) < 3 ? 'quiet' : p > 0 ? 'up' : 'down', `${tw.onPct}% on task (${p >= 0 ? '+' : ''}${p} ${Math.abs(p) === 1 ? 'point' : 'points'}).`));
    } else {
      cmp.appendChild(document.createTextNode('.'));
    }

    const best = r.best;
    $('r-best').textContent = !best
      ? 'Not enough sessions yet. Finish a few at different times of day.'
      : best.by === 'on-task'
        ? `${best.name}: ${best.onPct}% on task over ${plural(best.sessions, 'session', 'sessions')}.`
        : `${best.name} is when you do the most (${plural(best.sessions, 'session', 'sessions')}). Three or more in a slot gives an on-task figure.`;
    const slots = $('r-slots');
    slots.textContent = '';
    r.slots.forEach((s) => {
      const box = el('div', `slot${best && best.id === s.id ? ' best' : ''}${s.onPct == null ? ' none' : ''}`);
      box.title = `${s.name}: ${plural(s.sessions, 'session', 'sessions')}${s.onPct == null ? '' : `, ${s.onPct}% on task`}`;
      const track = el('div', 'track');
      const fill = el('div', 'fill');
      // 40% and below sit at the floor, so the differences that matter are visible
      fill.style.height = `${s.onPct == null ? 0 : Math.max(6, Math.min(100, ((s.onPct - 40) / 60) * 100))}%`;
      track.appendChild(fill);
      box.append(track, el('div', 'pct', s.onPct == null ? (s.sessions ? `${s.sessions}\u00d7` : '\u2013') : `${s.onPct}%`), el('div', 'lab', s.name));
      slots.appendChild(box);
    });

    const t = r.topDistraction;
    $('r-top').textContent = t ? `${t.label}: ${dur(t.ms)} over ${plural(t.times, 'drift', 'drifts')}.` : 'Nothing this week. Either very focused or very new.';
  }

  let selected = null;
  let lastData = null;

  const longDate = (d) => {
    const [y, m, day] = d.split('-').map(Number);
    return new Date(y, m - 1, day, 12).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  };
  const clock = (iso) => {
    if (!iso) return '';
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };
  const pctClass = (p) => (p == null ? 'n' : p >= 80 ? 'n good' : p < 60 ? 'n poor' : 'n');

  function stat(k, v) {
    const box = el('div', 'ds');
    box.append(el('div', 'k', k), el('div', 'v', v));
    return box;
  }

  async function showDay(date) {
    selected = date;
    if (lastData) render(lastData);
    const d = await api.day(date);
    const panel = $('day');
    if (!d) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    $('day-title').textContent = longDate(date);
    const t = d.totals;
    const stats = $('day-stats');
    stats.textContent = '';
    stats.append(
      stat('Sessions', String(t.sessions)),
      stat('Focus', hm(t.minutes)),
      stat('On task', t.onPct == null ? '\u2013' : `${t.onPct}%`),
      stat('Drifts', String(t.drifts))
    );

    const top = $('day-top');
    top.textContent = '';
    if (d.distractions.length) {
      top.appendChild(el('span', 'k', 'Pulled away by'));
      d.distractions.forEach((x) => {
        const tag = el('span', 'tag');
        tag.append(el('b', '', x.label), document.createTextNode(` ${dur(x.ms)}`));
        top.appendChild(tag);
      });
    }
    const extras = [
      t.awayMs ? `away ${dur(t.awayMs)}` : '',
      t.snoozeMs ? `on detours ${dur(t.snoozeMs)}` : '',
      t.meetingMs ? `on calls ${dur(t.meetingMs)}` : '',
    ].filter(Boolean);
    if (extras.length) top.appendChild(el('span', 'tag', extras.join(', ')));

    const list = $('day-list');
    list.textContent = '';
    if (!d.sessions.length) {
      list.appendChild(el('div', 'empty', 'No finished sessions this day.'));
      return;
    }
    d.sessions.forEach((r) => {
      const item = el('details', 'sess');
      const sum = el('summary');
      const when = [clock(r.start), clock(r.end)].filter(Boolean).join('\u2013') || '\u2013';
      sum.appendChild(el('span', 't', when));
      const w = el('span', 'w', r.intent || 'No note');
      if (r.profile) w.appendChild(el('small', '', r.profile));
      sum.appendChild(w);
      sum.appendChild(el('span', pctClass(r.onPct), r.onPct == null ? '\u2013' : `${r.onPct}%`));
      sum.appendChild(el('span', 'n', plural(r.drifts || 0, 'drift', 'drifts')));
      item.appendChild(sum);

      const det = el('div', 'detail');
      const calm = r.offMs >= 1000 ? ` No drifting, ${dur(r.offMs)} in short hops.` : ' No drifting.';
      det.appendChild(el('div', '', `${r.focusMin} min focus.${r.longest ? ` Longest drift ${dur(r.longest.ms)} on ${r.longest.label}.` : calm}`));
      if ((r.distractions || []).length) {
        const ul = el('ul');
        r.distractions.forEach((x) => {
          const li = el('li');
          li.append(el('span', '', x.label), el('span', '', dur(x.ms)));
          ul.appendChild(li);
        });
        det.appendChild(ul);
      }
      const more = [
        r.awayMs ? `Away ${dur(r.awayMs)}` : '',
        r.snoozeMs ? `Detour ${dur(r.snoozeMs)}` : '',
        r.meetingMs ? `On a call ${dur(r.meetingMs)}` : '',
      ].filter(Boolean);
      if (more.length) det.appendChild(el('div', 'extra', `${more.join('. ')}.`));
      item.appendChild(det);
      list.appendChild(item);
    });
  }

  $('chart').addEventListener('click', (e) => {
    const col = e.target.closest('.col');
    if (col) showDay(col.dataset.date);
  });
  $('day-close').addEventListener('click', () => {
    selected = null;
    $('day').hidden = true;
    if (lastData) render(lastData);
  });

  function render(a) {
    lastData = a;
    // the summary that used to sit in the orb's menu
    const last = $('last');
    last.hidden = !a.lastSession;
    if (a.lastSession) {
      last.textContent = '';
      last.append(el('b', '', 'Last session: '), document.createTextNode(a.lastSession));
    }
    renderReview(a.review);
    $('today').textContent = plural(a.today.sessions, 'session', 'sessions');
    const g = a.goal;
    $('today-sub').textContent = g.goal > 0 ? (g.done >= g.goal ? `${hm(a.today.minutes)}. Goal done.` : `${hm(a.today.minutes)}. Goal ${g.goal}.`) : hm(a.today.minutes);
    $('today-sub').className = g.goal > 0 && g.done >= g.goal ? 'sub done' : 'sub';
    $('week').textContent = hm(a.week.minutes);
    $('week-sub').textContent = plural(a.week.sessions, 'session', 'sessions');
    $('streak').textContent = plural(a.streak, 'day', 'days');
    $('streak-sub').textContent = a.streak > 0 ? 'in a row' : 'start one today';
    $('ontask').textContent = a.onTaskPct == null ? '\u2013' : `${a.onTaskPct}%`;

    const chart = $('chart');
    chart.textContent = '';
    const max = Math.max(60, ...a.daily.map((d) => d.minutes));
    a.daily.forEach((d, i) => {
      // each day is a button: click it to see that day in full
      const col = el('button', `col${d.date === selected ? ' sel' : ''}`);
      col.type = 'button';
      col.dataset.date = d.date;
      col.title = `${d.date}: ${hm(d.minutes)}, ${plural(d.sessions, 'session', 'sessions')}`;
      col.setAttribute('aria-label', `${longDate(d.date)}: ${hm(d.minutes)}, ${plural(d.sessions, 'session', 'sessions')}`);
      col.setAttribute('aria-pressed', String(d.date === selected));
      const bar = el('div', `bar${d.minutes > 0 ? ' has' : ''}${i === a.daily.length - 1 ? ' today' : ''}`);
      bar.style.height = `${Math.max(2, Math.round((d.minutes / max) * 84))}px`;
      col.appendChild(bar);
      col.appendChild(el('div', 'day', weekday(d.date)));
      chart.appendChild(col);
    });

    const top = $('top');
    top.textContent = '';
    if (!a.topDistractions.length) top.appendChild(el('li', 'empty', 'Nothing yet. Suspiciously virtuous.'));
    a.topDistractions.forEach((t) => {
      const li = el('li');
      li.appendChild(el('span', '', t.label));
      li.appendChild(el('span', 'm', `${dur(t.ms)} over ${plural(t.times, 'time', 'times')}`));
      top.appendChild(li);
    });

    const recent = $('recent');
    recent.textContent = '';
    if (!a.recent.length) {
      recent.appendChild(el('div', 'empty', 'No finished sessions yet.'));
    } else {
      const head = el('div', 'row head');
      ['Date', 'Working on', 'On task', 'Drifts'].forEach((h, i) => head.appendChild(el('div', i > 1 ? 'n' : '', h)));
      recent.appendChild(head);
      a.recent.forEach((r) => {
        const row = el('div', 'row');
        row.appendChild(el('div', '', r.date.slice(5)));
        const i = el('div', 'i', r.intent || '\u2013');
        if (r.profile) i.appendChild(el('small', '', r.profile));
        row.appendChild(i);
        row.appendChild(el('div', 'n', r.onPct == null ? '\u2013' : `${r.onPct}%`));
        row.appendChild(el('div', 'n', String(r.drifts || 0)));
        recent.appendChild(row);
      });
    }
  }

  $('export').addEventListener('click', async () => {
    const res = await api.exportCsv();
    const m = $('msg');
    if (res && res.ok) {
      m.textContent = `Saved ${res.count} ${res.count === 1 ? 'session' : 'sessions'} to ${res.file}`;
      m.className = 'good';
    } else if (res && res.cancelled) {
      m.textContent = '';
    } else {
      m.textContent = 'That did not save. Try a different folder.';
      m.className = 'error';
    }
  });

  api.get().then((a) => {
    if (!a) return;
    render(a);
    // open on today, or the latest day with something in it
    const withSessions = a.daily.filter((d) => d.sessions > 0);
    const start = withSessions.length ? withSessions[withSessions.length - 1].date : null;
    if (start) showDay(start);
  });
})();
