// /srv/bots/twitchbot/bot.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tmi = require('tmi.js');
const WebSocket = require('ws'); // used by EventSub internals
const { startEventSubBot, startEventSubBroadcaster } = require('./lib/eventsub');
const buildHandlers = require('./events/handlers');
const { reloadConfig: reloadCfgModule } = require('./lib/config');

// ---- Env ----
const {
  BOT_USERNAME,
  CHANNELS,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_REFRESH_TOKEN,
  BROADCASTER_REFRESH_TOKEN,
  CMD_PREFIX = '!'
} = process.env;

if (!BOT_USERNAME || !CHANNELS || !TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !TWITCH_REFRESH_TOKEN) {
  console.error('Missing required env vars. Need BOT_USERNAME, CHANNELS, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_REFRESH_TOKEN.');
  process.exit(1);
}

// ---- Auth: bot token (auto refresh) ----
let tokenState = { accessToken: null, expiresAt: 0, refreshTimer: null };

async function refreshAccessToken(reason = 'scheduled') {
  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: TWITCH_REFRESH_TOKEN
  });

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${reason}): ${res.status} ${text}`);
  }

  const data = await res.json();
  const now = Date.now();
  const expiresInMs = (data.expires_in || 3600) * 1000;
  tokenState.accessToken = data.access_token;
  tokenState.expiresAt = now + expiresInMs;

  const skew = Math.min(5 * 60 * 1000, Math.floor(expiresInMs * 0.1));
  const refreshIn = Math.max(60 * 1000, expiresInMs - skew);
  if (tokenState.refreshTimer) clearTimeout(tokenState.refreshTimer);
  tokenState.refreshTimer = setTimeout(() => {
    refreshAccessToken('timer').catch(err => console.error('[AUTH] scheduled refresh error:', err));
  }, refreshIn);

  console.log(`[AUTH] ${reason} refresh ok. Next refresh in ~${Math.round(refreshIn/1000)}s, expires_in=${Math.round(expiresInMs/1000)}s`);
  return tokenState.accessToken;
}
function tokenWillExpireSoon() { return Date.now() > (tokenState.expiresAt - 60 * 1000); }

// ---- Auth: broadcaster access token (mint on demand) ----
let bState = { accessToken: null, expiresAt: 0 };
async function getBroadcasterAccessToken() {
  if (!BROADCASTER_REFRESH_TOKEN) throw new Error('Missing BROADCASTER_REFRESH_TOKEN in .env');
  const now = Date.now();
  if (bState.accessToken && now < (bState.expiresAt - 60 * 1000)) return bState.accessToken;

  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: BROADCASTER_REFRESH_TOKEN
  });
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Broadcaster token refresh failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  bState.accessToken = data.access_token;
  bState.expiresAt = now + ((data.expires_in || 3600) * 1000);
  return bState.accessToken;
}

// ---- JSONC command overrides and greeting ----
const CMD_DIR = path.join(__dirname, 'commands');
const CONFIG_PATH = path.join(__dirname, 'config', 'commands.json');

function readJsonC(file) {
  let raw = fs.readFileSync(file, 'utf8');
  raw = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  raw = raw.replace(/(^|\s)\/\/.*$/gm, '');
  raw = raw.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(raw);
}

function loadOverrides() {
  try {
    const json = readJsonC(CONFIG_PATH);
    const table = {};
    const src = (json && json.commands) || {};
    for (const [k, v] of Object.entries(src)) table[String(k).toLowerCase()] = v || {};
    return table;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[CFG] Failed to read ${CONFIG_PATH}: ${e.message}`);
    return {};
  }
}

// Greeting config
const DEFAULT_GREETING = {
  enabled: true,
  message: 'SpiffyOS online - type !help for commands.',
  delayMs: 1500,
  minIntervalSec: 900
};
let greetCfg = { ...DEFAULT_GREETING };
function loadGreeting() {
  try {
    const json = readJsonC(CONFIG_PATH);
    greetCfg = { ...DEFAULT_GREETING, ...(json.greeting || {}) };
  } catch {
    greetCfg = { ...DEFAULT_GREETING };
  }
}

function applyOverride(mod, ov) {
  if (!ov) return mod;
  const out = { ...mod };
  if (typeof ov.enabled === 'boolean' && ov.enabled === false) out.__disabled = true;
  if (ov.description != null) out.description = String(ov.description);
  if (ov.permission != null) out.permission = String(ov.permission).toLowerCase();
  if (ov.cooldownSec != null) out.cooldownSec = Number(ov.cooldownSec) || 0;
  if (Array.isArray(ov.aliases)) out.aliases = ov.aliases.map(a => String(a));
  return out;
}

