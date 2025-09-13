#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const fp = path.join(__dirname, '..', 'bot.js');
const s = fs.readFileSync(fp, 'utf8');

const hasRequire = /require\(['"]\.\/src\/moderation\/linkguard['"]\)/.test(s);
const hasRouteFn = /async function routeChat\s*\(\s*ev\s*\)/.test(s);

// We consider it “wired” if there is at least one call to routeChat(ev)
// (intake or any chat-entry point) - we no longer depend on "/_intake/chat" literal.
const callsRoute = /routeChat\s*\(\s*ev\s*\)/.test(s);

console.log(JSON.stringify({
  require_ok: hasRequire,
  routeChat_ok: hasRouteFn,
  some_path_calls_routeChat: callsRoute
}, null, 2));
