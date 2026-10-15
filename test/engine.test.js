'use strict';
const assert = require('node:assert/strict');
const { create, moonAt, orbHit } = require('../engine.js');

const MIN = 60000;
let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('ok  -', name);
}

function rig(overrides) {
  const settings = Object.assign(
    { focus: 25, short: 5, long: 15, rounds: 4, autoBreak: true, autoFocus: false },
    overrides
  );
  let t = 1_000_000;
  const clock = { advance: (ms) => (t += ms) };
  const engine = create(() => settings, () => t);
  return { settings, clock, engine };
}

test('starts idle on a full focus session', () => {
  const { engine } = rig();
  const s = engine.snapshot();
  assert.equal(s.phase, 'focus');
  assert.equal(s.running, false);
  assert.equal(s.started, false);
  assert.equal(s.remaining, 25 * MIN);
});

test('counts down from timestamps and tick returns null mid-session', () => {
  const { engine, clock } = rig();
  engine.start();
  clock.advance(10 * MIN);
  assert.equal(engine.tick(), null);
  assert.equal(engine.snapshot().remaining, 15 * MIN);
});

test('pause freezes time; resume carries on from the same point', () => {
  const { engine, clock } = rig();
  engine.start();
  clock.advance(10 * MIN);
  engine.pause();
  clock.advance(30 * MIN);
  assert.equal(engine.snapshot().remaining, 15 * MIN);
  assert.equal(engine.snapshot().started, true);
  engine.start();
  clock.advance(15 * MIN + 1);
  const ev = engine.tick();
  assert.deepEqual(ev, { from: 'focus', to: 'short', auto: true, spentMs: 25 * MIN });
});

test('long break arrives after the fourth focus session, not before', () => {
  const { engine, clock, settings } = rig();
  for (let i = 1; i <= 4; i++) {
    if (!engine.snapshot().running) engine.start();
    clock.advance(25 * MIN + 1);
    const ev = engine.tick();
    assert.equal(ev.from, 'focus');
    assert.equal(ev.to, i % 4 === 0 ? 'long' : 'short', `session ${i}`);
    assert.equal(engine.snapshot().running, true, 'breaks auto-start');
    const breakMs = (i % 4 === 0 ? settings.long : settings.short) * MIN;
    clock.advance(breakMs + 1);
    const back = engine.tick();
    assert.deepEqual(back, { from: i % 4 === 0 ? 'long' : 'short', to: 'focus', auto: false, spentMs: breakMs });
    assert.equal(engine.snapshot().running, false, 'focus waits for a click');
  }
});

test('autoFocus starts the next focus session by itself', () => {
  const { engine, clock } = rig({ autoFocus: true });
  engine.start();
  clock.advance(25 * MIN + 1);
  engine.tick(); // -> short, running
  clock.advance(5 * MIN + 1);
  const ev = engine.tick();
  assert.equal(ev.to, 'focus');
  assert.equal(ev.auto, true);
  assert.equal(engine.snapshot().running, true);
});

test('autoBreak off leaves the break waiting', () => {
  const { engine, clock } = rig({ autoBreak: false });
  engine.start();
  clock.advance(25 * MIN + 1);
  const ev = engine.tick();
  assert.equal(ev.auto, false);
  assert.equal(engine.snapshot().running, false);
  assert.equal(engine.snapshot().phase, 'short');
});

test('skip does not count a session and never triggers a long break', () => {
  const { engine } = rig();
  engine.skip(); // focus -> short
  assert.equal(engine.snapshot().phase, 'short');
  assert.equal(engine.snapshot().completed, 0);
  engine.skip(); // short -> focus
  assert.equal(engine.snapshot().phase, 'focus');
  assert.equal(engine.snapshot().completed, 0);
});

test('reset restarts the current phase and stops the clock', () => {
  const { engine, clock } = rig();
  engine.start();
  clock.advance(7 * MIN);
  engine.reset();
  const s = engine.snapshot();
  assert.equal(s.running, false);
  assert.equal(s.remaining, 25 * MIN);
  assert.equal(s.phase, 'focus');
});

test('changed durations apply to an untouched phase only', () => {
  const { engine, clock, settings } = rig();
  settings.focus = 50;
  engine.applySettings();
  assert.equal(engine.snapshot().remaining, 50 * MIN);
  assert.equal(engine.snapshot().total, 50 * MIN);

  engine.start();
  clock.advance(5 * MIN);
  engine.pause();
  settings.focus = 15;
  engine.applySettings();
  assert.equal(engine.snapshot().remaining, 45 * MIN, 'a started phase keeps its length');
});

test('cycle dots fill per session and stay full through the long break', () => {
  const { engine, clock } = rig();
  const seen = [];
  for (let i = 0; i < 4; i++) {
    if (!engine.snapshot().running) engine.start();
    clock.advance(25 * MIN + 1);
    engine.tick();
    seen.push(engine.snapshot().cycle);
    // let the break run out so the next focus can begin
    clock.advance(16 * MIN);
    engine.tick();
  }
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.equal(engine.snapshot().cycle, 0, 'a new cycle starts empty');
});

test('a long sleep still finishes exactly one phase', () => {
  const { engine, clock } = rig();
  engine.start();
  clock.advance(8 * 60 * MIN); // laptop lid closed overnight
  const ev = engine.tick();
  assert.equal(ev.from, 'focus');
  assert.equal(engine.snapshot().completed, 1);
});

