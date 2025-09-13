#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..', 'bot.js');
let src = fs.readFileSync(BOT, 'utf8');
let changed = false;

// 1) Ensure linkguard is required (safe no-op if already present)
if (!/require\(['"]\.\/src\/moderation\/linkguard['"]\)/.test(src)) {
  src = src.replace(/(const\s+path\s*=\s*require\(['"]path['"]\);\s*)/,
                    `$1const linkguard = require('./src/moderation/linkguard');\n`);
  changed = true;
}

// 2) Ensure routeChat(ev) exists (skip if present)
if (!/async function routeChat\s*\(\s*ev\s*\)/.test(src)) {
  const inject = `
async function routeChat(ev) {
  // minimal ctx for linkguard + router
  const ctx = {
    generalCfg: () => {
      try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'config', 'bot-general-config.json'), 'utf8')); }
      catch { return {}; }
    },
    clientId: CLIENT_ID,
    say: (text) => sendChat(text),
    reply: (text, parent) => sendChat(text, { reply_parent_message_id: parent || ev.messageId }),
  };

  try { if (process.env.LINKGUARD_DEBUG) console.log('[LG] routeChat start', { text: ev && ev.text, user: ev && ev.userLogin }); } catch {}

  try {
    const gen = ctx.generalCfg() || {};
    const lg = (gen.moderation && gen.moderation.linkGuard) || null;

    // Only enforce on non-command lines
    const isCommand = (ev.text || '').trim().startsWith(CMD_PREFIX);
    if (!isCommand && lg) {
      const acted = await linkguard.checkAndHandle(ev, ctx, lg);
      if (acted) return true;
    }
  } catch (e) {
    console.warn('[LG] route error', e && e.message ? e.message : e);
  }

  // Fall through to the normal command router
  return handleCommand(ev);
}
`;
  // inject right after sendChat() definition which exists early in the file
  src = src.replace(/(\n\/\/\s*helix fetch helper[\s\S]*?\n}\n)/, `$1\n${inject}\n`);
  changed = true;
}

// 3) Rewire any residual handleCommand(ev) call sites → routeChat(ev)
const before = src;
src = src.replace(/const\s+handled\s*=\s*await\s*handleCommand\s*\(\s*ev\s*\)\s*;/g,
                  'const handled = await routeChat(ev);');
src = src.replace(/await\s+handleCommand\s*\(\s*ev\s*\)\s*;/g,
                  'await routeChat(ev);');
if (src !== before) changed = true;

// 4) Ensure intake POST handler calls routeChat(ev).
// Find the intake block: req.on('end', async () => { ... })
src = src.replace(
  /(req\.on\('end',\s*async\s*\(\)\s*=>\s*\{\s*[\s\S]*?)(if\s*\(!ev\.text\)\s*\{\s*res\.statusCode\s*=\s*204;\s*return\s*res\.end\(\);\s*\}\s*)([\s\S]*?)(res\.statusCode\s*=\s*204;\s*res\.end\(\);\s*\}\)\);\s*\}\);\s*srv\.listen\()/,
  (m, head, guard, middle, tail) => {
    // If there's already a routeChat(ev) in the middle part, keep as is
    if (/routeChat\s*\(\s*ev\s*\)/.test(middle)) return m;
    // Otherwise insert the call before the 204/end
    changed = true;
    const inserted = `
      try {
        await routeChat(ev);
      } catch (e) {
        console.warn('[INTAKE] routeChat error', e && e.message ? e.message : e);
      }
`;
    return head + guard + inserted + middle + tail;
  }
);

if (changed) {
  fs.writeFileSync(BOT, src);
  console.log('[force-route] bot.js patched to call routeChat(ev) from intake');
} else {
  console.log('[force-route] no changes needed');
}
