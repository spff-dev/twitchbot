#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot.js');
let src = fs.readFileSync(BOT, 'utf8');

// 1) ensure require line
if (!src.includes("require('./src/moderation/linkguard')")) {
  src = src.replace(
    /const path = require\('path'\);\s*/,
    "const path = require('path');\nconst linkguard = require('./src/moderation/linkguard');\n"
  );
}

// 2) install/replace routeChat
const ROUTE_FN = `async function routeChat(ev) {
  if (process.env.LINKGUARD_DEBUG && process.env.LINKGUARD_DEBUG !== '0') {
    try { console.log('[LG] routeChat start', { text: ev && ev.text, user: ev && ev.userLogin }); } catch {}
  }

  const ctx = {
    helix,
    getAppToken,
    getBroadcasterToken: () => getUserToken('broadcaster'),
    getBotToken:        () => getUserToken('bot'),
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

  return handleCommand(ev);
}`;

// replace existing routeChat or insert after sendChat
if (/async function routeChat\(ev\)\s*\{[\s\S]*?\n\}/.test(src)) {
  src = src.replace(/async function routeChat\(ev\)\s*\{[\s\S]*?\n\}/, ROUTE_FN);
} else {
  src = src.replace(/async function sendChat\([\s\S]*?\}\n/, m => m + '\n' + ROUTE_FN + '\n');
}

// 3) ensure intake path calls routeChat(ev)
src = src.replace(
  /(if\s*\(req\.method\s*!==\s*'POST'\s*\|\|\s*req\.url\s*!==\s*'\/_intake\/chat'\)[\s\S]*?\{[\s\S]*?)(await\s+handleCommand\(ev\)\s*;?)/,
  (_, head) => head + 'await routeChat(ev);'
);
// also replace any "const handled = await handleCommand(ev);" forms
src = src.replace(/const\s+handled\s*=\s*await\s*handleCommand\(ev\);/g, 'const handled = await routeChat(ev);');

fs.writeFileSync(BOT, src);
console.log('[LG-PATCH] bot.js updated');
