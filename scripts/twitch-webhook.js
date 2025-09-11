'use strict';

const http = require('http');
const crypto = require('crypto');
require('dotenv').config();

const HOST = '127.0.0.1';
const PORT = 18081;

// env
const SECRET = process.env.WEBHOOK_SECRET || '';
const INTAKE_URL = process.env.INTAKE_URL || 'http://127.0.0.1:18082/_intake/chat';
const INTAKE_SECRET = process.env.INTAKE_SECRET || '';

if (!SECRET || SECRET.length < 16) {
  console.error('[WH] missing WEBHOOK_SECRET');
  process.exit(1);
}

function hmacMessage(sigId, ts, raw) {
  return `${sigId}${ts}${raw}`;
}
function verifySig(req, raw) {
  const id = req.headers['twitch-eventsub-message-id'] || '';
  const ts = req.headers['twitch-eventsub-message-timestamp'] || '';
  const hdr = req.headers['twitch-eventsub-message-signature'] || '';
  const want = 'sha256=' + crypto.createHmac('sha256', SECRET).update(hmacMessage(id, ts, raw)).digest('hex');
  return { ok: crypto.timingSafeEqual(Buffer.from(hdr), Buffer.from(want)), id, ts, hdr, want };
}

function send(res, code, body, extraHeaders) {
  const b = body || '';
  res.writeHead(code, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(b), ...(extraHeaders || {}) });
  res.end(b);
}

async function forwardToIntake(raw) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (INTAKE_SECRET) headers['X-Intake-Secret'] = INTAKE_SECRET;
    const r = await fetch(INTAKE_URL, { method: 'POST', headers, body: raw });
    console.log('[WH] fwd', r.status);
  } catch (e) {
    console.error('[WH] fwd error', e.message || e);
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') return send(res, 405, 'method-not-allowed');
  if (!req.url || !req.url.startsWith('/hooks/twitchbot')) return send(res, 404, 'not-found');

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { raw += chunk; });
  req.on('end', async () => {
    const type = req.headers['twitch-eventsub-message-type'] || '-';
    const subType = req.headers['twitch-eventsub-subscription-type'] || '-';
    if (!raw) raw = '';

    const { ok } = verifySig(req, raw);
    if (!ok) {
      console.error('[WH] 403 bad-signature type=' + type + ' sub=' + subType + ' len=' + raw.length);
      return send(res, 403, 'bad-signature');
    }

    if (type === 'webhook_callback_verification') {
      try {
        const j = JSON.parse(raw);
        const challenge = String(j.challenge || '');
        console.log('[WH] verify sub=' + subType + ' id=' + (j.subscription?.id || '-'));
        return send(res, 200, challenge);
      } catch {
        return send(res, 400, 'bad-json');
      }
    }

    if (type === 'notification') {
      // Ack fast, then forward the exact raw body to intake
      send(res, 200, 'ok');
      console.log('[WH] note sub=' + subType + ' event=' + '-' + ' len=' + raw.length);
      forwardToIntake(raw);
      return;
    }

    if (type === 'revocation') {
      console.warn('[WH] revoke sub=' + subType + ' len=' + raw.length);
      return send(res, 200, 'ok');
    }

    console.log('[WH] unknown type=' + type + ' len=' + raw.length);
    return send(res, 400, 'bad-type');
  });
});

server.listen(PORT, HOST, () => {
  console.log('[WH] listening ' + HOST + ':' + PORT + ' secret_len=' + SECRET.length);
});
