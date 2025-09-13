'use strict';

const linkguard = require('./src/moderation/linkguard');


/**
 * SpiffyOS Twitch bot - manifest+actions core, config-first JSON
 *
 * - Commands config:  config/bot-commands-config.json   (authority for text, roles, cooldowns, limits)
 * - General config:   config/bot-general-config.json    (announcements, greeter, event templates/toggles)
 * - Commands (JS):    commands/**.js export a manifest via defineCommand()
 *
 * Chat path:
 *   Twitch -> (webhook: scripts/twitch-webhook.js) -> POST /_intake/chat -> router -> sendChat (Helix)
 *
 * EventSub (subs/follows/bits/raid):
 *   startEventSub() using proper user tokens
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');

const { getAppToken, invalidate: invalidateAppToken } = require('./lib/apptoken');
const { startEventSub } = require('./lib/eventsub');
const { openDB } = require('./src/core/db');
const { loadManifestsAndConfig } = require('./src/core/manifest-loader');
const { createRouter } = require('./src/core/router');

// ───────────────────────────────────────────────────────────────────────────────
// Env
// ───────────────────────────────────────────────────────────────────────────────
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const BOT_LOGIN = (process.env.BOT_USERNAME || '').toLowerCase();
const BROADCASTER_USER_ID = process.env.BROADCASTER_USER_ID;
const BOT_USER_ID = process.env.BOT_USER_ID;
const CMD_PREFIX = process.env.CMD_PREFIX || '!';

if (!CLIENT_ID || !CLIENT_SECRET || !BROADCASTER_USER_ID || !BOT_USER_ID) {
  console.error('[BOOT] missing required env (TWITCH_CLIENT_ID/SECRET, BROADCASTER_USER_ID, BOT_USER_ID)');
  process.exit(1);
}
console.log(`[BOOT] bot=${BOT_LOGIN} bc=${BROADCASTER_USER_ID} cmd=${CMD_PREFIX}`);

// Pre-warm app token so first send doesn’t block
getAppToken()
  .then(() => console.log('[AUTH] app token pre-warmed'))
  .catch(e => console.error('[AUTH] pre-warm failed', e?.message || e));

// ───────────────────────────────────────────────────────────────────────────────
// DB (usage logging)
// ───────────────────────────────────────────────────────────────────────────────
const db = openDB();

// ───────────────────────────────────────────────────────────────────────────────
// Helix helper
// ───────────────────────────────────────────────────────────────────────────────
async function helix(pathname, opts) {
  const url = `https://api.twitch.tv/helix${pathname}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'Client-Id': CLIENT_ID,
      'Authorization': `Bearer ${opts.token}`,
      ...(opts.json ? { 'Content-Type': 'application/json' } : {})
    },
    body: opts.json ? JSON.stringify(opts.json) : opts.body || undefined
  });
  return res;
}

// ───────────────────────────────────────────────────────────────────────────────
// User tokens (proper getters with caching)
// ───────────────────────────────────────────────────────────────────────────────
let _bcTok = null, _bcExp = 0;
let _botTok = null, _botExp = 0;

async function refreshWith(rt, tag) {
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: rt
    })
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error(`[AUTH] refresh ${tag} failed`, res.status, txt);
    throw new Error(`refresh ${tag} failed`);
  }
  const j = await res.json();
  return { token: j.access_token, exp: Math.floor(Date.now()/1000) + (j.expires_in || 0) };
}

async function getBroadcasterToken() {
  const now = Math.floor(Date.now()/1000);
  if (_bcTok && _bcExp - now > 120) return _bcTok;
  const { token, exp } = await refreshWith(process.env.BROADCASTER_REFRESH_TOKEN, 'broadcaster');
  _bcTok = token; _bcExp = exp;
  console.log('[AUTH] broadcaster token refreshed');
  return _bcTok;
}
async function getBotToken() {
  const now = Math.floor(Date.now()/1000);
  if (_botTok && _botExp - now > 120) return _botTok;
  const { token, exp } = await refreshWith(process.env.TWITCH_REFRESH_TOKEN, 'bot');
  _botTok = token; _botExp = exp;
  console.log('[AUTH] bot token refreshed');
  return _botTok;
}

// ───────────────────────────────────────────────────────────────────────────────
/** Chat sender via Helix /chat/messages using App token */
// ───────────────────────────────────────────────────────────────────────────────
async function sendChat(message, opts) {
  const token = await getAppToken();
  const body = {
    broadcaster_id: BROADCASTER_USER_ID,
    sender_id: BOT_USER_ID,
    message
  };
  if (opts && opts.reply_parent_message_id) {
    body.reply_parent_message_id = opts.reply_parent_message_id;
  }
  const res = await fetch('https://api.twitch.tv/helix/chat/messages', {
    method: 'POST',
    headers: {
      'Client-Id': CLIENT_ID,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error('[SEND] failed', res.status, txt);
    if (res.status === 401) invalidateAppToken();
    return false;
  }
  console.log('[SEND] ok');
  return true;
}


// === [LINKGUARD ROUTER] ===
async function routeChat(ev) {
  if (process.env.LINKGUARD_DEBUG && process.env.LINKGUARD_DEBUG !== '0') {
    try { console.log('[LG] routeChat start', { text: ev && ev.text, user: ev && ev.userLogin }); } catch {}
  }

  const ctx = {
    helix,
    getAppToken,
    // IMPORTANT: pass the real token getters (not undefined wrappers)
    getBroadcasterToken,
    getBotToken,
    clientId: CLIENT_ID,
    broadcasterUserId: BROADCASTER_USER_ID,
    botUserId: BOT_USER_ID,
    generalCfg: () => {
      try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname,'config','bot-general-config.json'),'utf8')); }
      catch { return {}; }
    },
    commandMeta: (name) => {
      try { const j = require('./config/bot-commands-config.json'); return (j.commands && j.commands[name]) || {}; }
      catch { return {}; }
    },
    reply: (text, parent) => sendChat(text, { reply_parent_message_id: parent || (ev && ev.messageId) }),
    say:   (text) => sendChat(text),
    user:  { id: ev.userId, login: ev.userLogin, display: ev.userName },
    channel: { id: ev.channelId, login: ev.channelLogin },
    isMod: !!ev.isMod,
    isBroadcaster: !!ev.isBroadcaster
  };

  try {
    const gen = ctx.generalCfg() || {};
    const lg  = (gen.moderation && gen.moderation.linkGuard) || null;
    const isCommand = (ev.text || '').trim().startsWith(CMD_PREFIX);
    if (!isCommand) {
      const acted = await linkguard.checkAndHandle(ev, ctx, lg);
      if (acted) return true;
    }
  } catch (e) {
    console.warn('[LG] route error', e && e.message ? e.message : e);
  }

  // IMPORTANT: route commands via the manifest router
  return router.handle(ev);
}

