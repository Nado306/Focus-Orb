'use strict';
/* The page a blocked site is sent to during a focus session. No inline script: MV3 forbids it. */
const q = new URLSearchParams(location.search);
const url = q.get('u') || '';
const isWeb = /^https?:\/\//i.test(url);
let host = q.get('h') || '';
if (!host && isWeb) {
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { host = ''; }
}
const rule = q.get('r') || '';
const until = Number(q.get('t')) || 0;
const startedAt = Date.now();
const $ = (id) => document.getElementById(id);

document.title = host ? `Not now: ${host}` : 'Not now';
$('site').textContent = host || 'This site';
if (rule && rule !== host) $('rule').textContent = `Matched the rule “${rule}”.`;
if (!isWeb) $('open').hidden = true;

const back = $('back');
const canGoBack = history.length > 2; // the blocked page itself sits one step behind us
back.textContent = canGoBack ? 'Back' : 'Close tab';
back.addEventListener('click', () => {
  if (canGoBack) return history.go(-2);
  chrome.tabs.getCurrent((t) => (t ? chrome.tabs.remove(t.id) : window.close()));
});
$('open').addEventListener('click', () => {
  if (isWeb) location.href = url;
});

const pad = (n) => String(n).padStart(2, '0');
function tick() {
  if (!until) return;
  const left = until - Date.now();
  const time = $('time');
  if (left <= 0) {
    document.body.classList.add('done');
    $('head').textContent = 'Focus is over.';
    $('lede').textContent = host ? `${host} is all yours again.` : 'It is all yours again.';
    time.hidden = true;
    $('note').hidden = true;
    $('open').textContent = host ? `Open ${host}` : 'Open it';
    $('open').className = 'primary';
    back.className = '';
    $('arc').style.strokeDasharray = '0 100';
    return;
  }
  const s = Math.ceil(left / 1000);
  time.hidden = false;
  time.textContent = 'Focus ends in';
  const span = document.createElement('span');
  span.textContent = s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
  time.appendChild(span);
  const whole = Math.max(1, until - startedAt);
  const frac = Math.max(0, Math.min(1, left / whole));
  $('arc').style.strokeDasharray = `${(frac * 100).toFixed(2)} 100`;
  setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
}
tick();
