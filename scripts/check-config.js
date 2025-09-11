#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const errors = [];
const warns = [];

function ok(label)   { console.log(`OK ${label}`); }
function err(label)  { errors.push(label); console.log(`ERR ${label}`); }
function warn(label) { warns.push(label); console.log(`WARN ${label}`); }

function loadJSON(fp, reqKeys = []) {
  try {
    const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
    for (const k of reqKeys) {
      if (!(k in obj)) throw new Error(`missing key "${k}"`);
    }
    return obj;
  } catch (e) {
    err(`parse ${fp}: ${e.message}`);
    return null;
  }
}

const cfgCmds = path.join(root, 'config', 'bot-commands-config.json');
const cfgGen  = path.join(root, 'config', 'bot-general-config.json');

// Commands config (required, must have { commands: {} })
if (!fs.existsSync(cfgCmds)) {
  err(`missing ${path.relative(root, cfgCmds)}`);
} else {
  const j = loadJSON(cfgCmds, ['commands']);
  if (j) ok('bot-commands-config.json');
}

// General config (required)
if (!fs.existsSync(cfgGen)) {
  err(`missing ${path.relative(root, cfgGen)}`);
} else {
  const j = loadJSON(cfgGen);
  if (j) ok('bot-general-config.json');
}

// Legacy files (optional; warn only)
[
  'config/commands.json',
  'config/templates.jsonc',
  'config/announcements.js',
  'config/bot-general-config.js',
  'config/bot-commands-config.js'
].forEach(rel => {
  const fp = path.join(root, rel);
  if (fs.existsSync(fp)) warn(`legacy file present: ${rel} (safe to remove)`);
});

if (errors.length) {
  console.error('Config check failed:');
  for (const e of errors) console.error(' -', e);
  process.exit(1);
} else {
  console.log('Config check passed.');
  process.exit(0);
}
