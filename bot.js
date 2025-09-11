'use strict';

/**
 * SpiffyOS Twitch bot - Chat API refactor
 * Send: POST /helix/chat/messages using App Access Token
 * Read: EventSub channel.chat.message using App Access Token
 * Other EventSub topics: two user token sessions as before
 *
 * Logging tags:
 *  [BOOT] startup and env
 *  [AUTH] token cache
 *  [SEND] chat sends
 *  [ROUT] command routing
 *  [ANN]  timed announcements
 *  [ERR]  errors
 * EventSub logging is in lib/eventsub.js as [EVT/APP], [EVT/BC], [EVT/BOT]
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const {
  getAppToken,
  getClientId,
} = require('./lib/apptoken');

const {
  startEventSub,
} = require('./lib/eventsub');

// env
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const BOT_LOGIN = (process.env.BOT_USERNAME || '').toLowerCase();
const CHANNELS = (process.env.CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
const BROADCASTER_USER_ID = process.env.BROADCASTER_USER_ID;
const BOT_USER_ID = process.env.BOT_USER_ID;
const CMD_PREFIX = process.env.CMD_PREFIX || '!';

// sanity
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('[BOOT] missing TWITCH_CLIENT_ID or TWITCH_CLIENT_SECRET');
  process.exit(1);
}
if (!BROADCASTER_USER_ID || !BOT_USER_ID) {
  console.error('[BOOT] missing BROADCASTER_USER_ID or BOT_USER_ID in .env');
  process.exit(1);
}
if (!CHANNELS.length) {
  console.error('[BOOT] CHANNELS is empty');
  process.exit(1);
}

console.log(`[BOOT] bot=${BOT_LOGIN} bc=${BROADCASTER_USER_ID} cmd=${CMD_PREFIX}`);

// simple user token caches for broadcaster and bot sessions
let _bcToken = null;
let _bcExp = 0;
let _botToken = null;
let _botExp = 0;

async function getUserToken(kind) {
  const now = Math.floor(Date.now() / 1000);
  if (kind === 'broadcaster') {
    if (_bcToken && _bcExp - now > 120) return _bcToken;
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: process.env.BROADCASTER_REFRESH_TOKEN,
      }),
    });
    if (!res.ok) {
      console.error('[AUTH] refresh broadcaster token failed', res.status);
      const body = await res.text().catch(() => '');
      console.error('[ERR]', body);
      throw new Error('broadcaster token refresh failed');
    }
    const json = await res.json();
    _bcToken = json.access_token;
    _bcExp = now + (json.expires_in || 0);
    console.log('[AUTH] broadcaster token refreshed');
    return _bcToken;
  } else if (kind === 'bot') {
    if (_botToken && _botExp - now > 120) return _botToken;
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: process.env.TWITCH_REFRESH_TOKEN,
      }),
    });
    if (!res.ok) {
      console.error('[AUTH] refresh bot token failed', res.status);
      const body = await res.text().catch(() => '');
      console.error('[ERR]', body);
      throw new Error('bot token refresh failed');
    }
    const json = await res.json();
    _botToken = json.access_token;
    _botExp = now + (json.expires_in || 0);
    console.log('[AUTH] bot token refreshed');
    return _botToken;
  }
  throw new Error('unknown token kind');
}

// helix fetch helper
async function helix(pathname, opts) {
  const url = `https://api.twitch.tv/helix${pathname}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      'Client-Id': CLIENT_ID,
      'Authorization': `Bearer ${opts.token}`,
      ...(opts.json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.json ? JSON.stringify(opts.json) : opts.body || undefined,
  });
  return res;
}

// JSONC loader for templates
function loadJSONC(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const noLine = noBlock.replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(noLine);
}

// commands metadata and greetings
const COMMANDS_CFG_PATH = path.join(__dirname, 'config', 'commands.json');
const TEMPLATES_PATH = path.join(__dirname, 'config', 'templates.jsonc');
let commandsCfg = {};
let templates = {};
function reloadConfigs() {
  try {
    commandsCfg = JSON.parse(fs.readFileSync(COMMANDS_CFG_PATH, 'utf8'));
  } catch (e) {
    console.error('[ERR] commands.json load failed', e.message);
    commandsCfg = {};
  }
  try {
    templates = loadJSONC(TEMPLATES_PATH);
  } catch (e) {
    console.error('[ERR] templates.jsonc load failed', e.message);
    templates = {};
  }
}
reloadConfigs();

// dynamic command loader
const COMMANDS_DIR = path.join(__dirname, 'commands');
let commands = new Map();
function loadCommands() {
  commands.clear();
  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const modPath = path.join(COMMANDS_DIR, f);
    delete require.cache[require.resolve(modPath)];
    const mod = require(modPath);
    const name = (mod.name || path.basename(f, '.js')).toLowerCase();
    commands.set(name, mod);
  }
  console.log(`[BOOT] commands loaded=${commands.size}`);
}
loadCommands();

// cooldowns map
const cooldowns = new Map();
function onCooldown(cmd, userId) {
  const key = `${cmd}:${userId}`;
  const now = Date.now();
  const until = cooldowns.get(key) || 0;
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}
function setCooldown(cmd, userId, secs) {
  if (!secs) return;
  cooldowns.set(`${cmd}:${userId}`, Date.now() + secs * 1000);
}

// Chat send via API using App token
async function sendChat(message, opts) {
  const token = await getAppToken();
  const body = {
    broadcaster_id: BROADCASTER_USER_ID,
    sender_id: BOT_USER_ID,
    message,
  };
  if (opts && opts.reply_parent_message_id) {
    body.reply_parent_message_id = opts.reply_parent_message_id;
  }
  const res = await fetch('https://api.twitch.tv/helix/chat/messages', {
    method: 'POST',
    headers: {
      'Client-Id': CLIENT_ID,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error('[SEND] failed', res.status, txt);
    if (res.status === 401) {
      // force app token refresh on next call
      require('./lib/apptoken').invalidate();
    }
    return false;
  }
  console.log('[SEND] ok');
  return true;
}

// thin context passed to commands
const ctxBase = {
  clientId: CLIENT_ID,
  getAppToken,
  getBroadcasterToken: () => getUserToken('broadcaster'),
  getBotToken: () => getUserToken('bot'),
  helix,
  say: (text) => sendChat(text),
  reply: (text, parent) => sendChat(text, { reply_parent_message_id: parent }),
  templates: () => templates,
  commandsCfg: () => commandsCfg,
  reload: () => {
    reloadConfigs();
    loadCommands();
    return true;
  },
};

// command router
async function handleCommand(ev) {
  const text = (ev.text || '').trim();
  if (!text.startsWith(CMD_PREFIX)) return false;

  const parts = text.slice(CMD_PREFIX.length).trim().split(/\s+/);
  const cmdName = (parts.shift() || '').toLowerCase();
  const args = parts;

  const meta = commandsCfg.commands && commandsCfg.commands[cmdName];
  const primary = commands.get(cmdName) || (meta && meta.module ? commands.get(meta.module) : null);

  if (!primary) return false;

  // permissions
  const modOnly = meta && !!meta.modOnly;
  if (modOnly && !(ev.isMod || ev.isBroadcaster)) {
    return false;
  }

  // cooldown
  const cdSecs = meta && meta.cooldown ? Number(meta.cooldown) : 0;
  const cdLeft = onCooldown(cmdName, ev.userId);
  if (cdLeft > 0) {
    return true;
  }

  // run
  const ctx = {
    ...ctxBase,
    user: { id: ev.userId, login: ev.userLogin, display: ev.userName },
    channel: { id: ev.channelId, login: ev.channelLogin },
    replyParent: ev.messageId,
    isMod: !!ev.isMod,
    isBroadcaster: !!ev.isBroadcaster,
    prefix: CMD_PREFIX,
  };
  // legacy helpers for existing commands
  ctx.getToken = async (kind) => {
    if (!kind || kind === 'broadcaster') return ctxBase.getBroadcasterToken();
    if (kind === 'bot') return ctxBase.getBotToken();
    if (kind === 'app') return ctxBase.getAppToken();
    return ctxBase.getBroadcasterToken();
  };
  ctx.commands = commands;
  ctx.listCommands = () => Array.from(commands.keys());
  ctx.commandMeta = (name) => {
    try { return (commandsCfg.commands && commandsCfg.commands[name]) || {}; } catch { return {}; }
  };

  ctx.replyThread = (text, parent) => sendChat(text, { reply_parent_message_id: parent || ctx.replyParent });
  ctx.sayThread = (text) => sendChat(text, { reply_parent_message_id: ctx.replyParent });


  try {
    const fn = primary.run || primary.default || primary;
    const ret = await fn(ctx, args, ev);
    if (cdSecs) setCooldown(cmdName, ev.userId, cdSecs);
    return ret !== false;
  } catch (e) {
    console.error('[ERR] command error', cmdName, e.message);
    return true;
  }
}

// timed announcements
let announceTimers = [];
function clearAnnouncements() {
  for (const t of announceTimers) clearInterval(t);
  announceTimers = [];
}
function loadAnnouncements() {
  clearAnnouncements();
  const annPath = path.join(__dirname, 'config', 'announcements.js');
  delete require.cache[require.resolve(annPath)];
  let ann = require(annPath);
  if (typeof ann === 'function') ann = ann();
  if (!Array.isArray(ann)) return;

  for (const item of ann) {
    const every = Number(item.every_seconds || item.every || 0);
    const msg = item.message || item.text;
    if (!every || !msg) continue;
    const timer = setInterval(() => {
      sendChat(msg).catch(() => {});
    }, every * 1000);
    announceTimers.push(timer);
  }
  console.log(`[ANN] timers=${announceTimers.length}`);
}
loadAnnouncements();
scheduleGreeting();

// Local intake for forwarded EventSub webhook chat
const http = require('http');
const INTAKE_PORT = Number(process.env.INTAKE_PORT || 18082);
const INTAKE_SECRET = process.env.WEBHOOK_SECRET || '';

function startIntake() {
  const srv = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/_intake/chat') {
      res.statusCode = 404; return res.end('no');
    }
    const key = req.headers['x-intake-secret'];
    if (!INTAKE_SECRET || key !== INTAKE_SECRET) {
      console.log('[INTAKE] 403');
      res.statusCode = 403; return res.end('forbidden');
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = JSON.parse(raw);
const j = body && body.event ? body.event : body;
const isMod = !!(j.is_moderator || (Array.isArray(j.badges) && j.badges.some(b => String(b.set_id || "") === "moderator")));
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
        await handleCommand(ev);
        res.statusCode = 204; res.end();
      } catch (e) {
        console.error('[INTAKE] err', e.message);
        res.statusCode = 400; res.end('bad');
      }
    });
  });
  srv.listen(INTAKE_PORT, '127.0.0.1', () => {
    console.log('[INTAKE] listening 127.0.0.1:' + INTAKE_PORT);
  });
  return srv;
}
const __intake = startIntake();

// start EventSub
startEventSub({
  clientId: CLIENT_ID,
  getAppToken,
  getBroadcasterToken: () => getUserToken('broadcaster'),
  getBotToken: () => getUserToken('bot'),
  broadcasterUserId: BROADCASTER_USER_ID,
  botUserId: BOT_USER_ID,

  // app session chat message handler
  onChatMessage: async (ev) => {
    // ev fields normalized by eventsub.js
    // route commands and support threaded replies
    const handled = await handleCommand(ev);
    if (!handled) {
      // no-op for normal chat lines
    }
  },

  // broadcaster session events
  onSub: async (ev) => {
    // use templates if present
    const t = templates.sub || 'Thanks for the sub!';
    await sendChat(t.replace('{user}', ev.userLogin || ev.userName || 'friend')).catch(() => {});
  },
  onResub: async (ev) => {
    const t = templates.resub || 'Thanks for resubbing, {user}!';
    await sendChat(t.replace('{user}', ev.userLogin || ev.userName || 'friend')).catch(() => {});
  },
  onSubGift: async (ev) => {
    const t = templates.subgift || '{user} gifted subs, thank you!';
    await sendChat(t.replace('{user}', ev.userLogin || ev.userName || 'friend')).catch(() => {});
  },
  onCheer: async (ev) => {
    const t = templates.bits || 'Thanks for the bits, {user}!';
    await sendChat(t.replace('{user}', ev.userLogin || ev.userName || 'friend')).catch(() => {});
  },
  onRaid: async (ev) => {
    // auto shoutout
    try {
      const bcToken = await getUserToken('broadcaster');
      const res = await helix('/chat/shoutouts', {
        method: 'POST',
        token: bcToken,
        json: {
          from_broadcaster_id: BROADCASTER_USER_ID,
          to_broadcaster_id: ev.fromBroadcasterId,
          moderator_id: BROADCASTER_USER_ID,
        },
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.error('[ERR] shoutout failed', res.status, txt);
      }
    } catch (e) {
      console.error('[ERR] shoutout error', e.message);
    }
  },

  // bot session events
  onFollow: async (ev) => {
    const t = templates.follow || 'Thanks for the follow, {user}!';
    await sendChat(t.replace('{user}', ev.userLogin || ev.userName || 'friend')).catch(() => {});
  },
});

const GREET_STATE_FILE = path.join(__dirname, '.greeting_state.json');

function scheduleGreeting() {
  const g = commandsCfg.greeting || {};
  if (!g.enabled) return;
  const delayMs = Number(g.delayMs || 1500);
  const minIntervalSec = Number(g.minIntervalSec || 900);
  let last = 0;
  try {
    const raw = fs.readFileSync(GREET_STATE_FILE, 'utf8');
    last = JSON.parse(raw).last || 0;
  } catch {}
  const now = Math.floor(Date.now() / 1000);
  if (minIntervalSec && now - last < minIntervalSec) {
    console.log('[BOOT] greeting suppressed');
    return;
  }
  setTimeout(async () => {
    try {
      const msg = String(g.message || 'I am online');
      await sendChat(msg);
      fs.writeFileSync(GREET_STATE_FILE, JSON.stringify({ last: Math.floor(Date.now() / 1000) }));
      console.log('[BOOT] greeted');
    } catch (e) {
      console.error('[ERR] greeting failed', e.message);
    }
  }, delayMs);
}
process.on('SIGINT', () => {
  console.log('[BOOT] stopping');
  clearAnnouncements();
  process.exit(0);
});
