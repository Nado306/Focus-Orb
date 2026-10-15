'use strict';
/*
 * Reports the active tab's address and title to Focus Orb on this computer, and,
 * if the app says so during a focus session, turns away a site on the block list.
 * Nothing goes anywhere else: the only host this extension may contact is
 * 127.0.0.1 (see manifest.json). config.json, written by the Focus Orb app,
 * holds the port and the shared secret, which is used to sign, never sent.
 */
const PORT_SPAN = 10;
let config = null;
let livePort = null;
let timer = null;

async function loadConfig() {
  if (config) return config;
  try {
    const res = await fetch(chrome.runtime.getURL('config.json'));
    const c = await res.json();
    if (c && c.token && c.port) config = c;
  } catch (e) {
    config = null;
  }
  return config;
}

// The app copies newer extension files into this folder when it starts and
// says which version it expects. If ours is different, reload from disk, but
// only once per expected version, so stale files can never cause a loop.
async function maybeReload(body) {
  try {
    const want = body && body.ext;
    if (!want || want === chrome.runtime.getManifest().version) return;
    const { reloadedFor } = await chrome.storage.local.get('reloadedFor');
    if (reloadedFor === want) return;
    await chrome.storage.local.set({ reloadedFor: want });
    chrome.runtime.reload();
  } catch (e) {
    /* an older app that doesn't send a version: nothing to do */
  }
}

// The secret never leaves this extension. Before sending anything to a port, it asks
// whoever is listening to prove they know the secret; then it signs each request with
// it, and acts only on replies the app has signed. Something else that happened to grab
// the port first (while the app was closed, say) learns nothing and can make it do nothing.
const VERIFY_FOR_MS = 60 * 1000;
let verified = { port: null, at: 0 };
let keyCache = { token: null, key: null };

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
async function sign(token, msg) {
  if (keyCache.token !== token) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache = { token, key };
  }
  return hex(await crypto.subtle.sign('HMAC', keyCache.key, new TextEncoder().encode(msg)));
}

async function isTheApp(c, p) {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const res = await fetch(`http://127.0.0.1:${p}/hello`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  if (!res.ok) return false;
  const body = await res.json();
  return !!body && body.proof === (await sign(c.token, `hello:${nonce}`));
}

// POST to the app; the reply (or {} if it has none) when it answered, null when not.
async function send(path, tab) {
  const c = await loadConfig();
  if (!c) return null;
  const ports = livePort ? [livePort] : Array.from({ length: PORT_SPAN + 1 }, (_, i) => c.port + i);
  for (const p of ports) {
    try {
      if (verified.port !== p || Date.now() - verified.at > VERIFY_FOR_MS) {
        verified = { port: null, at: 0 };
        if (!(await isTheApp(c, p))) {
          if (livePort === p) livePort = null;
          config = null; // perhaps a new secret: re-read config.json next time
          continue;
        }
        verified = { port: p, at: Date.now() };
      }
      const body = JSON.stringify({ url: tab.url, title: tab.title || '' });
      const ts = String(Date.now());
      const res = await fetch(`http://127.0.0.1:${p}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orb-Ts': ts, 'X-Orb-Sig': await sign(c.token, `req:${ts}:${path}:${body}`) },
        body,
      });
      const text = await res.text();
      if (res.ok && res.headers.get('X-Orb-Sig') === (await sign(c.token, `res:${ts}:${text}`))) {
        livePort = p;
        try {
          return JSON.parse(text) || {};
        } catch (e) {
          return {};
        }
      }
      verified = { port: null, at: 0 };
      if (res.status === 401) config = null;
    } catch (e) {
      if (livePort === p) livePort = null;
      verified = { port: null, at: 0 };
    }
  }
  return null;
}

const isWeb = (url) => /^https?:\/\//i.test(String(url || ''));

// During a focus session, with blocking switched on in the app, the app answers
// with what to block. The tab is sent to a page of ours that says why and when
// focus ends. Only the app decides; nothing is blocked when it is not running.
const turnedAway = new Map(); // tab id -> address just turned away, so it is done once
async function turnAway(tabId, url, block) {
  if (!block || tabId == null || !isWeb(url)) return;
  const last = turnedAway.get(tabId);
  if (last && last.url === url && Date.now() - last.at < 3000) return;
  turnedAway.set(tabId, { url, at: Date.now() });
  const q = new URLSearchParams({ u: url, h: String(block.host || ''), r: String(block.rule || ''), t: String(block.until || 0) });
  try {
    await chrome.tabs.update(tabId, { url: `${chrome.runtime.getURL('blocked.html')}?${q}` });
  } catch (e) {
    /* the tab has gone */
  }
}

async function report() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url) return;
    const body = await send('/tab', tab);
    if (!body) return;
    if (body.block) await turnAway(tab.id, tab.url, body.block);
    await maybeReload(body);
  } catch (e) {
    /* the browser is shutting down, or there is no window */
  }
}

// Every new address, in any tab, is checked straight away, without waiting for the
// usual report, so a blocked page is turned away before it has had time to settle.
async function check(tabId, url, title) {
  if (!isWeb(url)) return;
  const body = await send('/check', { url, title });
  if (body && body.block) await turnAway(tabId, url, body.block);
}

function soon() {
  clearTimeout(timer);
  timer = setTimeout(report, 250);
}

chrome.tabs.onActivated.addListener(soon);
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url) check(id, change.url, tab && tab.title);
  if (tab && tab.active && (change.url || change.title || change.status === 'complete')) soon();
});
chrome.windows.onFocusChanged.addListener((id) => {
  if (id !== chrome.windows.WINDOW_ID_NONE) soon();
});
chrome.runtime.onStartup.addListener(soon);
chrome.runtime.onInstalled.addListener(soon);
chrome.alarms.create('focus-orb-beat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(soon);
