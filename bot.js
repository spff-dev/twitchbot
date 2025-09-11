'use strict';

/**
 * SpiffyOS Twitch bot - config-first (JSON), announcements via general config
 *
 * Sources of truth (JSON only):
 *  - Commands:  config/bot-commands-config.json
 *  - General:   config/bot-general-config.json  (announcements, greeter)
 *
 * Modules (commands/*.js) provide logic + {defaults}; router always uses JSON.
 * Announcements now read from bot-general-config.json and honor onlineOnly by
 * checking Helix /streams on each tick (A-LIVE behavior).
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');

const { getAppToken } = require('./lib/apptoken');
const { startEventSub } = require('./lib/eventsub');
const { openDB } = require('./src/core/db');

// ───────────────────────────────────────────────────────────────────────────────
// env
const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const BOT_LOGIN = (process.env.BOT_USERNAME || '').toLowerCase();
const CHANNELS = (process.env.CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
const BROADCASTER_USER_ID = process.env.BROADCASTER_USER_ID;
const BOT_USER_ID = process.env.BOT_USER_ID;
const CMD_PREFIX = process.env.CMD_PREFIX || '!';

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

// ───────────────────────────────────────────────────────────────────────────────
// DB (counts-only + command usage)
const db = openDB();
const STMT_INC_MSG = db.prepare(`
  INSERT INTO message_counts(user_id, login, stream_id, count)
  VALUES (?, ?, 0, 1)
  ON CONFLICT(user_id, stream_id) DO UPDATE SET login=excluded.login, count=count+1
`);
const STMT_CMD_USAGE = db.prepare(`
  INSERT INTO command_usage(ts, stream_id, user_id, login, command, ok, reason, message_id)
  VALUES (?, 0, ?, ?, ?, ?, ?, ?)
`);

function recordMessage(ev) {
  try {
    if (!ev.userId || String(ev.userId) === String(BOT_USER_ID)) return; // exclude botself
    STMT_INC_MSG.run(String(ev.userId), String(ev.userLogin || ''));
  } catch (e) {
    console.error('[DB] message_counts error:', e.message);
  }
}
function logCommandUsage(ev, cmd, ok, reason) {
  try {
    STMT_CMD_USAGE.run(
      new Date().toISOString(),
      String(ev.userId || ''),
      String(ev.userLogin || ''),
      String(cmd || ''),
      ok ? 1 : 0,
      reason || null,
      String(ev.messageId || '')
    );
  } catch (e) {
    console.error('[DB] command_usage error:', e.message);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Tokens (kept for other features)
let _bcToken = null, _bcExp = 0;
let _botToken = null, _botExp = 0;
async function getUserToken(kind) {
  const now = Math.floor(Date.now() / 1000);
  const doRefresh = async (refresh_token, tag) => {
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token
      })
    });
    if (!res.ok) {
      console.error(`[AUTH] refresh ${tag} token failed`, res.status);
      const body = await res.text().catch(() => '');
      console.error('[ERR]', body);
      throw new Error(`${tag} token refresh failed`);
    }
    const json = await res.json();
    return { token: json.access_token, exp: now + (json.expires_in || 0) };
  };

  if (kind === 'broadcaster') {
    if (_bcToken && _bcExp - now > 120) return _bcToken;
    const r = await doRefresh(process.env.BROADCASTER_REFRESH_TOKEN, 'broadcaster');
    _bcToken = r.token; _bcExp = r.exp;
    console.log('[AUTH] broadcaster token refreshed');
    return _bcToken;
  }
  if (kind === 'bot') {
    if (_botToken && _botExp - now > 120) return _botToken;
    const r = await doRefresh(process.env.TWITCH_REFRESH_TOKEN, 'bot');
    _botToken = r.token; _botExp = r.exp;
    console.log('[AUTH] bot token refreshed');
    return _botToken;
  }
  throw new Error('unknown token kind');
}

// Helix helper
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
// JSON configs (single sources of truth)
const CFG_CMDS = path.join(__dirname, 'config', 'bot-commands-config.json');
const CFG_GEN  = path.join(__dirname, 'config', 'bot-general-config.json');

// Ensure JSON exists
function ensureFile(fp, seedObj) {
  try {
    if (!fs.existsSync(fp)) {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, JSON.stringify(seedObj, null, 2) + '\n', 'utf8');
      console.log('[CFG] created', path.basename(fp));
    }
  } catch (e) {
    console.error('[CFG] create failed for', fp, e.message);
  }
}

ensureFile(CFG_CMDS, { commands: {} });
ensureFile(CFG_GEN, {
  announcements: {
    enabled: false,
    onlineOnly: true,
    intervalSeconds: 600,
    messages: []
  },
  greeter: {
    bootGreeting: { enabled: false, message: 'I am online', delayMs: 1500, minIntervalSec: 900 }
  }
});

function readJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (e) { console.error('[CFG] read failed', fp, e.message); return null; }
}
function writeJSON(fp, obj) {
  try { fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }
  catch (e) { console.error('[CFG] write failed', fp, e.message); }
}

// Commands config (authoritative)
let commandsCfg = readJSON(CFG_CMDS) || { commands: {} };

// General config (announcements, greeter)
let generalCfg = readJSON(CFG_GEN) || { announcements: { enabled: false, onlineOnly: true, intervalSeconds: 600, messages: [] }, greeter: { bootGreeting: { enabled: false, message: 'I am online', delayMs: 1500, minIntervalSec: 900 } } };

// ───────────────────────────────────────────────────────────────────────────────
// Command modules -> seed defaults into JSON (do not overwrite user values)
const COMMANDS_DIR = path.join(__dirname, 'commands');
let commands = new Map();
let aliasMap = new Map(); // alias -> canonical

const DEFAULT_META = {
  aliases: [],
  roles: ['everyone'],
  cooldownSeconds: 0,
  limitPerUser: 0,
  replyToUser: true,
  failSilently: true,
  response: ''
};

function loadCommandsAndSyncConfig() {
  // Load command modules
  commands.clear();
  const files = fs.existsSync(COMMANDS_DIR) ? fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.js')) : [];
  for (const f of files) {
    const modPath = path.join(COMMANDS_DIR, f);
    delete require.cache[require.resolve(modPath)];
    const mod = require(modPath);
    const name = (mod.name || path.basename(f, '.js')).toLowerCase();
    commands.set(name, mod);
  }
  console.log(`[BOOT] commands loaded=${commands.size}`);

  // Re-read commands config in case it was created fresh
  commandsCfg = readJSON(CFG_CMDS) || { commands: {} };
  if (!commandsCfg.commands) commandsCfg.commands = {};

  // Merge defaults for missing keys
  const added = [];
  const completed = [];
  for (const [name, mod] of commands) {
    const suggested = mod.defaults || mod.meta || {};
    const existing = commandsCfg.commands[name];
    if (!existing) {
      commandsCfg.commands[name] = { ...DEFAULT_META, ...suggested };
      added.push(name);
    } else {
      const before = JSON.stringify(existing);
      for (const [k, v] of Object.entries(DEFAULT_META)) if (!(k in existing)) existing[k] = v;
      for (const [k, v] of Object.entries(suggested)) if (!(k in existing)) existing[k] = v;
      if (before !== JSON.stringify(existing)) completed.push(name);
    }
  }
  if (added.length || completed.length) {
    writeJSON(CFG_CMDS, commandsCfg);
    if (added.length) console.log('[CFG] added:', added.join(', '));
    if (completed.length) console.log('[CFG] completed defaults for:', completed.join(', '));
  }

  // Build alias map from config
  aliasMap.clear();
  for (const [name, meta] of Object.entries(commandsCfg.commands)) {
    aliasMap.set(name, name);
    const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
    for (const a of aliases) aliasMap.set(String(a).toLowerCase(), name);
  }
}
loadCommandsAndSyncConfig();

// ───────────────────────────────────────────────────────────────────────────────
// Rendering + policy helpers
function render(str, ev, vars = {}) {
  const base = {
    login: ev.userLogin || '',
    displayName: ev.userName || '',
    user: ev.userLogin || '',
    channelLogin: ev.channelLogin || ''
  };
  const all = { ...base, ...vars };
  return String(str || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => (all[k] ?? ''));
}

// Cooldowns (GLOBAL per command)
const cooldowns = new Map();
function cmdCooldownLeft(cmd) {
  const now = Date.now();
  const until = cooldowns.get(cmd) || 0;
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}
function setCmdCooldown(cmd, secs) {
  if (!secs) return;
  cooldowns.set(cmd, Date.now() + secs * 1000);
}

// Chat send via API using App token
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
    if (res.status === 401) {
      require('./lib/apptoken').invalidate(); // force refresh on next call
    }
    return false;
  }
  console.log('[SEND] ok');
  return true;
}

// Base ctx passed to modules
const ctxBase = {
  clientId: CLIENT_ID,
  getAppToken,
  getBroadcasterToken: () => getUserToken('broadcaster'),
  getBotToken: () => getUserToken('bot'),
  helix,
  say: (text) => sendChat(text),
  reply: (text, parent) => sendChat(text, { reply_parent_message_id: parent }),
  commandsCfg: () => commandsCfg, // full JSON
  reload: () => {
    commandsCfg = readJSON(CFG_CMDS) || { commands: {} };
    generalCfg = readJSON(CFG_GEN)  || generalCfg;
    loadCommandsAndSyncConfig();
    reloadAnnouncements(); // pick up general changes
    return true;
  }
};

// ───────────────────────────────────────────────────────────────────────────────
// Router: JSON config is authoritative; modules compute vars only
async function handleCommand(ev) {
  const text = (ev.text || '').trim();
  if (!text.startsWith(CMD_PREFIX)) return false;

  const parts = text.slice(CMD_PREFIX.length).trim().split(/\s+/);
  const rawName = (parts.shift() || '').toLowerCase();
  const cmdName = aliasMap.get(rawName) || rawName;
  const args = parts;

  const meta = (commandsCfg.commands && commandsCfg.commands[cmdName]) || null;
  const primary = commands.get(cmdName);
  if (!meta && !primary) return false;

  const ctx = {
    ...ctxBase,
    user: { id: ev.userId, login: ev.userLogin, display: ev.userName },
    channel: { id: ev.channelId, login: ev.channelLogin },
    replyParent: ev.messageId,
    isMod: !!ev.isMod,
    isBroadcaster: !!ev.isBroadcaster,
    prefix: CMD_PREFIX
  };
  ctx.replyThread = (text, parent) => sendChat(text, { reply_parent_message_id: parent || ctx.replyParent });
  ctx.sayThread   = (text) => sendChat(text, { reply_parent_message_id: ctx.replyParent });

  // Policy from JSON (strict defaults)
  const roles = (meta && Array.isArray(meta.roles)) ? meta.roles : ['everyone'];
  const cooldownSeconds = meta && Number(meta.cooldownSeconds || 0) || 0;
  const limitPerUser = meta && Number(meta.limitPerUser || 0) || 0;
  const replyToUser = meta && typeof meta.replyToUser === 'boolean' ? meta.replyToUser : true;
  const failSilently = meta && typeof meta.failSilently === 'boolean' ? meta.failSilently : true;
  const responseTpl = meta ? String(meta.response || '') : '';

  const feedback = async (msg) => {
    if (failSilently) return;
    if (replyToUser) return ctx.replyThread(msg);
    return ctx.say(msg);
  };

  // Permissions
  if (roles.includes('owner')) {
    if (!(ev.isBroadcaster || ev.isMod)) {
      logCommandUsage(ev, cmdName, 0, 'forbidden');
      await feedback('Not allowed.');
      return true;
    }
  } else if (roles.includes('mod')) {
    if (!(ev.isMod || ev.isBroadcaster)) {
      logCommandUsage(ev, cmdName, 0, 'forbidden');
      await feedback('Mods only.');
      return true;
    }
  }

  // Global cooldown
  const cdLeft = cmdCooldownLeft(cmdName);
  if (cdLeft > 0) {
    logCommandUsage(ev, cmdName, 0, 'cooldown');
    await feedback(`Command on cooldown, please wait ${cdLeft}s.`);
    return true;
  }

  // Per-user per-stream limit
  if (limitPerUser > 0) {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM command_usage WHERE stream_id=0 AND user_id=? AND command=? AND ok=1`
    ).get(String(ev.userId || ''), cmdName);
    if ((row && row.c) >= limitPerUser) {
      logCommandUsage(ev, cmdName, 0, 'limit');
      await feedback(`You've hit the usage limit for this stream.`);
      return true;
    }
  }

  // Execute module to compute variables (if present)
  let vars = {};
  let useReply = replyToUser;
  try {
    if (primary) {
      const fn = primary.run || primary.default || primary;
      const ret = await fn(ctx, args, ev);
      if (ret && typeof ret === 'object') {
        if (ret.vars && typeof ret.vars === 'object') vars = ret.vars;
        if (typeof ret.reply === 'boolean') useReply = ret.reply;
      }
    }
  } catch (e) {
    console.error('[ERR] command error', cmdName, e.message);
    logCommandUsage(ev, cmdName, 0, 'error');
    return true;
  }

  // Speak using JSON response only
  if (responseTpl) {
    const out = render(responseTpl, ev, vars);
    useReply ? await ctx.replyThread(out) : await ctx.say(out);
    if (cooldownSeconds) setCmdCooldown(cmdName, cooldownSeconds);
    logCommandUsage(ev, cmdName, 1, null);
    return true;
  }

  console.warn('[ROUT] no response configured for command:', cmdName);
  if (cooldownSeconds) setCmdCooldown(cmdName, cooldownSeconds);
  logCommandUsage(ev, cmdName, 1, null);
  return true;
}

// ───────────────────────────────────────────────────────────────────────────────
// Announcements (from bot-general-config.json; A-LIVE by Helix check)
let announceTimer = null;
let announceIdx = 0;

async function isChannelLive() {
  try {
    const token = await getAppToken();
    const res = await helix(`/streams?user_id=${BROADCASTER_USER_ID}`, { method: 'GET', token });
    if (!res.ok) return false;
    const j = await res.json();
    return Array.isArray(j.data) && j.data.length > 0;
  } catch {
    return false;
  }
}

function startAnnouncements() {
  const cfg = generalCfg.announcements || {};
  stopAnnouncements();

  if (!cfg.enabled) {
    console.log('[ANN] disabled');
    return;
  }
  const every = Number(cfg.intervalSeconds || 0);
  const msgs = Array.isArray(cfg.messages) ? cfg.messages.filter(Boolean) : [];
  if (!every || !msgs.length) {
    console.log('[ANN] no interval or messages');
    return;
  }

  announceIdx = 0;
  announceTimer = setInterval(async () => {
    try {
      if (cfg.onlineOnly) {
        const live = await isChannelLive();
        if (!live) return; // skip tick if not live
      }
      const msg = msgs[announceIdx % msgs.length];
      announceIdx++;
      if (msg) await sendChat(msg);
    } catch (e) {
      console.error('[ANN] tick error', e.message);
    }
  }, every * 1000);

  console.log(`[ANN] timer started interval=${every}s count=${msgs.length} onlineOnly=${!!cfg.onlineOnly}`);
}

function stopAnnouncements() {
  if (announceTimer) clearInterval(announceTimer);
  announceTimer = null;
}
function reloadAnnouncements() {
  generalCfg = readJSON(CFG_GEN) || generalCfg;
  startAnnouncements();
}

// Kick announcements at boot
startAnnouncements();

// Greeter (bootGreeting) from general config
const GREET_STATE_FILE = path.join(__dirname, '.greeting_state.json');
function scheduleGreeting() {
  const g = (generalCfg.greeter && generalCfg.greeter.bootGreeting) || {};
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
scheduleGreeting();

// ───────────────────────────────────────────────────────────────────────────────
// Intake server for forwarded EventSub chat
const INTAKE_PORT = Number(process.env.INTAKE_PORT || 18082);
const INTAKE_SECRET = process.env.WEBHOOK_SECRET || '';

function startIntake() {
  const srv = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/_intake/chat') {
      res.statusCode = 404; return res.end('no');
    }
    const key = req.headers['x-intake-secret'];
    if (!INTAKE_SECRET || key !== INTAKE_SECRET) {
      console.log('[INTAKE] 403'); res.statusCode = 403; return res.end('forbidden');
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = JSON.parse(raw);
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

        // record counts-only metrics
        recordMessage(ev);

        // route commands
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

// ───────────────────────────────────────────────────────────────────────────────
// EventSub (subs/raids/follows; chat handled via webhook->intake)
startEventSub({
  clientId: CLIENT_ID,
  getAppToken,
  getBroadcasterToken: () => getUserToken('broadcaster'),
  getBotToken: () => getUserToken('bot'),
  broadcasterUserId: BROADCASTER_USER_ID,
  botUserId: BOT_USER_ID,

  onChatMessage: async (ev) => {
    const handled = await handleCommand(ev);
    if (!handled) { /* no-op */ }
  },

  onSub: async (ev) => {
    const msg = (generalCfg.templates && generalCfg.templates.sub) || 'Thanks for the sub, {user}!';
    await sendChat(msg.replace('{user}', ev.userLogin || ev.userName || 'friend')).catch(() => {});
  },
  onResub: async (ev) => {
    const msg = (generalCfg.templates && generalCfg.templates.resub) || 'Thanks for resubbing, {user}!';
    await sendChat(msg.replace('{user}', ev.userLogin || ev.userName || 'friend')).catch(() => {});
  },
  onSubGift: async (ev) => {
    const msg = (generalCfg.templates && generalCfg.templates.subgift) || '{user} gifted subs, thank you!';
    await sendChat(msg.replace('{user}', ev.userLogin || ev.userName || 'friend')).catch(() => {});
  },
  onCheer: async (ev) => {
    const msg = (generalCfg.templates && generalCfg.templates.bits) || 'Thanks for the bits, {user}!';
    await sendChat(msg.replace('{user}', ev.userLogin || ev.userName || 'friend')).catch(() => {});
  },
  onRaid: async (ev) => {
    try {
      const bcToken = await getUserToken('broadcaster');
      const res = await helix('/chat/shoutouts', {
        method: 'POST',
        token: bcToken,
        json: {
          from_broadcaster_id: BROADCASTER_USER_ID,
          to_broadcaster_id: ev.fromBroadcasterId,
          moderator_id: BROADCASTER_USER_ID
        }
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.error('[ERR] shoutout failed', res.status, txt);
      }
    } catch (e) {
      console.error('[ERR] shoutout error', e.message);
    }
  },

  onFollow: async (ev) => {
    const msg = (generalCfg.templates && generalCfg.templates.follow) || 'Thanks for the follow, {user}!';
    await sendChat(msg.replace('{user}', ev.userLogin || ev.userName || 'friend')).catch(() => {});
  }
});

process.on('SIGINT', () => {
  console.log('[BOOT] stopping');
  try { db.close(); } catch {}
  stopAnnouncements();
  process.exit(0);
});
