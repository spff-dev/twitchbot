#!/usr/bin/env node
'use strict';

/**
 * Wires link guard into bot.js:
 *  - Adds: const linkguard = require('./src/moderation/linkguard');
 *  - Replaces routeChat(ev) to call linkguard.checkAndHandle(...) before handleCommand(ev)
 * Safe to re-run; idempotent.
 */

const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot.js');
let src = fs.readFileSync(BOT, 'utf8');

function ensureRequire(src) {
  if (src.includes("require('./src/moderation/linkguard')")) return src;
  const needle = `'use strict';`;
  const i = src.indexOf(needle);
  if (i === -1) throw new Error("Couldn't find 'use strict' prologue in bot.js");
  const insertAt = i + needle.length;
  const inject = `\n\nconst linkguard = require('./src/moderation/linkguard');\n`;
  return src.slice(0, insertAt) + inject + src.slice(insertAt);
}

function replaceRouteChat(src) {
  const re = /async\s+function\s+routeChat\s*\(\s*ev\s*\)\s*\{[\s\S]*?\}/m;
  if (!re.test(src)) throw new Error('Could not find routeChat(ev) in bot.js');

  const replacement =
`async function routeChat(ev) {
  // Minimal ctx for link guard + commands
  const ctx = {
    reply: (text, parent) => sendChat(text, { reply_parent_message_id: parent || ev.messageId }),
    say: (text) => sendChat(text),
    helix,
    getBotToken,
    generalCfg: () => { try { return require('./config/bot-general-config.json'); } catch { return {}; } },
    commandMeta: (name) => {
      try { const j = require('./config/bot-commands-config.json'); return (j.commands && j.commands[name]) || {}; } catch { return {}; }
    },
    user: { id: ev.userId, login: ev.userLogin, display: ev.userName },
    channel: { id: ev.channelId, login: ev.channelLogin },
    isMod: !!ev.isMod,
    isBroadcaster: !!ev.isBroadcaster
  };

  try {
    const gen = ctx.generalCfg() || {};
    const lg = (gen.moderation && gen.moderation.linkGuard) || null;

    // Run link guard first; if it acted (deleted/warned), stop here
    if (await linkguard.checkAndHandle(ev, ctx, lg)) return true;
  } catch (e) {
    console.warn('[LG] route error', e && e.message ? e.message : e);
  }

  // Otherwise, route as a command (or ignore if not a command)
  return handleCommand(ev);
}`;

  return src.replace(re, replacement);
}

// 1) ensure require
let changed = false;
const before = src;
src = ensureRequire(src);
if (src !== before) changed = true;

// 2) ensure routeChat content
const before2 = src;
src = replaceRouteChat(src);
if (src !== before2) changed = true;

if (!changed) {
  console.log('[wire-lg] already wired; no changes');
} else {
  fs.writeFileSync(BOT, src);
  console.log('[wire-lg] bot.js patched');
}
