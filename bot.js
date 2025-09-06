require('dotenv').config();
const fs = require('fs');
const path = require('path');
const tmi = require('tmi.js');

const {
  BOT_USERNAME,
  CHANNELS,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_REFRESH_TOKEN,
  CMD_PREFIX = '!'
} = process.env;

if (!BOT_USERNAME || !CHANNELS || !TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !TWITCH_REFRESH_TOKEN) {
  console.error("Missing required env vars. Check your .env file.");
  process.exit(1);
}

// ---------- Auth: refresh tokens ----------
let tokenState = { accessToken: null, expiresAt: 0, refreshTimer: null };

async function refreshAccessToken(reason = "scheduled") {
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
  if (data.refresh_token && data.refresh_token !== TWITCH_REFRESH_TOKEN) {
    console.warn("[AUTH] Twitch rotated your refresh_token. Update your .env.");
    console.warn("[AUTH] New refresh_token:", data.refresh_token);
  }

  const now = Date.now();
  const expiresInMs = (data.expires_in || 3600) * 1000;
  tokenState.accessToken = data.access_token;
  tokenState.expiresAt = now + expiresInMs;

  const skew = Math.min(5 * 60 * 1000, Math.floor(expiresInMs * 0.1)); // 5m or 10%
  const refreshIn = Math.max(60 * 1000, expiresInMs - skew);
  if (tokenState.refreshTimer) clearTimeout(tokenState.refreshTimer);
  tokenState.refreshTimer = setTimeout(() => {
    refreshAccessToken("timer").catch(err => console.error("[AUTH] scheduled refresh error:", err));
  }, refreshIn);

  console.log(`[AUTH] ${reason} refresh ok. Next refresh in ~${Math.round(refreshIn/1000)}s, expires_in=${Math.round(expiresInMs/1000)}s`);
  return tokenState.accessToken;
}
function tokenWillExpireSoon() { return Date.now() > (tokenState.expiresAt - 60 * 1000); }

// ---------- Command loader ----------
function loadCommands(dir) {
  const commands = new Map();
  const triggers = new Map(); // trigger -> command.name
  if (!fs.existsSync(dir)) {
    console.warn(`[CMD] Directory missing: ${dir}`);
    return { commands, triggers };
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
  for (const f of files) {
    const mod = require(path.join(dir, f));
    if (!mod || !mod.name || !mod.run) {
      console.warn(`[CMD] Skipping ${f}: missing name/run`);
      continue;
    }
    const aliasList = (mod.aliases || [mod.name]).map(s => s.toLowerCase());
    commands.set(mod.name.toLowerCase(), mod);
    for (const a of aliasList) triggers.set(a, mod.name.toLowerCase());
  }
  console.log(`[CMD] Loaded ${commands.size} commands from ${dir}`);
  return { commands, triggers };
}

function isBroadcaster(tags) {
  const b = tags.badges || {};
  return typeof b === 'object' && b.broadcaster === '1';
}
function isMod(tags) { return !!tags.mod || isBroadcaster(tags); }
function hasPermission(perm, tags) {
  if (perm === 'everyone') return true;
  if (perm === 'mod') return isMod(tags);
  if (perm === 'broadcaster') return isBroadcaster(tags);
  return false;
}

// cooldowns: Map<command, Map<userId, lastMs>>
const cooldowns = new Map();
function checkCooldown(cmd, userId, cooldownSec) {
  if (!cooldownSec) return { ok: true };
  const bucket = cooldowns.get(cmd) || new Map();
  const now = Date.now();
  const last = bucket.get(userId) || 0;
  const delta = (now - last) / 1000;
  if (delta < cooldownSec) {
    return { ok: false, wait: Math.ceil(cooldownSec - delta) };
  }
  bucket.set(userId, now);
  cooldowns.set(cmd, bucket);
  return { ok: true };
}

// ---------- Bot main ----------
async function main() {
  await refreshAccessToken("startup");
  const channels = CHANNELS.split(',').map(c => c.trim().toLowerCase()).filter(Boolean);

  const client = new tmi.Client({
    options: { debug: false },
    connection: { secure: true, reconnect: true },
    identity: { username: BOT_USERNAME, password: `oauth:${tokenState.accessToken}` },
    channels
  });

  // Patch refresh so future tokens update in-memory password
  const originalRefresh = refreshAccessToken;
  refreshAccessToken = async (reason) => {
    const tok = await originalRefresh.call(null, reason);
    client.opts.identity.password = `oauth:${tok}`;
    console.log('[AUTH] Updated in-memory password with fresh token.');
    return tok;
  };

  client.on('connected', (addr, port) => {
    console.log(`Connected to ${addr}:${port} as ${BOT_USERNAME}, joined ${channels.join(', ')}`);
  });

  client.on('disconnected', async (reason) => {
    console.warn('[NET] Disconnected:', reason);
    if (tokenWillExpireSoon()) {
      try {
        await refreshAccessToken("pre-reconnect");
        client.opts.identity.password = `oauth:${tokenState.accessToken}`;
        console.log('[AUTH] Updated password before reconnect.');
      } catch (err) {
        console.error('[AUTH] pre-reconnect refresh failed:', err);
      }
    }
  });

  const { commands, triggers } = loadCommands(path.join(__dirname, 'commands'));

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
    if (!hasPermission(cmd.permission || 'everyone', tags)) return;

    const cd = checkCooldown(cmd.name, userId, cmd.cooldownSec || 0);
    if (!cd.ok) return;

    const say = (text) => client.say(channel, text);
    const reply = (text) => client.say(channel, `@${user} ${text}`);

    try {
      await cmd.run({ client, channel, tags, user, args, say, reply, prefix: CMD_PREFIX });
    } catch (err) {
      console.error(`[CMD] ${cmd.name} error:`, err);
    }
  });

  try {
    await client.connect();
  } catch (err) {
    console.error('Connect error:', err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
