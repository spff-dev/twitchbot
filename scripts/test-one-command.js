#!/usr/bin/env node
'use strict';

/**
 * One-command sanity harness.
 *
 * Examples:
 *   node scripts/test-one-command.js --text='!time'
 *   node scripts/test-one-command.js --text '!clip' --offline
 *   node scripts/test-one-command.js --text='!clip' --live
 *   node scripts/test-one-command.js --text='!so Wattsie123' --live --announce204 --shoutoutOk
 */

const fs = require('fs');
const p  = require('path');

// --- robust arg parser (supports --k v and --k=v)
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else {
        if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          val = argv[++i];
        } else {
          val = true;
        }
      }
      out[key] = val;
    } else {
      out._.push(a);
    }
  }
  return out;
}

const argv = parseArgs(process.argv.slice(2));

const TEXT        = (argv.text !== undefined ? String(argv.text) : '!time');
const LIVE        = !!argv.live && !argv.offline; // live only if --live and not --offline
const ANNOUNCE204 = !!argv.announce204;
const SHOUTOK     = !!argv.shoutoutOk;

const ROOT        = p.join(__dirname, '..');
const CONFIG_PATH = p.join(ROOT, 'config', 'bot-commands-config.json');
const CMDDIR      = p.join(ROOT, 'commands');

const { createRouter } = require(p.join(ROOT, 'src', 'core', 'router'));

// --- load config
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
cfg.commands = cfg.commands || {};

// --- walk commands/** to build registry (manifest only)
function walkJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = p.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkJs(fp));
    else if (ent.isFile() && fp.endsWith('.js')) out.push(fp);
  }
  return out;
}

const files = walkJs(CMDDIR);
const registry = new Map();
const aliasMap = new Map();

for (const fp of files) {
  delete require.cache[require.resolve(fp)];
  const mod = require(fp);
  const manifest = (mod && mod.schemaVersion) ? mod : (mod && mod.default && mod.default.schemaVersion ? mod.default : null);
  if (!manifest) continue;
  const name = (manifest.name || p.basename(fp, '.js')).toLowerCase();
  registry.set(name, { manifest, file: p.relative(CMDDIR, fp) });
}

// Build alias map from config (aliases live inside canonical block)
for (const [name, meta] of Object.entries(cfg.commands)) {
  if (!meta || !Array.isArray(meta.aliases)) continue;
  for (const a of meta.aliases) {
    const alias = String(a || '').toLowerCase();
    if (alias) aliasMap.set(alias, name);
  }
}

// --- stub helix (no network)
function mkRes(status, json) {
  return {
    ok: (status >= 200 && status < 300),
    status,
    async json() { return json; },
    async text() { return JSON.stringify(json); }
  };
}

const helix = async (pathname, opts) => {
  const path = String(pathname || '');

  // streams live/offline
  if (path.startsWith('/streams?user_id=')) {
    if (LIVE) {
      return mkRes(200, { data: [{
        id: '123', user_id: 'BC', user_login: 'broadcaster',
        type: 'live', started_at: new Date(Date.now() - 12*60*1000).toISOString(),
        game_name: 'SANITY_TEST'
      }]});
    }
    return mkRes(200, { data: [] });
  }
  // clips creation
  if (path.startsWith('/clips?broadcaster_id=')) {
    return mkRes(200, { data: [{ id: 'ClipSanity123' }] });
  }
  // users lookup (for so/so2)
  if (path.startsWith('/users?login=')) {
    const login = decodeURIComponent(path.split('=')[1] || '').toLowerCase();
    return mkRes(200, { data: [{ id: 'U123', login, display_name: login.charAt(0).toUpperCase()+login.slice(1) }] });
  }
  // games by id
  if (path.startsWith('/games?id=')) {
    return mkRes(200, { data: [{ id: 'G1', name: 'SANITY_GAME' }] });
  }
  // channels by broadcaster_id
  if (path.startsWith('/channels?broadcaster_id=')) {
    return mkRes(200, { data: [{ game_name: 'SANITY_GAME' }] });
  }
  // search channels
  if (path.startsWith('/search/channels?')) {
    return mkRes(200, { data: [{ broadcaster_login: 'wattsie123', game_name: 'SANITY_GAME' }] });
  }
  // announcements
  if (path.startsWith('/chat/announcements')) {
    return mkRes(ANNOUNCE204 ? 204 : 200, {});
  }
  // shoutouts
  if (path.startsWith('/chat/shoutouts')) {
    return mkRes(SHOUTOK ? 204 : 400, { message: SHOUTOK ? 'ok' : 'not allowed in stub' });
  }

  return mkRes(200, { ok: true, note: 'stub default', path, opts });
};

// --- stub tokens + ids
const getAppToken         = async () => 'app.STUB';
const getBroadcasterToken = async () => 'user.bc.STUB';
const getBotToken         = async () => 'user.bot.STUB';
const BROADCASTER_USER_ID = 'BC';
const BOT_USER_ID         = 'BOT';

// --- stub DB (no sqlite)
const db = {
  prepare(sql) {
    return {
      run() { /* noop */ },
      get() { return { c: 0 }; }
    };
  }
};

// --- stub sendChat that prints what would be sent
async function sendChat(message, opts) {
  const mode = opts && opts.reply_parent_message_id ? '(reply)' : '(chat)';
  console.log(`WOULD SEND ${mode}: ${message}`);
  return true;
}

// --- make router
const { handle } = createRouter({
  registry,
  aliasMap,
  config: cfg,
  db,
  sendChat,
  getAppToken,
  getBroadcasterToken,
  getBotToken,
  helix,
  broadcasterUserId: BROADCASTER_USER_ID,
  botUserId: BOT_USER_ID,
  cmdPrefix: '!'
});

// --- fabricate a single chat event
const ev = {
  text: TEXT,
  userId: 'U_viewer', userLogin: 'viewer', userName: 'Viewer',
  channelId: BROADCASTER_USER_ID, channelLogin: 'broadcaster',
  messageId: 'MID1',
  isMod: true, isBroadcaster: false
};

console.log(`\n== SANITY ==\ntext: ${TEXT}\nlive: ${LIVE}\nannounce204: ${ANNOUNCE204}\nshoutoutOk: ${SHOUTOK}\n`);
handle(ev).then(() => {
  console.log('\n[done]');
}).catch(e => {
  console.error('Error in handle:', e);
  process.exit(1);
});
