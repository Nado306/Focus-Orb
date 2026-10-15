'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLog, MAX_BYTES } = require('../log.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log('ok  -', name);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orb-log-'));

test('lines are timestamped, levelled, one per event, errors with their stack on one line', () => {
  const log = createLog({ dir, now: () => new Date('2026-10-15T09:00:00Z') });
  log.info('Focus Orb 1.8.0 starting', { electron: '44.7.2' });
  log.error('Browser link could not start', new Error('EADDRINUSE'));
  const lines = fs.readFileSync(log.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '2026-10-15T09:00:00.000Z info  Focus Orb 1.8.0 starting | {"electron":"44.7.2"}');
  assert.match(lines[1], /^2026-10-15T09:00:00\.000Z error Browser link could not start \| Error: EADDRINUSE \/ +at /);
});

test('it rolls over at its size limit, keeping one previous file, so it never grows without end', () => {
  const log = createLog({ dir });
  const chunk = 'x'.repeat(400);
  for (let i = 0; i < (MAX_BYTES / 400) * 2.5; i++) log.info(chunk);
  const size = fs.statSync(log.file).size;
  assert.ok(size <= MAX_BYTES, `current file ${size} bytes`);
  assert.ok(fs.existsSync(`${log.file}.1`));
  assert.ok(fs.statSync(`${log.file}.1`).size <= MAX_BYTES);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['focus-orb.log', 'focus-orb.log.1']);
});

test('a log it cannot write is shrugged off, never thrown', () => {
  const blocker = path.join(dir, 'not-a-folder');
  fs.writeFileSync(blocker, 'x');
  const log = createLog({ dir: path.join(blocker, 'logs') });
  log.error('anything', new Error('boom'));
});

console.log(`\n${passed} log tests passed`);