function loadCommands(dir, overrides) {
  const commands = new Map();
  const triggers = new Map();
  if (!fs.existsSync(dir)) {
    console.warn(`[CMD] Directory missing: ${dir}`);
    return { commands, triggers };
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  for (const f of files) {
    try {
      const mod0 = require(path.join(dir, f));
      if (!mod0 || !mod0.name || !mod0.run) { console.warn(`[CMD] Skipping ${f}: missing name/run`); continue; }
      const ov = overrides[mod0.name.toLowerCase()] || null;
      const mod = applyOverride(mod0, ov);
      if (mod.__disabled) { console.log(`[CMD] Disabled by config: ${mod.name}`); continue; }
      const perm = (mod.permission || 'everyone').toLowerCase();
      if (!['everyone', 'mod', 'broadcaster'].includes(perm)) {
        console.warn(`[CMD] ${mod.name}: invalid permission "${mod.permission}", defaulting to "everyone"`);
        mod.permission = 'everyone';
      }
      const aliasList = [mod.name, ...(mod.aliases || [])].map(s => s.toLowerCase());
      commands.set(mod.name.toLowerCase(), mod);
      for (const a of aliasList) triggers.set(a, mod.name.toLowerCase());
    } catch (e) {
      console.warn(`[CMD] Failed to load ${f}: ${e.message}`);
    }
  }
  console.log(`[CMD] Loaded ${commands.size} commands from ${dir}`);
  return { commands, triggers };
}

let commands = new Map();
let triggers = new Map();
function clearCommandCache() {
  for (const k of Object.keys(require.cache)) if (k.startsWith(CMD_DIR)) delete require.cache[k];
}
function rebuildCommands() {
  clearCommandCache();
  const overrides = loadOverrides();
  loadGreeting();
  const loaded = loadCommands(CMD_DIR, overrides);
  commands = loaded.commands;
  triggers = loaded.triggers;
  console.log(`[CFG] Overrides applied from ${CONFIG_PATH}`);
  return { count: commands.size };
}

// ---- Greeting runtime ----
const lastGreetAt = new Map();
const pendingGreet = new Set();
function maybeGreet(client, channel) {
  if (!greetCfg.enabled) return;
  const key = channel.toLowerCase();
  const now = Date.now();
  const minGap = (greetCfg.minIntervalSec || 0) * 1000;
  const last = lastGreetAt.get(key) || 0;
  if (now - last < minGap) return;
  if (pendingGreet.has(key)) return;

  pendingGreet.add(key);
  const delay = Math.max(0, Number(greetCfg.delayMs) || 0);
  setTimeout(async () => {
    try { await client.say(channel, String(greetCfg.message || DEFAULT_GREETING.message)); }
    finally { lastGreetAt.set(key, Date.now()); pendingGreet.delete(key); }
  }, delay);
}

// ---- Threaded reply helper via Helix ----
const HELIX_API = 'https://api.twitch.tv/helix';
async function sendThreadedReply({ token, clientId, channel, parentId, message }) {
  const login = channel.replace(/^#/, '').toLowerCase();

  const meRes = await fetch(`${HELIX_API}/users`, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId }
  });
  const me = await meRes.json().catch(() => ({}));
  const sender_id = me?.data?.[0]?.id;

  const uRes = await fetch(`${HELIX_API}/users?login=${encodeURIComponent(login)}`, {
    headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId }
  });
  const u = await uRes.json().catch(() => ({}));
  const broadcaster_id = u?.data?.[0]?.id;

  const res = await fetch(`${HELIX_API}/chat/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': clientId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      broadcaster_id,
      sender_id,
      message,
      reply_parent_message_id: parentId
    })
  });
  if (res.status !== 200) throw new Error(`send reply status ${res.status}`);
}

// ---- Announcement banner helper (bot token) ----
const idCache = { me: null, byLogin: new Map() };
async function postAnnouncementBanner({ message, channelLogin }) {
  const token = tokenState.accessToken;
  const clientId = TWITCH_CLIENT_ID;

  if (!idCache.me) {
    const r = await fetch(`${HELIX_API}/users`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId }
    }).then(r => r.json()).catch(() => ({}));
    idCache.me = r?.data?.[0]?.id || null;
  }
  const key = String(channelLogin).toLowerCase();
  if (!idCache.byLogin.has(key)) {
    const r = await fetch(`${HELIX_API}/users?login=${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId }
    }).then(r => r.json()).catch(() => ({}));
    const id = r?.data?.[0]?.id || null;
    idCache.byLogin.set(key, id);
  }
  const moderator_id = idCache.me;
  const broadcaster_id = idCache.byLogin.get(key);
  if (!moderator_id || !broadcaster_id) return;

  await fetch(`${HELIX_API}/chat/announcements?broadcaster_id=${broadcaster_id}&moderator_id=${moderator_id}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': clientId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message, color: 'primary' })
  }).catch(() => {});
}

// ---- Timed announcements scheduler ----
const ANN_PATH = path.join(__dirname, 'config', 'announcements.js');
let annTimers = [];

function loadAnnouncementsConfig() {
  try {
    delete require.cache[ANN_PATH];
    const items = require(ANN_PATH);
    if (!Array.isArray(items)) return [];
    return items.map(it => ({
      text: String(it.text || '').trim(),
      everyMin: Math.max(1, Number(it.everyMin || 0)),
      initialDelayMin: it.initialDelayMin != null ? Math.max(0, Number(it.initialDelayMin)) : null,
      jitterSec: Math.max(0, Number(it.jitterSec || 0)),
      type: (it.type === 'announcement') ? 'announcement' : 'chat',
      liveOnly: it.liveOnly == null ? true : !!it.liveOnly
    })).filter(x => x.text && x.everyMin > 0);
  } catch (e) {
    console.warn(`[ANN] Failed to read ${ANN_PATH}: ${e.message}`);
    return [];
  }
}

async function isLive(login) {
  if (!BROADCASTER_REFRESH_TOKEN) return false;
  try {
    const bTok = await getBroadcasterAccessToken();
    const r = await fetch(`${HELIX_API}/streams?user_login=${encodeURIComponent(login)}`, {
      headers: { Authorization: `Bearer ${bTok}`, 'Client-Id': TWITCH_CLIENT_ID }
    });
    if (!r.ok) return false;
    const j = await r.json();
    return Array.isArray(j?.data) && j.data.length > 0;
  } catch { return false; }
}

function startAnnouncementTimers(client, channelLogins) {
  stopAnnouncementTimers();

  const items = loadAnnouncementsConfig();
  if (!items.length) { console.log('[ANN] No timed announcements configured.'); return; }

  for (const login of channelLogins) {
    const chan = `#${login}`;
    for (const item of items) {
      const baseDelayMs = (item.initialDelayMin != null ? item.initialDelayMin : item.everyMin) * 60_000;
      const jitterMs = item.jitterSec ? Math.floor(Math.random() * (item.jitterSec * 1000)) : 0;
      const firstDelay = baseDelayMs + jitterMs;
      const periodMs = item.everyMin * 60_000;

      const tick = async () => {
        try {
          if (!item.liveOnly || await isLive(login)) {
            if (item.type === 'announcement') {
              await postAnnouncementBanner({ message: item.text, channelLogin: login });
            } else {
              await client.say(chan, item.text);
            }
          }
        } catch {
          // keep quiet
        } finally {
          const j = item.jitterSec ? Math.floor(Math.random() * (item.jitterSec * 1000)) : 0;
          const t = setTimeout(tick, periodMs + j);
          annTimers.push(t);
        }
      };

      const t = setTimeout(tick, Math.max(1000, firstDelay));
      annTimers.push(t);
    }
  }

  console.log(`[ANN] Timed announcements started for ${channelLogins.join(', ')} with ${items.length} item(s).`);
}

