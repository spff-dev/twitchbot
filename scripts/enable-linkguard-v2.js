#!/usr/bin/env node
'use strict';
const fs = require('fs'), p = require('path');
const fp = p.join(__dirname, '..', 'bot.js');
let src = fs.readFileSync(fp, 'utf8');

// 1) ensure require (idempotent)
if (!src.includes("src/moderation/linkguard")) {
  src = src.replace(
    /(\nconst {\n\s*startEventSub,?\n\s*} = require\('\.\/lib\/eventsub'\);\n)/,
    `$1const linkguard = require('./src/moderation/linkguard');\n`
  );
}

// 2) ensure routeChat function present (idempotent)
if (!src.includes('function routeChat(ev)')) {
  const hook = `

// === [LINKGUARD ROUTER] ===
async function routeChat(ev) {
  const ctxLG = {
    helix,
    getBotToken: () => getUserToken('bot'),
    reply: (text, parent) => sendChat(text, { reply_parent_message_id: parent || ev.messageId }),
    say: (text) => sendChat(text)
  };
  let general = {};
  try { general = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'config', 'bot-general-config.json'), 'utf8')); } catch {}
  const lgCfg = (general.moderation && general.moderation.linkGuard) || {};
  const isCommand = (ev.text || '').trim().startsWith(CMD_PREFIX);
  if (!isCommand) {
    const handled = await linkguard.checkAndHandle(ev, ctxLG, lgCfg);
    if (handled) return true;
  }
  return handleCommand(ev);
}
`;
  src = src.replace(/(\nasync function sendChat[\s\S]+?\n}\n)/, `$1${hook}`);
}

// 3) replace all *calls* to handleCommand(ev) with routeChat(ev), but not the function definition
// 3a) const handled = await handleCommand(ev) -> routeChat
src = src.replace(
  /const\s+handled\s*=\s*await\s*handleCommand\s*\(\s*ev\s*\);/g,
  'const handled = await routeChat(ev);'
);
// 3b) await handleCommand(ev) -> routeChat
src = src.replace(
  /await\s+handleCommand\s*\(\s*ev\s*\);/g,
  'await routeChat(ev);'
);
// 3c) bare call handleCommand(ev); (avoid function definition)
src = src.replace(
  /(?<!function\s)handleCommand\s*\(\s*ev\s*\);/g,
  'routeChat(ev);'
);

fs.writeFileSync(fp, src);
console.log('[patch] v2: all handleCommand(ev) call sites routed through routeChat(ev)');
