'use strict';
/*
 * A tiny local listener for the browser extension.
 *
 * Deliberately narrow: loopback only, three endpoints (POST /hello proves this is
 * the app; POST /tab reports the active tab; POST /check only asks whether a page
 * should be turned away), a shared
 * secret on every request, small bodies, and a refusal of anything that
 * arrives with a web page's Origin. It only ever receives the active tab's
 * address and title, and the caller keeps them in memory.
 */
const http = require('http');
const crypto = require('crypto');

const MAX_BODY = 8192;
const MAX_URL = 2048;
const SKEW_MS = 5 * 60 * 1000; // how far a signed request's clock may be from ours

// The secret itself never crosses the wire. Each side proves it knows it by signing:
//   hello:<nonce>               the app answers a challenge, before the extension sends anything
//   req:<ts>:<path>:<body>      the extension signs each request
//   res:<ts>:<body>             the app signs each reply, tied to that request
// The prefixes keep the three apart, so an answer to one can never pass for another.
const sign = (key, msg) => crypto.createHmac('sha256', key).update(msg).digest('hex');

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function createBridge(opts) {
  const getToken = opts.getToken;
  const basePort = opts.basePort == null ? 47615 : opts.basePort;
  const span = opts.span == null ? 10 : opts.span;
  const host = opts.host || '127.0.0.1';
  const onTab = opts.onTab;
  const onCheck = opts.onCheck || (() => null);
  const extVersion = opts.extVersion || (() => '');
  const now = opts.now || Date.now;

  let server = null;
  let port = 0;

  function handler(req, res) {
    const reply = (code, body, signWith) => {
      if (res.writableEnded) return;
      const text = JSON.stringify(body || {});
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
      if (signWith) headers['X-Orb-Sig'] = signWith(text);
      res.writeHead(code, headers);
      res.end(text);
    };

    // Only ever addressed as this computer. A web page that re-points its own domain at
    // 127.0.0.1 (DNS rebinding) still sends its domain in Host, and is turned away here.
    const hostHeader = String(req.headers.host || '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(hostHeader)) return reply(403, { error: 'host' });

    // Web pages send their own Origin; only extensions are welcome.
    const origin = req.headers.origin;
    if (origin && !/^(chrome|moz|ms-browser)-extension:\/\//.test(origin)) return reply(403, { error: 'origin' });

    if (req.method !== 'POST' || !['/hello', '/tab', '/check'].includes(req.url)) return reply(404);
    const token = getToken();
    if (!token || token.length < 16) return reply(401, { error: 'token' });
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reply(415);

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reply(413);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        const body = JSON.parse(raw);

        // "Prove you are the app": answer the extension's challenge. Asks nothing of the caller.
        if (req.url === '/hello') {
          const nonce = String(body.nonce || '');
          if (!/^[0-9a-f]{32,64}$/.test(nonce)) return reply(400, { error: 'nonce' });
          return reply(200, { proof: sign(token, `hello:${nonce}`) });
        }

        // An extension from before signing sends the secret itself. It is told only which
        // version to reload to, so it updates; nothing it sends is used.
        if (req.headers['x-orb-token'] !== undefined) {
          if (!safeEqual(req.headers['x-orb-token'], token)) return reply(401, { error: 'token' });
          return reply(200, { ok: true, ext: String(extVersion() || ''), upgrade: true });
        }

        const ts = String(req.headers['x-orb-ts'] || '');
        const sig = String(req.headers['x-orb-sig'] || '');
        if (!/^\d{10,16}$/.test(ts) || Math.abs(now() - Number(ts)) > SKEW_MS) return reply(401, { error: 'time' });
        if (!safeEqual(sig, sign(token, `req:${ts}:${req.url}:${raw}`))) return reply(401, { error: 'signature' });
        const checking = req.url === '/check';
        const signReply = (text) => sign(token, `res:${ts}:${text}`);

        const url = String(body.url || '');
        if (url.length > MAX_URL || !/^(https?:\/\/|chrome:|edge:|about:)/i.test(url)) return reply(400, { error: 'url' }, signReply);
        const tab = { url, title: String(body.title || '').slice(0, 300) };
        const verdict = checking ? onCheck(tab) : onTab(tab);
        const out = { ok: true, ext: String(extVersion() || '') };
        if (verdict && typeof verdict === 'object') out.block = verdict;
        reply(200, out, signReply);
      } catch (e) {
        reply(400, { error: 'json' });
      }
    });
  }

  function tryListen(p) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(handler);
      srv.maxHeadersCount = 30;
      srv.headersTimeout = 5000;
      srv.requestTimeout = 5000;
      srv.once('error', reject);
      srv.listen(p, host, () => {
        srv.removeListener('error', reject);
        resolve(srv);
      });
    });
  }

  async function start() {
    if (server) return port;
    for (let i = 0; i <= span; i++) {
      try {
        server = await tryListen(basePort === 0 ? 0 : basePort + i);
        port = server.address().port;
        return port;
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
      }
    }
    throw new Error('No free port for the browser link');
  }

  function stop() {
    if (!server) return;
    try {
      server.close();
      if (server.closeAllConnections) server.closeAllConnections();
    } catch (e) {
      /* already closed */
    }
    server = null;
    port = 0;
  }

  return { start, stop, port: () => port };
}

module.exports = { createBridge, sign };