// ───────────────────────────────────────────────────────────────────────────────
// Load manifests + config and build router
// ───────────────────────────────────────────────────────────────────────────────
const CFG_CMDS = path.join(__dirname, 'config', 'bot-commands-config.json');
const CFG_GEN  = path.join(__dirname, 'config', 'bot-general-config.json');

const { registry, aliasMap, config } = loadManifestsAndConfig({
  root: __dirname,
  commandsDir: path.join(__dirname, 'commands'),
  configPath: CFG_CMDS,
  logger: console
});

const router = createRouter({
  registry, aliasMap, config,
  db, sendChat,
  getAppToken,
  getBroadcasterToken,
  getBotToken,
  helix,
  broadcasterUserId: BROADCASTER_USER_ID,
  botUserId: BOT_USER_ID,
  cmdPrefix: CMD_PREFIX
});

// ───────────────────────────────────────────────────────────────────────────────
// Intake server for forwarded EventSub chat (webhook to intake)
// ───────────────────────────────────────────────────────────────────────────────
const INTAKE_PORT = Number(process.env.INTAKE_PORT || 18082);
const INTAKE_SECRET = process.env.WEBHOOK_SECRET || '';

function startIntake() {
  const srv = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/_intake/chat') { res.statusCode = 404; return res.end('no'); }
    if ((req.headers['x-intake-secret'] || '') !== INTAKE_SECRET) { res.statusCode = 403; return res.end('forbidden'); }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(raw);
        const j = body && body.event ? body.event : body;

        const isMod = !!(j.is_moderator ||
          (Array.isArray(j.badges) && j.badges.some(b => String(b.set_id || '') === 'moderator')));

        const ev = {
          text: String((j.message_text || (j.message && j.message.text) || j.text || "")),
          userId: String(j.chatter_user_id || ''),
          userLogin: String(j.chatter_user_login || '').toLowerCase(),
          userName: String(j.chatter_user_name || ''),
          channelId: String(j.broadcaster_user_id || ''),
          channelLogin: String(j.broadcaster_user_login || '').toLowerCase(),
          messageId: String(j.message_id || ''),
          isBroadcaster: String(j.chatter_user_id || '') === String(j.broadcaster_user_id || ''),
          isMod: !!isMod
        };

        if (!ev.text) { res.statusCode = 204; return res.end(); }
        await routeChat(ev);
        res.statusCode = 204; res.end();
      } catch (e) {
        console.error('[INTAKE] err', e.message);
        res.statusCode = 400; res.end('bad');
      }
    });
  });
  srv.listen(INTAKE_PORT, '127.0.0.1', () => console.log('[INTAKE] listening 127.0.0.1:' + INTAKE_PORT));
}
startIntake();

