/*
 * Pomodoro engine: a small state machine with no DOM and no Electron.
 * Loaded by the renderer as a plain script (window.PomodoroEngine) and by
 * Node for tests (require). Time is derived from timestamps, not counted
 * ticks, so a throttled or sleeping window never drifts.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PomodoroEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60000;

  function create(getSettings, now) {
    now = now || Date.now;

    const cfg = () => getSettings();
    const dur = (phase) => Math.max(1, Number(cfg()[phase]) || 1) * MIN;

    let phase = 'focus'; // 'focus' | 'short' | 'long'
    let running = false;
    let completed = 0; // focus sessions finished (skips don't count)
    let full = dur('focus'); // length of the current phase, in ms
    let remaining = full; // ms left while not running
    let endAt = 0; // timestamp the phase ends at while running

    function start() {
      if (running) return;
      if (remaining <= 0) remaining = full;
      endAt = now() + remaining;
      running = true;
    }

    function pause() {
      if (!running) return;
      remaining = Math.max(0, endAt - now());
      running = false;
    }

    function toggle() {
      running ? pause() : start();
    }

    function enter(next) {
      phase = next;
      full = remaining = dur(next);
      running = false;
    }

    function complete() {
      const from = phase;
      const spentMs = Math.max(0, full - (running ? Math.max(0, endAt - now()) : remaining));
      let to;
      if (from === 'focus') {
        completed += 1;
        to = completed % Math.max(1, cfg().rounds) === 0 ? 'long' : 'short';
      } else {
        to = 'focus';
      }
      enter(to);
      const auto = to === 'focus' ? !!cfg().autoFocus : !!cfg().autoBreak;
      if (auto) start();
      return { from, to, auto, spentMs };
    }

    // Call regularly. Returns an event when a phase has just finished.
    function tick() {
      if (!running) return null;
      if (endAt - now() <= 0) return complete();
      return null;
    }

    // End a focus session now and count it, with the time actually spent. A break ends
    // early without counting anything. Nothing happens to a session that has not started.
    function finish() {
      const left = running ? Math.max(0, endAt - now()) : remaining;
      if (!running && left === full) return null;
      if (phase !== 'focus') {
        enter('focus');
        return { from: 'break', to: 'focus', auto: false, early: true, spentMs: 0 };
      }
      return { ...complete(), early: true };
    }

    // Restart the current phase from the top.
    function reset() {
      enter(phase);
    }

    // Jump to the next phase without counting it as a finished session.
    function skip() {
      enter(phase === 'focus' ? 'short' : 'focus');
    }

    // Pick up changed durations, but only if the current phase is untouched.
    // A phase that started less than a minute ago also picks them up (keeping the time
    // already spent), so choosing a profile in the "what are you working on?" prompt
    // can still change the length of the session it is answering for.
    function applySettings() {
      const want = dur(phase);
      if (!running && remaining === full) {
        full = remaining = want;
        return;
      }
      if (want === full) return;
      const left = running ? endAt - now() : remaining;
      const spent = full - left;
      if (spent < 0 || spent > MIN) return;
      full = want;
      if (running) endAt = now() + Math.max(0, want - spent);
      else remaining = Math.max(0, want - spent);
    }

    function snapshot() {
      const rem = running ? Math.max(0, endAt - now()) : remaining;
      const rounds = Math.max(1, Number(cfg().rounds) || 4);
      return {
        phase,
        running,
        remaining: rem,
        total: full,
        started: running || rem !== full,
        completed,
        rounds,
        cycle: phase === 'long' ? rounds : completed % rounds,
      };
    }

    return { start, pause, toggle, tick, reset, skip, finish, applySettings, snapshot };
  }

  // Where the moon sits on the tilted orbit, in the orbit's own (unrotated)
  // coordinates inside a 220 x 220 box. It starts at the far left and travels
  // clockwise over the top, so it has done a full lap when time runs out.
  // `frac` is the share of the phase still remaining (1 = just started).
  function moonAt(frac, rx, ry) {
    rx = rx || 94;
    ry = ry || 32;
    const f = Math.min(1, Math.max(0, frac));
    const elapsed = 1 - f;
    const t = Math.PI + elapsed * 2 * Math.PI;
    const s = Math.sin(t);
    return {
      x: 110 + rx * Math.cos(t),
      y: 110 + ry * s,
      behind: s < -1e-9, // upper half of the orbit passes behind the planet
      lit: f * 100, // remaining stretch of the orbit, as a percentage
      offset: elapsed * 100, // where that stretch begins
    };
  }

  // Which points of the 220 x 220 orb window are solid, and which are just
  // transparent. The window lets clicks through the transparent parts. The
  // orbit is tilted by -22 degrees, so undo that before measuring it.
  //   planetR: radius of the solid body (64 for the planet, 84 for a glass sphere)
  //   band:    how far either side of the orbit line still counts (0 = no orbit)
  function orbHit(x, y, opts) {
    const o = opts || {};
    const planetR = o.planetR || 64;
    const band = o.band == null ? 9 : o.band;
    const dx = x - 110;
    const dy = y - 110;
    if (dx * dx + dy * dy <= planetR * planetR) return true;
    if (band <= 0) return false;
    const a = (22 * Math.PI) / 180;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    const rx = 94;
    const ry = 32;
    const d = Math.hypot(lx / rx, ly / ry);
    if (d < 1e-6) return false;
    // distance to the ellipse, from the gradient of its implicit form
    const gx = lx / (rx * rx * d);
    const gy = ly / (ry * ry * d);
    return Math.abs(d - 1) / Math.hypot(gx, gy) <= band;
  }

  return { create, moonAt, orbHit };
});