function stopAnnouncementTimers() {
  for (const t of annTimers) clearTimeout(t);
  annTimers = [];
}

// ---- Runtime config reload glue (used by !cfgreload) ----
let currentClient = null;
let currentChannels = [];

async function reloadRuntimeConfig() {
  // Reload template config and cheer guard
  reloadCfgModule();
  // Reload greeting overrides
  loadGreeting();
  // Restart timed announcements with any updated config
  stopAnnouncementTimers();
  if (currentClient && currentChannels.length) {
    startAnnouncementTimers(currentClient, currentChannels);
  }
  console.log('[CFG] Runtime config reloaded.');
}

// ---- Main ----
let eventSubBotStarted = false;
let eventSubBcStarted  = false;

async function main() {
  await refreshAccessToken('startup');
  const channels = CHANNELS.split(',').map(c => c.trim().replace(/^#/, '').toLowerCase()).filter(Boolean);
  const tmiChannels = channels.map(c => `#${c}`);

  const client = new tmi.Client({
    options: { debug: false },
    connection: { secure: true, reconnect: true },
    identity: { username: BOT_USERNAME, password: `oauth:${tokenState.accessToken}` },
    channels: tmiChannels
  });

  // keep in-memory password fresh
  const originalRefresh = refreshAccessToken;
  refreshAccessToken = async (reason) => {
    const tok = await originalRefresh.call(null, reason);
    client.opts.identity.password = `oauth:${tok}`;
    console.log('[AUTH] Updated in-memory password with fresh token.');
    return tok;
  };

  client.on('connected', (addr, port) => {
    console.log(`Connected to ${addr}:${port} as ${BOT_USERNAME}, joined ${tmiChannels.join(', ')}`);
    for (const c of tmiChannels) maybeGreet(client, c);

    // store for timers reload
    currentClient = client;
    currentChannels = channels;

    const broadcasterLogin = channels[0];

    const handlers = buildHandlers({ tmiClient: client, channel: `#${broadcasterLogin}` });

    if (!eventSubBotStarted) {
      eventSubBotStarted = true;
      startEventSubBot({
        clientId: TWITCH_CLIENT_ID,
        getBotToken: () => tokenState.accessToken,
        broadcasterLogin,
        ...handlers
      }).catch(err => {
        console.error('[EVT/BOT] failed to start', err);
        eventSubBotStarted = false;
      });
    }

    if (!eventSubBcStarted && BROADCASTER_REFRESH_TOKEN) {
      eventSubBcStarted = true;
      startEventSubBroadcaster({
        clientId: TWITCH_CLIENT_ID,
        getBroadcasterToken: () => getBroadcasterAccessToken(),
        getBotToken: () => tokenState.accessToken,
        broadcasterLogin,
        ...handlers
      }).catch(err => {
        console.error('[EVT/BC] failed to start', err);
        eventSubBcStarted = false;
      });
    }

    // Start timed announcements
    startAnnouncementTimers(client, channels);
  });

  client.on('disconnected', (reason) => {
    console.warn('[NET] Disconnected:', reason);
    stopAnnouncementTimers();
    if (tokenWillExpireSoon()) {
      refreshAccessToken('pre-reconnect')
        .then(tok => { client.opts.identity.password = `oauth:${tok}`; })
        .catch(err => console.error('[AUTH] pre-reconnect refresh failed:', err));
    }
  });

  // Initial command load
  rebuildCommands();

  client.on('message', async (channel, tags, message, self) => {
    if (self) return;
    if (!message || message[0] !== CMD_PREFIX) return;

    const user = (tags['display-name'] || tags.username || '').toString();
    const userId = tags['user-id'] || user.toLowerCase();

    const raw = message.slice(CMD_PREFIX.length).trim();
    if (!raw) return;
    const [cmdTrigger, ...args] = raw.split(/\s+/);
    const key = triggers.get(cmdTrigger.toLowerCase());
    if (!key) return;

    const cmd = commands.get(key);

    function isBroadcaster(t) { const b = t.badges || {}; return typeof b === 'object' && b.broadcaster === '1'; }
    function isMod(t) { return !!t.mod || isBroadcaster(t); }
    function hasPermission(perm, t) {
      if (perm === 'everyone') return true;
      if (perm === 'mod') return isMod(t);
      if (perm === 'broadcaster') return isBroadcaster(t);
      return false;
    }

    if (!hasPermission((cmd.permission || 'everyone').toLowerCase(), tags)) return;

    if (!global.__cooldowns) global.__cooldowns = new Map();
    const cooldowns = global.__cooldowns;
    function checkCooldown(name, uid, sec) {
      if (!sec) return { ok: true };
      const bucket = cooldowns.get(name) || new Map();
      const now = Date.now();
      const last = bucket.get(uid) || 0;
      const delta = (now - last) / 1000;
      if (delta < sec) return { ok: false, wait: Math.ceil(sec - delta) };
      bucket.set(uid, now); cooldowns.set(name, bucket);
      return { ok: true };
    }

    const cd = checkCooldown(cmd.name.toLowerCase(), userId, cmd.cooldownSec || 0);
    if (!cd.ok) return;

    const say = (text) => client.say(channel, text);
    const reply = (text) => client.say(channel, `@${user} ${text}`);

    const replyThread = async (text) => {
      const parentId = tags['id'];
      try {
        await sendThreadedReply({
          token: tokenState.accessToken,
          clientId: TWITCH_CLIENT_ID,
          channel,
          parentId,
          message: text
        });
      } catch {
        await reply(text);
      }
    };

    try {
      await cmd.run({
        client, channel, tags, user, args,
        say, reply, replyThread,
        prefix: CMD_PREFIX,
        reload: rebuildCommands,
        reloadConfig: reloadRuntimeConfig,
        getToken: () => tokenState.accessToken
      });
    } catch (err) {
      console.error(`[CMD] ${cmd.name} error:`, err);
    }
  });

  try { await client.connect(); }
  catch (err) { console.error('Connect error:', err); process.exit(1); }
}

main().catch(err => { console.error(err); process.exit(1); });