test('moon starts at the far left and finishes where it began', () => {
  const a = moonAt(1);
  const b = moonAt(0);
  assert.ok(Math.abs(a.x - 16) < 1e-9 && Math.abs(a.y - 110) < 1e-9);
  assert.ok(Math.abs(b.x - a.x) < 1e-9 && Math.abs(b.y - a.y) < 1e-9);
  assert.equal(a.lit, 100);
  assert.equal(b.lit, 0);
});

test('moon passes behind the planet over the top and in front underneath', () => {
  const top = moonAt(0.75);
  assert.ok(Math.abs(top.x - 110) < 1e-9 && Math.abs(top.y - 78) < 1e-9);
  assert.equal(top.behind, true);
  const right = moonAt(0.5);
  assert.ok(Math.abs(right.x - 204) < 1e-9 && Math.abs(right.y - 110) < 1e-9);
  const bottom = moonAt(0.25);
  assert.ok(Math.abs(bottom.y - 142) < 1e-9);
  assert.equal(bottom.behind, false);
});

test('lit stretch and moon agree: the lit orbit begins where the moon is', () => {
  for (const f of [1, 0.8, 0.5, 0.2, 0]) {
    const m = moonAt(f);
    assert.ok(Math.abs(m.lit + m.offset - 100) < 1e-9);
  }
  assert.equal(moonAt(2).lit, 100, 'out-of-range input is clamped');
  assert.equal(moonAt(-1).lit, 0);
});

test('click-through: planet and ring are solid, the transparent corners and gaps are not', () => {
  assert.equal(orbHit(110, 110), true, 'centre of the planet');
  assert.equal(orbHit(160, 110), true, 'inside the planet');
  assert.equal(orbHit(4, 4), false, 'top-left corner');
  assert.equal(orbHit(216, 216), false, 'bottom-right corner');
  assert.equal(orbHit(110, 205), false, 'below the planet, away from the ring');
  assert.equal(orbHit(110, 12), false, 'above the planet, away from the ring');
  // the ring: the orbit's far-right point, tilted -22 degrees about the centre
  const a = (22 * Math.PI) / 180;
  const on = [110 + 94 * Math.cos(a), 110 - 94 * Math.sin(a)];
  assert.equal(orbHit(on[0], on[1]), true, 'on the ring');
  assert.equal(orbHit(on[0] + 4, on[1] - 4), true, 'a few pixels off the ring still counts');
  const off = [110 + 125 * Math.cos(a), 110 - 125 * Math.sin(a)];
  assert.equal(orbHit(off[0], off[1]), false, 'well outside the ring');
  // where the moon sits is always on the ring
  [1, 0.8, 0.6, 0.3, 0.05].forEach((f) => {
    const m = moonAt(f);
    const dx = m.x - 110;
    const dy = m.y - 110;
    const x = 110 + dx * Math.cos(-a) - dy * Math.sin(-a);
    const y = 110 + dx * Math.sin(-a) + dy * Math.cos(-a);
    assert.equal(orbHit(x, y), true, `moon at ${f}`);
  });
});

test('click-through: a glass-sphere theme has no ring and a bigger body', () => {
  const glass = { planetR: 84, band: 0 };
  assert.equal(orbHit(110 + 80, 110, glass), true);
  assert.equal(orbHit(110 + 80, 110), false, 'outside the 64px planet');
  const a = (22 * Math.PI) / 180;
  assert.equal(orbHit(110 + 94 * Math.cos(a), 110 - 94 * Math.sin(a), glass), false, 'no ring to click');
});

test('a profile change in the first minute of a phase retimes it, keeping the time spent', () => {
  const { engine, clock, settings } = rig();
  engine.start();
  clock.advance(20 * 1000);
  settings.focus = 50;
  engine.applySettings();
  assert.equal(engine.snapshot().total, 50 * MIN);
  assert.equal(engine.snapshot().remaining, 50 * MIN - 20 * 1000);
});

test('after the first minute a running phase keeps its length', () => {
  const { engine, clock, settings } = rig();
  engine.start();
  clock.advance(3 * MIN);
  settings.focus = 50;
  engine.applySettings();
  assert.equal(engine.snapshot().total, 25 * MIN);
  assert.equal(engine.snapshot().remaining, 22 * MIN);
});

test('finish: a focus session ends now, counts, and knows how long it really was', () => {
  const { engine, clock } = rig();
  assert.equal(engine.finish(), null, 'nothing to finish before it starts');
  engine.start();
  clock.advance(12 * MIN);
  const ev = engine.finish();
  assert.equal(ev.from, 'focus');
  assert.equal(ev.to, 'short');
  assert.equal(ev.early, true);
  assert.equal(ev.spentMs, 12 * MIN);
  assert.equal(engine.snapshot().completed, 1, 'it counts');
  assert.equal(engine.snapshot().phase, 'short');
});

test('finish during a break ends it without counting anything', () => {
  const { engine, clock } = rig({ autoBreak: true });
  engine.start();
  clock.advance(25 * MIN);
  engine.tick();
  clock.advance(MIN);
  const ev = engine.finish();
  assert.equal(ev.to, 'focus');
  assert.equal(engine.snapshot().completed, 1);
  assert.equal(engine.snapshot().phase, 'focus');
  assert.equal(engine.snapshot().running, false);
});

test('a session that runs its full length reports its full length', () => {
  const { engine, clock } = rig();
  engine.start();
  clock.advance(25 * MIN);
  assert.equal(engine.tick().spentMs, 25 * MIN);
});

console.log(`\n${passed} tests passed`);
