#!/usr/bin/env node
'use strict';

// Migrate legacy "static" commands to config-only:
// - Extracts a default response from commands/**/<cmd>.js (no require/exec)
// - Writes/updates config/bot-commands-config.json
// - Sets kind:"static", preserves existing settings where present
//
// Usage:
//   node scripts/migrate-static-commands.js discord lurk dbd rust links steam specs xmas

const fs = require('fs');
const p  = require('path');

const ROOT = p.join(__dirname, '..');
const CMD_DIR = p.join(ROOT, 'commands');
const CFG  = p.join(ROOT, 'config', 'bot-commands-config.json');

const targets = process.argv.slice(2).map(s => s.toLowerCase());
if (!targets.length) {
  console.error('Usage: node scripts/migrate-static-commands.js <cmd1> <cmd2> ...');
  process.exit(2);
}

function loadJSON(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return fallback; }
}
function saveJSON(fp, obj) {
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function walkJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const fp = p.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(fp);
      else if (ent.isFile() && fp.endsWith('.js')) out.push(fp);
    }
  }
  return out;
}

// Heuristics to extract a default response without executing the module.
// Looks for: ctx.say("..."), ctx.reply('...'), return "..." or response: "..."
function extractResponseFromText(txt) {
  const patterns = [
    /ctx\.(?:say|reply)\s*\(\s*(['"`])([\s\S]*?)\1\s*\)/m,
    /return\s+(['"`])([\s\S]*?)\1\s*;?/m,
    /response\s*:\s*(['"`])([\s\S]*?)\1/m,
  ];
  for (const re of patterns) {
    const m = re.exec(txt);
    if (m && m[2] && m[2].trim()) return m[2].trim();
  }
  return null;
}

function findCommandFile(name) {
  const files = walkJs(CMD_DIR);
  const exact = files.find(fp => p.basename(fp, '.js').toLowerCase() === name);
  return exact || null;
}

const cfg = loadJSON(CFG, { commands: {} });
cfg.commands = cfg.commands || {};

const changed = [];
const seeded  = [];
const missing = [];

for (const name of targets) {
  const block = cfg.commands[name] || {};
  let response = (block.response || '').trim();

  if (!response) {
    const fp = findCommandFile(name);
    if (fp && fs.existsSync(fp)) {
      const txt = fs.readFileSync(fp, 'utf8');
      const ext = extractResponseFromText(txt);
      if (ext && ext.trim()) {
        response = ext.trim();
        seeded.push(`${name} <- ${p.relative(CMD_DIR, fp)}`);
      }
    }
  }

  if (!response) {
    response = `<< set response for !${name} >>`;
    missing.push(name);
  }

  const out = {
    ...block,
    kind: 'static',
    category: block.category || 'static',
    roles: Array.isArray(block.roles) && block.roles.length ? block.roles : ['everyone'],
    cooldownSeconds: typeof block.cooldownSeconds === 'number' ? block.cooldownSeconds : 3,
    // Default: lurk tends to reply; others print to chat
    replyToUser:
      typeof block.replyToUser === 'boolean'
        ? block.replyToUser
        : (name === 'lurk' ? true : false),
    response
  };

  cfg.commands[name] = out;
  changed.push(name);
}

saveJSON(CFG, cfg);

console.log('Migrated to kind=static:', changed.length ? changed.join(', ') : '(none)');
console.log('Seeded responses from legacy JS:', seeded.length ? '\n  - ' + seeded.join('\n  - ') : '(none)');
console.log('Still missing (placeholder inserted):', missing.length ? missing.join(', ') : '(none)');
console.log('\nNext: edit any placeholders in config/bot-commands-config.json, then restart:');
console.log('  pm2 restart twitchbot && pm2 logs twitchbot --lines 40');
