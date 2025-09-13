#!/usr/bin/env node
'use strict';
const fs = require('fs'), p = require('path');
const fp = p.join(__dirname, '..', 'bot.js');
let src = fs.readFileSync(fp, 'utf8');

// 1) require linkguard once
if (!src.includes("src/moderation/linkguard")) {
  src = src.replace(/(\nconst {\n\s*startEventSub,?\n\s*} = require\('\.\/lib\/eventsub'\);\n)/,
    `$1const linkguard = require('./src/moderation/linkguard');\n`);
}

// 2) add routeChat if missing
if (!src.includes('function routeChat(ev)')) {
  const hook = `

// === [LINKGUARD ROUTER] ===
async function routeChat(ev) {
  // minimal context for linkguard
  const ctxLG = {
    helix,
    getBotToken: () => getUserToken('bot'),
    reply: (text, parent) => sendChat(text, { reply_parent_message_id: parent || ev.messageId }),
    say: (text) => sendChat(text)
  };
  // read general config (if available)
  let general = {};
  try { general = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'config', 'bot-general-config.json'), 'utf8')); } catch {}
  const lgCfg = (general.moderation && general.moderation.linkGuard) || {};

  // only enforce on non-command messages (let mods use commands freely)
  const isCommand = (ev.text || '').trim().startsWith(CMD_PREFIX);
  if (!isCommand) {
    const handled = await linkguard.checkAndHandle(ev, ctxLG, lgCfg);
    if (handled) return true; // consumed
  }

  return handleCommand(ev);
}
`;
  // place it after sendChat definition (so sendChat exists)
  src = src.replace(/(\nasync function sendChat\([\s\S]+?\n}\n)/, `$1${hook}`);
}

// 3) swap handleCommand(ev) call sites -> routeChat(ev)
src = src.replace(/await handleCommand\(ev\);/g, 'await routeChat(ev);');
src = src.replace(/const handled = await handleCommand\(ev\);/g, 'const handled = await routeChat(ev);');

fs.writeFileSync(fp, src);
console.log('[patch] linkguard enabled in bot.js');
