'use strict';
(() => {
  const api = window.profilesApi;
  const $ = (id) => document.getElementById(id);

  const listEl = $('list');
  const nameEl = $('name');
  const allowEl = $('allow');
  const blockEl = $('block');
  const msgEl = $('msg');

  let profiles = [];
  let activeId = '';
  let selectedId = '';
  let live = null;
  let globals = { focus: 25, short: 5, long: 15 };
  const T_KEYS = ['focus', 'short', 'long'];
  const T_RANGE = { focus: [5, 180], short: [1, 60], long: [1, 90] };

  const lines = (el) => el.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const current = () => profiles.find((p) => p.id === selectedId);

  function say(text, kind) {
    msgEl.textContent = text || '';
    msgEl.className = kind || '';
  }

  // Copy the form back into the selected profile.
  function commit() {
    const p = current();
    if (!p) return;
    p.name = nameEl.value.trim();
    p.allow = lines(allowEl);
    p.block = lines(blockEl);
    const t = {};
    T_KEYS.forEach((k) => {
      const v = Math.round(Number($(`t-${k}`).value));
      if ($(`t-${k}`).value !== '' && Number.isFinite(v)) t[k] = v;
    });
    if (Object.keys(t).length) p.timing = t;
    else delete p.timing;
  }

  // a timing outside its range is pointed out rather than silently dropped
  function badTiming() {
    for (const k of T_KEYS) {
      const el = $(`t-${k}`);
      if (el.value === '') continue;
      const v = Number(el.value);
      const [lo, hi] = T_RANGE[k];
      if (!Number.isFinite(v) || v < lo || v > hi) return `${el.parentElement.firstChild.textContent.trim()} must be between ${lo} and ${hi} minutes.`;
    }
    return '';
  }

  function fillSelect() {
    listEl.textContent = '';
    profiles.forEach((p) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'item';
      b.dataset.id = p.id;
      b.setAttribute('aria-current', String(p.id === selectedId));
      const n = document.createElement('span');
      n.className = 'n';
      const name = document.createElement('span');
      name.textContent = p.name || 'Untitled';
      n.appendChild(name);
      if (p.id === activeId) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'In use';
        n.appendChild(badge);
      }
      const sub = document.createElement('span');
      sub.className = 's';
      const rules = (k) => `${p[k].length} ${k}`;
      const t = p.timing ? ` \u00b7 ${p.timing.focus || globals.focus}/${p.timing.short || globals.short}` : '';
      sub.textContent = `${rules('allow')} \u00b7 ${rules('block')}${t}`;
      b.append(n, sub);
      li.appendChild(b);
      listEl.appendChild(li);
    });
  }

  function counts() {
    const n = (el) => lines(el).length;
    $('allow-count').textContent = `${n(allowEl)} ${n(allowEl) === 1 ? 'rule' : 'rules'}`;
    $('block-count').textContent = `${n(blockEl)} ${n(blockEl) === 1 ? 'rule' : 'rules'}`;
  }

  function fillForm() {
    const p = current();
    nameEl.value = p ? p.name : '';
    allowEl.value = p ? p.allow.join('\n') : '';
    blockEl.value = p ? p.block.join('\n') : '';
    T_KEYS.forEach((k) => {
      const el = $(`t-${k}`);
      el.value = p && p.timing && p.timing[k] ? String(p.timing[k]) : '';
      el.placeholder = String(globals[k]);
    });
    $('use').disabled = !p || p.id === activeId;
    $('del').disabled = profiles.length < 2;
    counts();
  }

  function showLive() {
    const winEl = $('live-win');
    const chip = $('live-chip');
    const can = !!(live && live.process);
    $('add-allow').disabled = !can;
    $('add-block').disabled = !can;
    const hasHost = !!(live && live.host);
    $('add-allow-site').hidden = !hasHost;
    $('add-block-site').hidden = !hasHost;
    if (!live) {
      winEl.textContent = 'Nothing seen yet. Use another window and it will appear here.';
      chip.hidden = true;
      return;
    }
    const title = live.title ? `\u201c${live.title.slice(0, 70)}${live.title.length > 70 ? '\u2026' : ''}\u201d` : '';
    winEl.textContent = `${live.process || 'unknown'} ${live.host ? `(${live.host}) ` : ''}${title}`.trim();
    chip.hidden = false;
    chip.className = `chip ${live.cls}`;
    chip.textContent = live.cls === 'on' ? 'On task' : live.cls === 'off' ? 'Off task' : live.why === 'meeting' ? 'Call' : 'Ignored';
    showRecent(live.recent || []);
  }

  // What the orb saw, newest first, and how it judged each window.
  let recentKey = '';
  function showRecent(list) {
    const key = list.map((r) => `${r.at}${r.cls}${r.host || ''}`).join();
    if (key === recentKey) return;
    recentKey = key;
    const ol = $('recent');
    ol.textContent = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.textContent = 'Nothing yet.';
      ol.appendChild(li);
      return;
    }
    list.forEach((r) => {
      const li = document.createElement('li');
      const cell = (cls, text) => {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = text;
        li.appendChild(s);
      };
      cell('at', new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      cell('p', r.process);
      cell('tt', r.host ? `${r.host} \u00b7 ${r.title}` : r.title || '(no title)');
      cell(`c ${r.cls}`, r.why === 'meeting' ? 'Call' : r.cls === 'on' ? 'On task' : r.cls === 'off' ? 'Off task' : 'Ignored');
      li.title = `${r.process}: ${r.title}`;
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-haspopup', 'menu');
      li.addEventListener('click', (e) => openRowMenu(r, li, e));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openRowMenu(r, li, e);
        }
      });
      ol.appendChild(li);
    });
  }

  // A small menu for one line of Recent windows: allow or block its site or its app,
  // in the profile being edited. Rules already there are shown but can't be added twice.
  let rowMenu = null;
  function closeRowMenu() {
    if (rowMenu) rowMenu.remove();
    rowMenu = null;
  }
  function openRowMenu(r, li, e) {
    if (e) e.stopPropagation();
    closeRowMenu();
    const p = current();
    if (!p) return;
    const menu = document.createElement('div');
    menu.className = 'row-menu';
    menu.setAttribute('role', 'menu');
    const head = document.createElement('div');
    head.className = 'rm-head';
    head.textContent = `Add to ${p.name || 'this profile'}`;
    menu.appendChild(head);
    const items = [];
    if (r.host) items.push(['allow', 'site', `Allow site`, r.host], ['block', 'site', `Block site`, r.host]);
    items.push(['allow', 'app', `Allow app`, r.process], ['block', 'app', `Block app`, r.process]);
    items.forEach(([list, kind, label, what]) => {
      const el = list === 'allow' ? allowEl : blockEl;
      const rule = ruleFor(r, kind);
      const have = lines(el).includes(rule);
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.className = `rm-item ${list}`;
      b.disabled = have;
      const l = document.createElement('span');
      l.textContent = label;
      const w = document.createElement('span');
      w.className = 'rm-what';
      w.textContent = have ? `${rule} (already there)` : rule;
      b.append(l, w);
      b.addEventListener('click', () => {
        addRule(el, list === 'allow' ? 'Allow' : 'Block', kind, r);
        closeRowMenu();
        li.focus();
      });
      menu.appendChild(b);
    });
    if (r.host) {
      const note = document.createElement('div');
      note.className = 'rm-note';
      note.textContent = 'An app rule covers the whole browser.';
      menu.appendChild(note);
    }
    document.body.appendChild(menu);
    const box = li.getBoundingClientRect();
    const h = menu.offsetHeight;
    const top = box.bottom + 4 + h > window.innerHeight ? box.top - h - 4 : box.bottom + 4;
    menu.style.top = `${Math.max(8, top)}px`;
    menu.style.left = `${Math.min(window.innerWidth - menu.offsetWidth - 12, Math.max(12, box.right - menu.offsetWidth - 70))}px`;
    rowMenu = menu;
    const first = menu.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }
  document.addEventListener('click', (e) => {
    if (rowMenu && !rowMenu.contains(e.target)) closeRowMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeRowMenu();
  });

  const ruleFor = (w, kind) => (kind === 'site' ? `url:${w.host}` : `app:${String(w.process).toLowerCase().replace(/\.exe$/, '')}`);

  function addRule(el, which, kind, target) {
    const w = target || live;
    if (!w) return;
    if (kind === 'site' ? !w.host : !w.process) return;
    const rule = ruleFor(w, kind);
    const existing = lines(el);
    if (existing.includes(rule)) {
      say(`${rule} is already in ${which}.`);
      return;
    }
    el.value = existing.concat(rule).join('\n');
    refreshList();
    say(`Added ${rule} to ${which}. Save to keep it.`, 'good');
  }

  // Saves what's on screen. Import and export both start here, so they always
  // work from what you can see.
  async function persist() {
    const bad = badTiming();
    if (bad) {
      say(bad, 'error');
      return false;
    }
    commit();
    if (profiles.some((p) => !p.name)) {
      say('Every profile needs a name.', 'error');
      return false;
    }
    const res = await api.save(profiles, activeId);
    if (!res) {
      say('That did not save. Close this window and try again.', 'error');
      return false;
    }
    profiles = res.profiles;
    activeId = res.activeId;
    if (!profiles.some((p) => p.id === selectedId)) selectedId = profiles[0].id;
    fillSelect();
    fillForm();
    return true;
  }

  async function save() {
    if (await persist()) say('Saved.', 'good');
  }

  const IMPORT_ERRORS = {
    'too-big': 'That file is too large to be a profile export.',
    'not-json': 'That file is not valid JSON.',
    'not-profiles': 'That is not a Focus Orb profile export.',
    empty: 'There were no usable profiles in that file.',
    read: 'That file could not be read.',
  };

  async function exportFile(scope) {
    if (!(await persist())) return;
    const r = await api.exportFile(scope, selectedId);
    if (!r || r.cancelled) return;
    if (r.ok) say(`Exported ${r.count} ${r.count === 1 ? 'profile' : 'profiles'} to ${r.file}`, 'good');
    else say('That did not save. Try a different folder.', 'error');
  }

  async function importFile() {
    if (!(await persist())) return;
    const r = await api.importFile();
    if (!r || r.cancelled) return;
    if (!r.ok) {
      say(IMPORT_ERRORS[r.error] || 'That could not be imported.', 'error');
      return;
    }
    profiles = r.profiles.map((p) => ({ ...p, allow: p.allow.slice(), block: p.block.slice() }));
    activeId = r.activeId;
    if (!profiles.some((p) => p.id === selectedId)) selectedId = profiles[0].id;
    fillSelect();
    fillForm();
    const bits = [`Added ${r.added}`];
    if (r.renamed) bits.push(`${r.renamed} renamed to avoid a clash`);
    if (r.skipped) bits.push(`${r.skipped} skipped as identical`);
    if (r.full) bits.push(`${r.full} left out (the limit is 20 profiles)`);
    say(`${bits.join(', ')}.`, r.added ? 'good' : '');
  }

  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('.item');
    if (!b || b.dataset.id === selectedId) return;
    commit();
    selectedId = b.dataset.id;
    fillSelect();
    fillForm();
    say('');
  });

  // keep the list's name and rule counts in step with what is being typed
  const refreshList = () => {
    commit();
    const keep = document.activeElement;
    fillSelect();
    if (keep && keep.focus) keep.focus();
    counts();
  };
  nameEl.addEventListener('input', refreshList);
  allowEl.addEventListener('input', refreshList);
  blockEl.addEventListener('input', refreshList);
  T_KEYS.forEach((k) => $(`t-${k}`).addEventListener('input', refreshList));

  $('new').addEventListener('click', () => {
    commit();
    const id = `p-${Date.now().toString(36)}`;
    profiles.push({ id, name: 'New profile', allow: [], block: [] });
    selectedId = id;
    fillSelect();
    fillForm();
    nameEl.focus();
    nameEl.select();
    say('Name it, add some rules, then save.');
  });

  $('del').addEventListener('click', () => {
    const p = current();
    if (!p || profiles.length < 2) return;
    if (!window.confirm(`Delete \u201c${p.name || 'Untitled'}\u201d?`)) return;
    profiles = profiles.filter((x) => x.id !== p.id);
    if (activeId === p.id) activeId = profiles[0].id;
    selectedId = profiles[0].id;
    fillSelect();
    fillForm();
    say('Deleted. Save to make it permanent.');
  });

  $('use').addEventListener('click', () => {
    commit();
    activeId = selectedId;
    fillSelect();
    fillForm();
    say('This profile will be used once you save.');
  });

  $('save').addEventListener('click', save);
  $('import').addEventListener('click', importFile);
  $('export-one').addEventListener('click', () => exportFile('one'));
  $('export-all').addEventListener('click', () => exportFile('all'));
  $('add-allow').addEventListener('click', () => addRule(allowEl, 'Allow', 'app'));
  $('add-block').addEventListener('click', () => addRule(blockEl, 'Block', 'app'));
  $('add-allow-site').addEventListener('click', () => addRule(allowEl, 'Allow', 'site'));
  $('add-block-site').addEventListener('click', () => addRule(blockEl, 'Block', 'site'));

  api.onLive((l) => {
    live = l;
    showLive();
  });

  function load(data) {
    if (!data) return;
    profiles = data.profiles.map((p) => ({ ...p, allow: p.allow.slice(), block: p.block.slice() }));
    activeId = data.activeId;
    if (data.timing) globals = data.timing;
    if (!profiles.some((p) => p.id === selectedId)) selectedId = activeId;
    live = data.live;
    fillSelect();
    fillForm();
    showLive();
  }

  // a rule added from the orb's menu while this window is open
  if (api.onChanged) {
    api.onChanged(() =>
      api.get().then((data) => {
        load(data);
        say('Updated from the orb menu.', 'good');
      })
    );
  }

  api.get().then((data) => {
    if (!data) return;
    selectedId = data.activeId;
    load(data);
    if (data.watcher === 'unsupported' || data.watcher === 'unavailable') {
      say('The window watcher is not running, so rules will not be applied yet. Idle detection still works.', 'error');
    }
  });
})();