// ───────────────────────────────────────────────────────────────────────────────
// Event-driven messages (follows/subs/bits/raids) still handled via features module
// ───────────────────────────────────────────────────────────────────────────────
const initEventMessages = require('./src/features/event-messages');
const eventMsgs = initEventMessages({
  generalCfgPath: CFG_GEN,
  sendChat, helix, getAppToken,
  broadcasterUserId: BROADCASTER_USER_ID
});

// ───────────────────────────────────────────────────────────────────────────────
// EventSub
// ───────────────────────────────────────────────────────────────────────────────
startEventSub({
  clientId: CLIENT_ID,
  getAppToken,
  getBroadcasterToken,
  getBotToken,
  broadcasterUserId: BROADCASTER_USER_ID,
  botUserId: BOT_USER_ID,

  onChatMessage: async (_ev) => { /* chat is via webhook->intake */ },

  // broadcaster session events -> templated messages
  onSub:     async (ev) => { await eventMsgs.onSub(ev); },
  onResub:   async (ev) => { await eventMsgs.onResub(ev); },
  onSubGift: async (ev) => { await eventMsgs.onSubGift(ev); },
  onCheer:   async (ev) => { await eventMsgs.onCheer(ev); },
  onRaid:    async (ev) => { await eventMsgs.onRaid(ev); }
});

process.on('SIGINT', () => {
  console.log('[BOOT] stopping');
  try { db.close(); } catch {}
  process.exit(0);
});


// === [GREETER] === DO NOT REMOVE MARKER
(function setupGreeter(){
  try {
    const _fs = require('fs'); const _path = require('path');
    const CFG_GEN = _path.join(__dirname,'config','bot-general-config.json');
    const STATE   = _path.join(__dirname,'.greeting_state.json');
    function readJSON(fp){ try { return JSON.parse(_fs.readFileSync(fp,'utf8')); } catch { return null; } }
    const cfg = readJSON(CFG_GEN) || {};
    const g = cfg.greeting || {};
    if (!g.enabled) return;

    const nowSec = Math.floor(Date.now()/1000);
    let last = 0;
    try { last = (JSON.parse(_fs.readFileSync(STATE,'utf8')).last)||0; } catch {}
    const min = Number(g.minIntervalSec||900);
    if (min && (nowSec - last) < min) { console.log('[BOOT] greeting suppressed'); return; }

    const delay = Number(g.delayMs||1500);
    setTimeout(async () => {
      try {
        const msg = String(g.message || 'I am online');
        await sendChat(msg);
        _fs.writeFileSync(STATE, JSON.stringify({ last: Math.floor(Date.now()/1000) }));
        console.log('[BOOT] greeted');
      } catch (e) {
        console.error('[ERR] greeting failed', e.message || e);
      }
    }, delay);
  } catch (e) {
    console.error('[ERR] setupGreeter failed', e.message || e);
  }
})();
