'use strict';
(() => {
  const api = window.settingsApi;
  const $ = (id) => document.getElementById(id);
  const all = (sel) => [...document.querySelectorAll(sel)];
  let snap = null;
  let savedTimer = null;

  function saidSaved(text) {
    $('saved').textContent = text || 'Saved';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => ($('saved').textContent = ''), 1600);
  }

  async function set(key, value) {
    const res = await api.set({ [key]: value });
    if (!res) return;
    const ok = res.values[key] === value;
    fill(res);
    saidSaved(ok ? 'Saved' : 'Not saved: out of range');
  }

  function fillThemes(s) {
    const box = $('themes');
    box.textContent = '';
    [['Planets', 'planets'], ['Future', 'future'], ['Other things', 'things']].forEach(([title, group]) => {
      const g = document.createElement('div');
      g.className = 'group';
      g.textContent = title;
      box.appendChild(g);
      s.themes.filter((t) => t.group === group).forEach((t) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = t.name;
        b.setAttribute('aria-pressed', String(s.values.theme === t.id));
        b.addEventListener('click', () => set('theme', t.id));
        box.appendChild(b);
      });
    });
  }

  function fill(s) {
    snap = s;
    const v = s.values;
    // profiles list
    const sel = $('profiles');
    sel.textContent = '';
    s.profiles.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    });

    all('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const val = v[key];
      if (el.classList.contains('seg')) {
        [...el.children].forEach((b) => b.setAttribute('aria-pressed', String(String(val) === b.value)));
      } else if (el.type === 'checkbox') {
        el.checked = !!val;
      } else if (document.activeElement !== el) {
        el.value = String(val);
      }
    });
    fillThemes(s);

    const pt = $('profile-timing');
    pt.hidden = !s.profileTiming;
    if (s.profileTiming) {
      const t = s.profileTiming;
      pt.textContent = `${t.name} is in use and has its own timings: ${t.focus} / ${t.short} / ${t.long} min. These below apply to the other profiles.`;
    }
    $('watcher').hidden = s.watcherOk;
    $('watcher').textContent = s.watcher;
    $('bridge-line').textContent = s.bridge.on ? 'On. Real addresses for Edge and Chrome tabs.' : 'Off. Real addresses for Edge and Chrome tabs.';
    $('block-line').textContent = s.bridge.on
      ? 'Sites on the block list are turned away while a focus session runs. Breaks and detours are left alone.'
      : 'Needs the browser link, which is off. Sites on the block list are turned away while a focus session runs.';

    const login = $('login');
    login.checked = s.startWithWindows;
    login.disabled = !s.packaged;
    $('login-note').textContent = s.startupNote || '';

    const table = $('shortcut-table');
    table.textContent = '';
    s.shortcuts.forEach((k) => {
      const tr = document.createElement('tr');
      const a = document.createElement('td');
      a.textContent = k.keys;
      const b = document.createElement('td');
      b.textContent = k.label;
      const c = document.createElement('td');
      c.textContent = k.state === 'ok' ? 'On' : k.state === 'taken' ? 'Taken by another app' : 'Off';
      if (k.state === 'taken') c.className = 'taken';
      tr.append(a, b, c);
      table.appendChild(tr);
    });

    fillHideApps(s);
    $('version').textContent = `Focus Orb ${s.version}`;
    $('data-path').textContent = `Settings and history: ${s.dataFolder}`;
  }

  // apps the orb hides for: the list, and a picker of apps used lately
  const hideList = () => (snap && snap.values.hideApps) || [];
  async function setHideApps(list, said) {
    const res = await api.set({ hideApps: list });
    if (!res) return;
    fill(res);
    saidSaved(said);
  }
  function fillHideApps(s) {
    const list = s.values.hideApps || [];
    const ul = $('hide-apps');
    ul.textContent = '';
    list.forEach((name) => {
      const li = document.createElement('li');
      li.textContent = name;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', `Stop hiding for ${name}`);
      x.addEventListener('click', () => setHideApps(list.filter((n) => n !== name), 'Removed'));
      li.appendChild(x);
      ul.appendChild(li);
    });
    const rec = $('hide-recent');
    rec.textContent = '';
    const apps = s.recentApps || [];
    if (!apps.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing yet. Use the app for a moment, then come back here.';
      rec.appendChild(li);
    }
    apps.forEach((a) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = a.name;
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = a.title;
      b.append(name, title);
      if (list.includes(a.name)) {
        b.disabled = true;
        const added = document.createElement('span');
        added.className = 'added';
        added.textContent = 'Added';
        b.appendChild(added);
      }
      b.addEventListener('click', () => setHideApps(list.concat(a.name), 'Added'));
      li.appendChild(b);
      rec.appendChild(li);
    });
  }
  $('hide-add').addEventListener('click', async (e) => {
    const picker = $('hide-picker');
    const open = picker.hidden;
    if (open) {
      const res = await api.all(); // fresh list of apps used lately
      if (res) fill(res);
    }
    picker.hidden = !open;
    e.currentTarget.setAttribute('aria-expanded', String(open));
    e.currentTarget.textContent = open ? 'Done' : 'Add app…';
  });
  $('hide-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = $('hide-name').value.trim().toLowerCase().replace(/\.exe$/, '');
    if (!raw) return;
    if (!/^[a-z0-9][a-z0-9 ._+-]{0,63}$/.test(raw)) return saidSaved('Not saved: letters, numbers, dots and dashes only');
    $('hide-name').value = '';
    if (hideList().includes(raw)) return saidSaved('Already there');
    setHideApps(hideList().concat(raw), 'Added');
  });

  // controls
  all('input[data-key]').forEach((el) => {
    if (el.type === 'checkbox') el.addEventListener('change', () => set(el.dataset.key, el.checked));
    else {
      el.addEventListener('change', () => {
        if (!el.checkValidity() || el.value === '') {
          saidSaved('Not saved: out of range');
          if (snap) el.value = String(snap.values[el.dataset.key]);
          return;
        }
        set(el.dataset.key, Number(el.value));
      });
    }
  });
  all('select[data-key]').forEach((el) =>
    el.addEventListener('change', () => set(el.dataset.key, el.hasAttribute('data-num') ? Number(el.value) : el.value))
  );
  all('.seg[data-key]').forEach((el) =>
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) set(el.dataset.key, Number(b.value));
    })
  );
  all('[data-action]').forEach((b) =>
    b.addEventListener('click', async () => {
      const res = await api.action(b.dataset.action);
      if (res) fill(res);
    })
  );
  $('login').addEventListener('change', async (e) => {
    const res = await api.action('start-with-windows', e.target.checked);
    if (res) {
      fill(res);
      saidSaved();
    }
  });

  // the side list follows the scroll, and jumps on click
  const main = $('main');
  const links = all('.side a');
  let jumping = 0;
  links.forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      links.forEach((x) => x.classList.toggle('on', x === a));
      jumping = Date.now();
      $(a.getAttribute('href').slice(1)).scrollIntoView();
    })
  );
  main.addEventListener('scroll', () => {
    if (Date.now() - jumping < 800) return; // let a click's smooth scroll finish
    let current = links[0];
    links.forEach((a) => {
      const sec = $(a.getAttribute('href').slice(1));
      if (sec.offsetTop - main.offsetTop <= main.scrollTop + 40) current = a;
    });
    links.forEach((a) => a.classList.toggle('on', a === current));
  });

  api.onChanged((s) => fill(s));
  api.all().then((s) => s && fill(s));
})();
