'use strict';
// Everything the app loads must be in the build's file list, or the built app
// cannot start, though every other test (which runs from the source folder) passes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const listed = new Set(pkg.build.files);
const covered = (f) => listed.has(f) || [...listed].some((g) => g.endsWith('/**') && f.startsWith(g.slice(0, -2)));

// follow require('./x.js') from main.js and each preload, and the pages' scripts and styles
const seen = new Set();
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = fs.readFileSync(path.join(root, file), 'utf8');
  for (const m of src.matchAll(/require\('\.\/([^']+)'\)/g)) walk(m[1]);
  for (const m of src.matchAll(/(?:file|preload):\s*'([^']+\.(?:html|js))'/g)) walk(m[1]);
  for (const m of src.matchAll(/(?:loadFile\(path\.join\(__dirname, |path\.join\(__dirname, )'([^']+\.(?:html|js))'/g)) walk(m[1]);
  if (file.endsWith('.html')) for (const m of src.matchAll(/(?:src|href)="([^":]+\.(?:js|css))"/g)) walk(m[1]);
}
walk(pkg.main);

let missing = [...seen].filter((f) => !covered(f));
assert.deepEqual(missing, [], `not in build.files: ${missing.join(', ')}`);
assert.ok(seen.has('log.js') && seen.has('winapi.js') && seen.has('settings.html') && seen.has('preload-settings.js'), `followed: ${[...seen].join(', ')}`);
// and the shipped dependency is a real dependency, so the build includes it
assert.equal(typeof (pkg.dependencies || {}).koffi, 'string');
console.log(`ok  - all ${seen.size} files the app loads are in the build\n\n1 packaging test passed`);
