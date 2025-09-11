'use strict';

const http = require('http');
const crypto = require('crypto');
const os = require('os');
require('dotenv').config();

const HOST = '127.0.0.1';
const PORT = 18081;

// env
const SECRET = process.env.WEBHOOK_SECRET || '';
const INTAKE_URL = process.env.INTAKE_URL || 'http://127.0.0.1:18082/_intake/chat';
const INTAKE_SECRET = process.env.INTAKE_SECRET || '';

// sanity
if (!SECRET || SECRET.length < 16) {
  console.error('[WH] missing or short WEBHOOK_SECRET');
  process.exit(1);
}

// simple state for /healthz
const startedAt = new Date();
let lastEventAt = null;          // Date | null
let eventsReceived = 0;

// helpers
function hmacMessage(sigId, ts, raw) {
  return `${sigId}${ts}${raw}`;
}
function verifySig(req, raw) {
  const id = req.headers['twitch-eventsub-message-id'] || '';
  const ts = req.headers['twitch-eventsub-message-timestamp'] || '';
  const hdr = req.headers['twitch-eventsub-message-signature'] || '';
  const want = 'sha256=' + crypto
    .createHmac('sha256', SECRET)
    .update(hmacMessage(id, ts, raw))
    .digest('hex');
  const ok = (typeof hdr === 'string') && crypto.timingSafeEqual(Buffer.from(hdr), Buffer.from(want));
  return { ok, id, ts, hdr, want };
}

function sendText(res, code, body, extraHeaders) {
  const b = body || '';
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(b), ...(extraHeaders || {}) });
  res.end(b);
}
function sendJSON(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

async function forwardToIntake(raw) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (INTAKE_SECRET) headers['X-Intake-Secret'] = INTAKE_SECRET;
    const r = await fetch(INTAKE_URL, { method: 'POST', headers, body: raw });
    console.log('[WH] fwd', r.status);
  } catch (e) {
    console.error('[WH] fwd error', e && e.message ? e.message : e);
  }
}

const server = http.createServer((req, res) => {
  // health check (NO DB TOUCH)
  if (req.method === 'GET' && req.url === '/healthz') {
    return sendJSON(res, 200, {
      status: 'ok',
      pid: process.pid,
      hostname: os.hostname(),
      uptimeSec: Math.floor(process.uptime()),
      startedAt: startedAt.toISOString(),
      lastEventAt: lastEventAt ? lastEventAt.toISOString() : null,
      eventsReceived
    });
  }

  // webhook endpoint
  if (req.method !== 'POST' || !req.url || !req.url.startsWith('/hooks/twitchbot')) {
    return sendText(res, 404, 'not-found');
  }

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
      return sendText(res, 403, 'bad-signature');
    }

    // Verification handshake
    if (type === 'webhook_callback_verification') {
      try {
        const j = JSON.parse(raw);
        const challenge = String(j.challenge || '');
        console.log('[WH] verify sub=' + subType + ' id=' + (j.subscription?.id || '-'));
        return sendText(res, 200, challenge);
      } catch {
        return sendText(res, 400, 'bad-json');
      }
    }

    // Notifications
    if (type === 'notification') {
      // Ack fast
      sendText(res, 200, 'ok');

      // Update health counters
      lastEventAt = new Date();
      eventsReceived++;

      // Forward exact raw body to intake
      console.log('[WH] note sub=' + subType + ' len=' + raw.length);
      forwardToIntake(raw);
      return;
    }

    // Revocation notices
    if (type === 'revocation') {
      console.warn('[WH] revoke sub=' + subType + ' len=' + raw.length);
      return sendText(res, 200, 'ok');
    }

    console.log('[WH] unknown type=' + type + ' len=' + raw.length);
    return sendText(res, 400, 'bad-type');
  });
});

server.listen(PORT, HOST, () => {
  console.log('[WH] listening ' + HOST + ':' + PORT + ' secret_len=' + SECRET.length);
});
