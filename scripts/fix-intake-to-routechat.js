#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot.js');
let src = fs.readFileSync(BOT, 'utf8');

const idx = src.indexOf('/_intake/chat');
if (idx === -1) {
  console.error('✖ Cannot find "/_intake/chat" in bot.js');
  process.exit(1);
}

// From the intake block forward, replace any handleCommand(ev) usages
const head = src.slice(0, idx);
let tail = src.slice(idx);

// Replace the common forms
tail = tail
  .replace(/await\s+handleCommand\s*\(\s*ev\s*\)\s*;/g, 'await routeChat(ev);')
  .replace(/const\s+handled\s*=\s*await\s*handleCommand\s*\(\s*ev\s*\)\s*;/g, 'const handled = await routeChat(ev);');

// Write back if changed
const out = head + tail;
if (out !== src) {
  fs.writeFileSync(BOT, out);
  console.log('[fix-intake] patched intake to call routeChat(ev)');
} else {
  console.log('[fix-intake] nothing changed (already routed)');
}
