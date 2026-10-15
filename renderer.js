'use strict';
(() => {
  const E = window.PomodoroEngine;
  const api = window.orb;

  const orbEl = document.getElementById('orb');
  const timeEl = document.getElementById('time');
  const labelEl = document.getElementById('label');
  const hintEl = document.getElementById('hint');
  const dotsEl = document.getElementById('dots');
  const goalEl = document.getElementById('goal');
  const moons = [document.getElementById('moon-back'), document.getElementById('moon-front')];
  const lits = [...document.querySelectorAll('.lit')];

  const NAMES = { focus: 'Focus', short: 'Break', long: 'Long break' };

  let settings = null;
  let engine = null;
  let dotCount = 0;
  let lastState = '';
  let lastTip = '';
  let drift = { status: 'ok', reason: null, label: '' };

  // Glass-sphere themes have no orbit ring, so only the sphere itself is solid.
  const applyTheme = () => {
    document.documentElement.style.setProperty('--s', String((settings && settings.scale) || 1));
    document.body.className = `theme-${(settings && settings.theme) || 'ember'}`;
  };

  /* ---------- sound: two soft bells, synthesised, no asset files ---------- */

  let ctx = null;
  let quietTimer = null;
  // One audio context, woken for each sound and put to sleep once the last note has died
  // away (the longest lasts about 6 s). Left running, it holds the sound output open,
  // playing silence: a little CPU all day, and an open stream can keep Windows awake.
  const audio = () => {
    ctx = ctx || new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      if (ctx && ctx.state === 'running') ctx.suspend();
    }, 10000);
    return ctx;
  };

  // One struck note: a fundamental plus a few partials, each with its own level.
  function bell(freq, t0, gain, dur, partials, type) {
    const c = audio();
    const out = c.createGain();
    out.connect(c.destination);
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    (partials || [[1, 1], [2.76, 0.22], [5.4, 0.08]]).forEach(([mult, level]) => {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type || 'sine';
      o.frequency.value = freq * mult;
      g.gain.value = level;
      o.connect(g).connect(out);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    });
  }

  // A slow wobble, for the lava lamp.
  function wobble(freq, t0, gain, dur) {
    const c = audio();
    const out = c.createGain();
    out.connect(c.destination);
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(gain, t0 + 0.08);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const o = c.createOscillator();
    const lfo = c.createOscillator();
    const depth = c.createGain();
    o.frequency.value = freq;
    lfo.frequency.value = 5.5;
    depth.gain.value = freq * 0.02;
    lfo.connect(depth).connect(o.frequency);
    o.connect(out);
    [o, lfo].forEach((x) => {
      x.start(t0);
      x.stop(t0 + dur + 0.05);
    });
  }

  // A glide from one pitch to another, for the futuristic themes.
  function sweep(f0, f1, t0, gain, dur, type) {
    const c = audio();
    const out = c.createGain();
    out.connect(c.destination);
    out.gain.setValueAtTime(0.0001, t0);
    out.gain.exponentialRampToValueAtTime(gain, t0 + 0.05);
    out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const o = c.createOscillator();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.8);
    o.connect(out);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  const BOWL = [[1, 1], [2.32, 0.4], [4.25, 0.18], [6.63, 0.06]];
  const WOOD = [[1, 1], [2.8, 0.3]];
  const CHINA = [[1, 1], [2.4, 0.5], [5.9, 0.2]];

  // Each theme ends a phase with its own sound. `up` is the end of a focus session
  // (you did the thing); `down` is the end of a break (back to it).
  const CHIMES = {
    planet: {
      up: (t) => { bell(659.25, t, 0.2, 1.6); bell(987.77, t + 0.22, 0.18, 1.8); bell(1318.5, t + 0.44, 0.15, 2.4); },
      down: (t) => { bell(987.77, t, 0.18, 1.5); bell(783.99, t + 0.24, 0.16, 1.8); },
    },
    tomato: { // a kitchen timer, politely
      up: (t) => { for (let i = 0; i < 4; i++) bell(1567.98, t + i * 0.16, 0.12, 0.35, [[1, 1], [2.1, 0.3]]); },
      down: (t) => { bell(1567.98, t, 0.12, 0.4, [[1, 1], [2.1, 0.3]]); bell(1174.66, t + 0.2, 0.12, 0.6, [[1, 1], [2.1, 0.3]]); },
    },
    hourglass: { // wood on wood, as it is turned over
      up: (t) => { bell(523.25, t, 0.25, 0.25, WOOD, 'triangle'); bell(392, t + 0.18, 0.25, 0.3, WOOD, 'triangle'); bell(659.25, t + 0.5, 0.2, 0.4, WOOD, 'triangle'); },
      down: (t) => { bell(392, t, 0.25, 0.3, WOOD, 'triangle'); bell(523.25, t + 0.2, 0.22, 0.35, WOOD, 'triangle'); },
    },
    candle: { // a small singing bowl
      up: (t) => { bell(261.63, t, 0.22, 4.5, BOWL); bell(392, t + 0.9, 0.12, 3.5, BOWL); },
      down: (t) => { bell(329.63, t, 0.2, 3.5, BOWL); },
    },
    enso: { // one low gong
      up: (t) => { bell(146.83, t, 0.3, 6, BOWL); },
      down: (t) => { bell(196, t, 0.22, 4, BOWL); },
    },
    seedling: { // rising plucks
      up: (t) => { [523.25, 587.33, 659.25, 783.99, 1046.5].forEach((f, i) => bell(f, t + i * 0.13, 0.13, 0.7, [[1, 1], [2, 0.25]], 'triangle')); },
      down: (t) => { [783.99, 659.25, 523.25].forEach((f, i) => bell(f, t + i * 0.15, 0.13, 0.7, [[1, 1], [2, 0.25]], 'triangle')); },
    },
    ring: { // clean and short
      up: (t) => { bell(880, t, 0.14, 0.5, [[1, 1]]); bell(1318.5, t + 0.16, 0.14, 0.8, [[1, 1]]); },
      down: (t) => { bell(1318.5, t, 0.12, 0.5, [[1, 1]]); bell(880, t + 0.16, 0.12, 0.7, [[1, 1]]); },
    },
    lava: {
      up: (t) => { wobble(329.63, t, 0.16, 1.6); wobble(493.88, t + 0.35, 0.12, 1.8); },
      down: (t) => { wobble(392, t, 0.14, 1.4); },
    },
    reactor: { // powering up
      up: (t) => { sweep(220, 880, t, 0.1, 0.9); bell(1318.5, t + 0.75, 0.12, 1.6, [[1, 1], [2, 0.2]]); },
      down: (t) => { sweep(880, 330, t, 0.09, 0.8); },
    },
    hologlobe: { // three soft blips
      up: (t) => { [1567.98, 1760, 2093].forEach((f, i) => bell(f, t + i * 0.12, 0.08, 0.25, [[1, 1]])); },
      down: (t) => { [2093, 1567.98].forEach((f, i) => bell(f, t + i * 0.12, 0.08, 0.25, [[1, 1]])); },
    },
    hexshield: { // a shimmer as the shield locks
      up: (t) => { [2637, 3136, 3520, 2637].forEach((f, i) => bell(f, t + i * 0.07, 0.05, 1.2, [[1, 1], [1.5, 0.3]])); },
      down: (t) => { [3520, 2637].forEach((f, i) => bell(f, t + i * 0.09, 0.05, 1, [[1, 1], [1.5, 0.3]])); },
    },
    warpgate: { // dropping out of warp
      up: (t) => { sweep(1600, 160, t, 0.08, 1.1, 'triangle'); bell(659.25, t + 0.9, 0.12, 1.8); },
      down: (t) => { sweep(160, 1400, t, 0.07, 1.1, 'triangle'); },
    },
    dyson: { // a deep, warm chord as the shell closes
      up: (t) => { bell(130.81, t, 0.2, 4, BOWL); bell(196, t + 0.15, 0.14, 3.5, BOWL); bell(261.63, t + 0.3, 0.12, 3.2, BOWL); },
      down: (t) => { bell(196, t, 0.16, 3, BOWL); },
    },
    coffee: { // a café counter bell
      up: (t) => { bell(1318.5, t, 0.12, 1.4, [[1, 1], [2.7, 0.3], [5.2, 0.1]]); bell(1046.5, t + 0.32, 0.11, 1.6, [[1, 1], [2.7, 0.3], [5.2, 0.1]]); },
      down: (t) => { bell(1046.5, t, 0.11, 1.4, [[1, 1], [2.7, 0.3]]); },
    },
    tea: { // a spoon on china
      up: (t) => { [0, 0.14, 0.28].forEach((d, i) => bell(2093 + i * 120, t + d, 0.08, 0.5, CHINA)); },
      down: (t) => { bell(2349.32, t, 0.08, 0.6, CHINA); bell(1975.53, t + 0.18, 0.08, 0.8, CHINA); },
    },
  };

  // Low, soft and repeated: deliberately not the same sound as the end-of-session chimes.
  function nudgeTone() {
    const n = Math.min(8, Number(settings.nudgeDings) || 0);
    if (!settings.sound || n < 1) return;
    const t = audio().currentTime + 0.02;
    for (let i = 0; i < n; i++) bell(392, t + i * 0.55, 0.1, 1.5);
  }

  function chime(kind) {
    if (!settings.sound) return;
    const t = audio().currentTime + 0.02;
    const set = CHIMES[settings.theme] || CHIMES.planet;
    (kind === 'focus' ? set.up : set.down)(t);
  }

  /* ---------- rendering ---------- */

  const mmss = (ms) => {
    const s = Math.ceil(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  // Write to the page only when something actually changed: every write, even of the
  // same value, makes Chromium recheck styles and redraw.
  const setText = (el, t) => {
    if (el.textContent !== t) el.textContent = t;
  };
  // Progress is drawn in 2000ths. One step is under half a pixel on the longest ring, so
  // nothing visibly jumps, and the orb is redrawn every second or so instead of non-stop.
  const STEPS = 2000;
  let lastStep = -1;
  let offscreen = false; // the app says when the orb is hidden

  function render() {
    const s = engine.snapshot();
    const time = mmss(s.remaining);
    // when the phase ends, to the nearest few seconds (the blocked-page countdown uses it)
    const endAt = s.running ? Math.round((Date.now() + s.remaining) / 5000) * 5000 : 0;
    const key = `${s.running}|${s.started}|${s.phase}|${endAt}`;
    if (key !== lastState) {
      lastState = key;
      api.state({ running: s.running, started: s.started, phase: s.phase, endAt });
    }
    const tip = `${NAMES[s.phase]}: ${time}${s.running ? '' : s.started ? ' (paused)' : ''}`;
    if (tip !== lastTip) {
      lastTip = tip;
      api.tooltip(tip);
    }

    // Hidden (a full-screen app, one on the hide list, or Hide orb): the timer and the
    // messages above carry on; drawing is skipped until the orb is back.
    if (offscreen) return;

    const mode = s.running ? 'running' : s.started ? 'paused' : 'idle';
    const flash = orbEl.classList.contains('flash') ? ' flash' : '';
    const flagged = s.running && s.phase === 'focus' && (drift.status === 'drifting' || drift.status === 'away');
    const note = noteFor(s, mode, flagged);
    const cls = `phase-${s.phase} ${mode}${flash}${flagged ? ' drift' : ''}${note.show ? ' hint-on' : ''}`;
    if (orbEl.className !== cls) orbEl.className = cls;

    setText(timeEl, time);
    setText(labelEl, NAMES[s.phase]);
    setText(hintEl, note.text);

    const goal = Number(settings.dailyGoal) || 0;
    const done = Number(settings.todayCount) || 0;
    if (goalEl.hidden !== goal <= 0) goalEl.hidden = goal <= 0;
    setText(goalEl, done >= goal ? `${done}/${goal} done` : `${done}/${goal}`);
    goalEl.classList.toggle('done', goal > 0 && done >= goal);

    if (dotCount !== s.rounds) {
      dotCount = s.rounds;
      dotsEl.innerHTML = '<i></i>'.repeat(s.rounds);
    }
    [...dotsEl.children].forEach((d, i) => d.classList.toggle('on', i < s.cycle));

    const step = Math.round((s.total > 0 ? s.remaining / s.total : 0) * STEPS);
    if (step !== lastStep) {
      lastStep = step;
      const frac = step / STEPS;
      orbEl.style.setProperty('--frac', frac.toFixed(4));
      const m = E.moonAt(frac);
      moons.forEach((el) => (el.style.transform = `translate(${m.x.toFixed(2)}px, ${m.y.toFixed(2)}px)`));
      moons[0].style.display = m.behind ? '' : 'none';
      moons[1].style.display = m.behind ? 'none' : '';
      lits.forEach((el) => {
        el.style.strokeDasharray = `${m.lit.toFixed(2)} ${(100 - m.lit).toFixed(2)}`;
        el.style.strokeDashoffset = (-m.offset).toFixed(2);
      });
    }

    const title = `${time} ${NAMES[s.phase]}`;
    if (document.title !== title) document.title = title;

  }

  function noteFor(s, mode, flagged) {
    if (flagged) return { text: driftText(), show: true };
    if (s.running && s.phase === 'focus') {
      if (drift.status === 'snoozed') return { text: `Detour: ${drift.label} left`, show: true };
      if (drift.status === 'meeting') return { text: 'On a call. Not judging.', show: true };
    }
    if (mode === 'paused') return { text: 'Paused. Click to resume', show: false };
    if (mode === 'idle') return { text: 'Click to start', show: false };
    return { text: '', show: false };
  }

  function driftText() {
    if (drift.status === 'away') return 'Still there?';
    if (drift.reason === 'switching') return 'Lots of switching';
    const label = String(drift.label || 'elsewhere');
    return `Off task: ${label.length > 14 ? `${label.slice(0, 13)}…` : label}`;
  }

  function flash() {
    orbEl.classList.remove('flash');
    void orbEl.offsetWidth; // restart the animation
    orbEl.classList.add('flash');
    setTimeout(() => orbEl.classList.remove('flash'), 1500);
  }

  async function onFinish(ev) {
    flash();
    if (ev.from === 'focus') {
      chime('focus');
      const mins = settings[ev.to];
      let summary = '';
      let goalLine = '';
      try {
        const res = (await api.sessionComplete({ minutes: Math.max(1, Math.round((ev.spentMs || 0) / 60000)) })) || {};
        summary = res.text || '';
        if (res.goalHit) goalLine = `Daily goal reached: ${res.goal} sessions.`;
      } catch (err) {
        summary = '';
      }
      const advice =
        ev.to === 'long'
          ? `Long break earned: ${mins} minutes. Stand up, ideally somewhere without a screen.`
          : `Take ${mins} minutes. Away from the screen, ideally.`;
      api.notify('Focus complete', [summary, goalLine, advice].filter(Boolean).join(' '));
    } else {
      chime('break');
      api.notify('Break over', 'Back to the thing you were avoiding.');
    }
  }

  function loop() {
    const ev = engine.tick();
    if (ev) onFinish(ev);
    render();
  }

  /* ---------- input: click toggles, drag moves, right-click opens menu ---------- */

  let down = null;

  orbEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    down = { x: e.screenX, y: e.screenY, drag: false };
    orbEl.setPointerCapture(e.pointerId);
  });

  orbEl.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (!down.drag) {
      if (Math.hypot(e.screenX - down.x, e.screenY - down.y) < 5) return;
      down.drag = true;
      orbEl.classList.add('dragging');
      api.dragStart();
    }
    api.dragMove();
  });

  orbEl.addEventListener('pointerup', (e) => {
    if (!down || e.button !== 0) return;
    const wasDrag = down.drag;
    down = null;
    orbEl.classList.remove('dragging');
    if (wasDrag) {
      api.dragEnd();
    } else {
      engine.toggle();
      render();
    }
  });

  orbEl.addEventListener('pointercancel', () => {
    if (down && down.drag) api.dragEnd();
    down = null;
    orbEl.classList.remove('dragging');
  });

  orbEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.showMenu();
  });

  /* ---------- boot ---------- */

  api.getSettings().then((s) => {
    settings = s;
    engine = E.create(() => settings);

    applyTheme();
    api.onSettings((next) => {
      settings = next;
      applyTheme();
      engine.applySettings();
      render();
    });

    api.onDrift((d) => {
      drift = d;
      if (d.nudge) nudgeTone();
      render();
    });

    api.onCommand(({ type }) => {
      if (type === 'hidden' || type === 'shown') {
        offscreen = type === 'hidden';
        if (!offscreen) render(); // up to date the moment it is back
        return;
      }
      const snap = engine.snapshot();
      if (type === 'toggle') engine.toggle();
      else if (type === 'pause') {
        if (snap.running) engine.pause();
      } else if (type === 'resume') {
        if (snap.started && !snap.running) engine.start(); // never starts a fresh session by itself
      } else if (type === 'preview') nudgeTone();
      else if (type === 'preview-chime') chime('focus');
      else if (type === 'reset') engine.reset();
      else if (type === 'skip') engine.skip();
      else if (type === 'finish') {
        const ev = engine.finish();
        if (ev) onFinish(ev);
      }
      render();
    });

    render();
    setInterval(loop, 250);
  });
})();
