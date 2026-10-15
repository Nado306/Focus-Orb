'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createBridge, sign } = require('../bridge.js');

const TOKEN = 'a'.repeat(32);
const tabs = [];
let passed = 0;

function request(port, { method = 'POST', url = '/tab', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers, agent: false }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, sig: res.headers['x-orb-sig'] }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.code }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
// A request signed the way the extension signs it.
function signed(url, body, { token = TOKEN, ts = Date.now(), extra = {} } = {}) {
  return { 'Content-Type': 'application/json', 'X-Orb-Ts': String(ts), 'X-Orb-Sig': sign(token, `req:${ts}:${url}:${body}`), ...extra };
}
const post = (port, url, obj, opts = {}) => {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const ts = opts.ts || Date.now();
  return request(port, { url, headers: signed(url, body, { ...opts, ts }), body }).then((r) => ({ ...r, ts }));
};
const replySigned = (r) => r.sig === sign(TOKEN, `res:${r.ts}:${r.body}`);

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('ok  -', name);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for something to happen, up to a generous limit: build machines can be slow, and a
// fixed pause long enough for the slowest would make every run slow.
async function until(ok, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await wait(20);
}

// The extension's service worker in a sandbox, with a stubbed chrome and the real fetch.
function extension({ port, tabNow, store = {}, version = '1.4.0', fetchVia } = {}) {
  const listeners = {};
  const ev = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  const calls = [];
  const updates = [];
  let reloads = 0;
  const state = { tab: tabNow || { id: 1, url: 'https://www.youtube.com/watch?v=1', title: 'Funny cats - YouTube', active: true } };
  const sandbox = {
    console, setTimeout, clearTimeout, URLSearchParams, TextEncoder, crypto: globalThis.crypto,
    chrome: {
      runtime: { getURL: (f) => `chrome-extension://abc/${f}`, getManifest: () => ({ version }), reload: () => { reloads += 1; }, onStartup: ev('startup'), onInstalled: ev('installed') },
      tabs: { query: async () => [state.tab], update: async (id, o) => updates.push([id, o.url]), onActivated: ev('activated'), onUpdated: ev('updated') },
      windows: { onFocusChanged: ev('focus'), WINDOW_ID_NONE: -1 },
      alarms: { create() {}, onAlarm: ev('alarm') },
      storage: { local: { get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) } },
    },
    fetch: async (url, init) => {
      if (String(url).startsWith('chrome-extension://')) return { json: async () => ({ token: TOKEN, port }) };
      calls.push({ url: String(url).replace(/^http:\/\/127\.0\.0\.1:\d+/, ''), port: Number(/:(\d+)\//.exec(url)[1]), init });
      if (process.env.FO_SLOW_MS) await wait(Number(process.env.FO_SLOW_MS)); // play a slow machine
      return (fetchVia || fetch)(url, init);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8'), sandbox);
  return { listeners, calls, updates, state, store, reloads: () => reloads };
}

(async () => {
  const bridge = createBridge({ getToken: () => TOKEN, basePort: 0, onTab: (t) => tabs.push(t) });
  const port = await bridge.start();

  await test('a signed report from an extension is accepted, delivered, and the reply is signed', async () => {
    const r = await post(port, '/tab', { url: 'https://www.reddit.com/r/all', title: 'r/all' }, { extra: { Origin: 'chrome-extension://abcdef' } });
    assert.equal(r.status, 200);
    assert.deepEqual(tabs.pop(), { url: 'https://www.reddit.com/r/all', title: 'r/all' });
    assert.ok(replySigned(r), 'the extension can tell the reply came from the app');
  });

  await test('hello: the app proves it knows the secret, without the caller showing anything', async () => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const r = await request(port, { url: '/hello', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }) });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).proof, sign(TOKEN, `hello:${nonce}`));
    assert.equal((await request(port, { url: '/hello', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: 'req:1:/tab:x' }) })).status, 400, 'only a plain nonce: it cannot be used to sign anything else');
    assert.equal((await request(port, { url: '/hello', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ nonce }) })).status, 403);
    assert.equal(tabs.length, 0);
  });

  await test('unsigned, wrongly signed, altered, stale or redirected requests are refused, and nothing is delivered', async () => {
    const body = JSON.stringify({ url: 'https://example.com', title: 'x' });
    assert.equal((await request(port, { headers: { 'Content-Type': 'application/json' }, body })).status, 401, 'no signature');
    assert.equal((await post(port, '/tab', body, { token: 'b'.repeat(32) })).status, 401, 'signed with another secret');
    const h = signed('/tab', body);
    assert.equal((await request(port, { headers: h, body: body.replace('example', 'exemple') })).status, 401, 'body altered after signing');
    assert.equal((await request(port, { url: '/check', headers: h, body })).status, 401, 'signed for /tab, sent to /check');
    assert.equal((await post(port, '/tab', body, { ts: Date.now() - 6 * 60 * 1000 })).status, 401, 'too old');
    const weak = createBridge({ getToken: () => 'short', basePort: 0, onTab: (t) => tabs.push(t) });
    const wp = await weak.start();
    assert.equal((await post(wp, '/tab', body, { token: 'short' })).status, 401, 'a weak secret is never accepted');
    weak.stop();
    assert.equal(tabs.length, 0);
  });

  await test('an extension from before signing is told only to update, and nothing it sends is used', async () => {
    const b = createBridge({ getToken: () => TOKEN, basePort: 0, onTab: (t) => tabs.push(t), extVersion: () => '1.4.0' });
    const p = await b.start();
    const body = JSON.stringify({ url: 'https://example.com', title: 'x' });
    const r = await request(p, { headers: { 'Content-Type': 'application/json', 'X-Orb-Token': TOKEN }, body });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { ok: true, ext: '1.4.0', upgrade: true });
    assert.equal((await request(p, { headers: { 'Content-Type': 'application/json', 'X-Orb-Token': 'b'.repeat(32) }, body })).status, 401);
    assert.equal(tabs.length, 0);
    b.stop();
  });

  await test('a web page cannot talk to it, even with a valid signature', async () => {
    const r = await post(port, '/tab', { url: 'https://example.com', title: 'x' }, { extra: { Origin: 'https://evil.example' } });
    assert.equal(r.status, 403);
    assert.equal(tabs.length, 0);
  });

  await test('wrong method, path, content type, junk and oversize bodies are refused', async () => {
    const ok = JSON.stringify({ url: 'https://example.com', title: 'x' });
    assert.equal((await request(port, { method: 'GET', url: '/tab', headers: signed('/tab', '') })).status, 404);
    assert.equal((await request(port, { url: '/other', headers: signed('/other', ok), body: ok })).status, 404);
    assert.equal((await request(port, { headers: { ...signed('/tab', ok), 'Content-Type': 'text/plain' }, body: ok })).status, 415);
    assert.equal((await post(port, '/tab', '{nope')).status, 400);
    assert.equal((await post(port, '/tab', { url: 'javascript:alert(1)', title: 'x' })).status, 400);
    assert.equal((await post(port, '/tab', { url: 'https://e.example/' + 'a'.repeat(3000), title: 'x' })).status, 400);
    const big = await post(port, '/tab', { url: 'https://example.com', title: 'x'.repeat(20000) });
    assert.ok(big.status === 413 || big.status === 0, `oversize refused (${big.status})`);
    assert.equal(tabs.length, 0);
  });

  await test('a page that re-points its own domain at this computer (DNS rebinding) is refused by Host', async () => {
    const body = JSON.stringify({ url: 'https://example.com', title: 'x' });
    assert.equal((await request(port, { headers: { ...signed('/tab', body), Host: `evil.example:${port}` }, body })).status, 403);
    assert.equal((await request(port, { headers: { ...signed('/tab', body), Host: `localhost:${port}` }, body })).status, 200, 'localhost is fine');
    tabs.pop();
    assert.equal(tabs.length, 0);
  });

  await test('titles are trimmed to a sane length', async () => {
    const r = await post(port, '/tab', { url: 'https://example.com', title: 'x'.repeat(1000) });
    assert.equal(r.status, 200);
    assert.equal(tabs.pop().title.length, 300);
  });

  await test('it only listens on loopback', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'bridge.js'), 'utf8');
    assert.ok(src.includes("'127.0.0.1'"), 'bound to 127.0.0.1');
    assert.ok(!src.includes('0.0.0.0'));
  });

  await test('a busy port makes it try the next one', async () => {
    const blocker = http.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = blocker.address().port;
    const b = createBridge({ getToken: () => TOKEN, basePort: busy, span: 3, onTab() {} });
    const got = await b.start();
    assert.ok(got > busy && got <= busy + 3, `picked ${got}`);
    b.stop();
    blocker.close();
  });

  await test('/check asks without reporting, and either endpoint can carry a block, signed', async () => {
    const seen = [];
    const verdict = { rule: 'youtube', host: 'youtube.com', until: 123 };
    const b = createBridge({ getToken: () => TOKEN, basePort: 0, onTab: (t) => { seen.push(t); return null; }, onCheck: (t) => (t.url.includes('youtube') ? verdict : null) });
    const p = await b.start();
    let r = await post(p, '/check', { url: 'https://www.youtube.com/', title: 'YouTube' });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body).block, verdict);
    assert.ok(replySigned(r));
    assert.equal(seen.length, 0, 'a check is not a report');
    r = await post(p, '/check', { url: 'https://github.com/', title: 'x' });
    assert.equal(JSON.parse(r.body).block, undefined);
    r = await post(p, '/tab', { url: 'https://www.youtube.com/', title: 'YouTube' });
    assert.equal(JSON.parse(r.body).block, undefined, 'a report with no verdict has no block');
    assert.equal(seen.length, 1);
    b.stop();
  });

  /* ---------- the extension's service worker, against the real listener ---------- */

  await test('extension: asks the app to prove itself, then reports signed; the secret is never sent', async () => {
    const got = [];
    const b = createBridge({ getToken: () => TOKEN, basePort: 0, onTab: (t) => got.push(t) });
    const p = await b.start();
    const ext = extension({ port: p });
    ext.listeners.activated();
    await until(() => got.length >= 1);
    assert.deepEqual(ext.calls.map((c) => c.url), ['/hello', '/tab']);
    assert.deepEqual(got, [{ url: 'https://www.youtube.com/watch?v=1', title: 'Funny cats - YouTube' }]);
    ext.calls.forEach((c) => {
      assert.ok(!JSON.stringify(c.init).includes(TOKEN), 'the secret appears in no request');
      assert.equal(c.init.headers['X-Orb-Token'], undefined);
    });

    ext.calls.length = 0;
    ext.listeners.updated(1, { title: 'Another title' }, { active: false });
    await wait(400);
    assert.equal(ext.calls.length, 0, 'background tab changes are ignored');
    ext.listeners.updated(1, { title: 'Another title' }, { active: true });
    ext.listeners.focus(-1);
    await until(() => ext.calls.length >= 1);
    await wait(400); // and nothing more arrives
    assert.deepEqual(ext.calls.map((c) => c.url), ['/tab'], 'debounced to one report, and no second proof needed so soon');

    ext.calls.length = 0;
    ext.state.tab = { url: undefined, title: 'x', active: true };
    ext.listeners.alarm();
    await wait(400);
    assert.equal(ext.calls.length, 0, 'tabs without an address are skipped');
    b.stop();

    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*'], 'the extension can only contact localhost');
  });

  await test('extension: something else on the port learns nothing; the real app on the next port gets the report', async () => {
    const heard = [];
    const impostor = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        heard.push({ path: req.url, body, headers: req.headers });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ proof: 'f'.repeat(64), ok: true }));
      });
    });
    await new Promise((r) => impostor.listen(0, '127.0.0.1', r));
    const taken = impostor.address().port;
    const got = [];
    const b = createBridge({ getToken: () => TOKEN, basePort: taken, span: 3, onTab: (t) => got.push(t) });
    const p = await b.start();
    assert.ok(p > taken);
    const ext = extension({ port: taken });
    ext.listeners.activated();
    await until(() => got.length >= 1);
    assert.deepEqual(heard.map((h) => h.path), ['/hello'], 'the impostor only ever saw a challenge');
    assert.ok(!JSON.stringify(heard).includes('youtube'), 'never the address');
    assert.ok(!JSON.stringify(heard).includes(TOKEN), 'never the secret');
    assert.deepEqual(got.map((t) => t.url), ['https://www.youtube.com/watch?v=1'], 'the real app got it');
    b.stop();
    impostor.close();
  });

  await test('extension: a reply the app did not sign is ignored, so nothing else can make it block a page', async () => {
    // a listener that somehow passes the challenge, but cannot sign replies
    const fake = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url === '/hello') return res.end(JSON.stringify({ proof: sign(TOKEN, `hello:${JSON.parse(body).nonce}`) }));
        res.end(JSON.stringify({ ok: true, block: { rule: 'x', host: 'github.com', until: 0 } }));
      });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const ext = extension({ port: fake.address().port });
    ext.listeners.updated(5, { url: 'https://github.com/' }, { id: 5, active: false });
    await wait(300);
    assert.equal(ext.updates.length, 0, 'no unsigned verdict is acted on');
    fake.close();
  });

  await test('extension: a blocked address is sent to the extension page, at once, in any tab', async () => {
    const verdict = { rule: 'youtube', host: 'youtube.com', until: 999 };
    const b = createBridge({ getToken: () => TOKEN, basePort: 0, onTab: () => null, onCheck: (t) => (t.url.includes('youtube') ? verdict : null) });
    const p = await b.start();
    const ext = extension({ port: p, tabNow: { id: 7, url: 'https://github.com/', title: 'GitHub', active: true } });
    ext.listeners.updated(9, { url: 'https://www.youtube.com/watch?v=1' }, { id: 9, active: false, title: '' });
    await until(() => ext.updates.length >= 1);
    assert.deepEqual(ext.calls.map((c) => c.url), ['/hello', '/check'], 'checked straight away, even in a background tab');
    assert.equal(ext.updates.length, 1);
    assert.equal(ext.updates[0][0], 9);
    assert.equal(ext.updates[0][1].split('?')[0], 'chrome-extension://abc/blocked.html');
    const u = new URL(ext.updates[0][1].replace('chrome-extension://abc', 'https://x'));
    assert.deepEqual([u.searchParams.get('u'), u.searchParams.get('h'), u.searchParams.get('r'), u.searchParams.get('t')], ['https://www.youtube.com/watch?v=1', 'youtube.com', 'youtube', '999']);

    ext.listeners.updated(9, { url: 'https://www.youtube.com/watch?v=1' }, { id: 9, active: false });
    await wait(150);
    assert.equal(ext.updates.length, 1, 'the same address in the same tab is turned away once');

    ext.calls.length = 0;
    ext.listeners.updated(8, { url: 'https://github.com/x' }, { id: 8, active: false });
    ext.listeners.updated(8, { url: 'chrome-extension://abc/blocked.html?u=x' }, { id: 8, active: false });
    await wait(150);
    assert.equal(ext.updates.length, 1, 'allowed sites and our own page are left alone');
    assert.ok(!ext.calls.some((c) => JSON.stringify(c.init.body || '').includes('chrome-extension://')), 'our own page is not even asked about');

    // focus starts while a blocked site is already open: the regular report turns it away
    const b2 = createBridge({ getToken: () => TOKEN, basePort: 0, onTab: (t) => (t.url.includes('youtube') ? verdict : null) });
    const p2 = await b2.start();
    const ext2 = extension({ port: p2, tabNow: { id: 3, url: 'https://www.youtube.com/', title: 'YouTube', active: true } });
    ext2.listeners.alarm();
    await until(() => ext2.updates.length >= 1);
    assert.deepEqual(ext2.updates.map((x) => x[0]), [3]);
    b.stop();
    b2.stop();
  });

  await test('extension: reloads itself once when the app expects a newer version, and never loops', async () => {
    const run = async (expect, storeInit) => {
      const b = createBridge({ getToken: () => TOKEN, basePort: 0, onTab: () => null, extVersion: () => expect });
      const p = await b.start();
      const ext = extension({ port: p, version: '1.0.0', store: { ...storeInit }, tabNow: { id: 1, url: 'https://example.com/', title: 'x', active: true } });
      for (let i = 1; i <= 3; i++) {
        ext.listeners.alarm();
        await until(() => ext.calls.filter((c) => c.url === '/tab').length >= i);
        await wait(50);
      }
      b.stop();
      return { reloads: ext.reloads(), store: ext.store };
    };
    assert.equal((await run('1.0.0', {})).reloads, 0, 'same version: nothing to do');
    assert.equal((await run('', {})).reloads, 0, 'an app that sends no version: nothing to do');
    const newer = await run('1.4.0', {});
    assert.equal(newer.reloads, 1, 'three reports, one reload');
    assert.equal(newer.store.reloadedFor, '1.4.0');
    assert.equal((await run('1.4.0', { reloadedFor: '1.4.0' })).reloads, 0, 'already tried for this version: stale files cannot cause a loop');
  });

  await test('the app says which extension version it expects', async () => {
    const b = createBridge({ getToken: () => TOKEN, basePort: 0, onTab() {}, extVersion: () => '9.9.9' });
    const p = await b.start();
    const r = await post(p, '/tab', { url: 'https://example.com', title: 'x' });
    assert.deepEqual(JSON.parse(r.body), { ok: true, ext: '9.9.9' });
    b.stop();
  });

  bridge.stop();
  console.log(`\n${passed} bridge tests passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
