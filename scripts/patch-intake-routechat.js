#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot.js');
let src = fs.readFileSync(BOT, 'utf8');

const before = src;

// Replace the two common patterns safely, anywhere in the file.
// (OK if eventsub also goes through routeChat - linkguard will run once and then commands route.)
src = src.replace(/const\s+handled\s*=\s*await\s*handleCommand\s*\(\s*ev\s*\)\s*;/g,
                  'const handled = await routeChat(ev);');
src = src.replace(/await\s+handleCommand\s*\(\s*ev\s*\)\s*;/g,
                  'await routeChat(ev);');

if (src !== before) {
  fs.writeFileSync(BOT, src);
  console.log('[patch] rewired handleCommand(ev) call-sites -> routeChat(ev)');
} else {
  console.log('[patch] nothing to change (no handleCommand(ev) call-sites found with those forms)');
}
