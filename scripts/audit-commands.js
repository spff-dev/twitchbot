#!/usr/bin/env node
'use strict';

const fs = require('fs');
const p  = require('path');

const ROOT   = p.join(__dirname, '..');
const CMDDIR = p.join(ROOT, 'commands');
const CFG    = p.join(ROOT, 'config', 'bot-commands-config.json');

function walkJs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = p.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walkJs(fp));
    else if (ent.isFile() && fp.endsWith('.js')) out.push(fp);
  }
  return out;
}
function readJSON(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return fallback; }
}

const files = walkJs(CMDDIR);
const manifests = [];
const legacy    = [];

for (const fp of files) {
  try {
    delete require.cache[require.resolve(fp)];
    const mod = require(fp);
    const m = (mod && mod.schemaVersion) || (mod?.default?.schemaVersion);
    (m ? manifests : legacy).push(p.relative(CMDDIR, fp));
  } catch (e) {
    legacy.push(p.relative(CMDDIR, fp) + ` (load error: ${e.message})`);
  }
}

const cfg = readJSON(CFG, { commands: {} });
const empties = Object.entries(cfg.commands || {})
  .filter(([k, v]) => !v || !String(v.response || '').trim())
  .map(([k]) => k);

function printList(title, arr) {
  console.log(`${title}: ${arr.length ? arr.join(', ') : '(none)'}`);
}

printList('Manifest commands', manifests.sort());
printList('Legacy/non-manifest', legacy.sort());
printList('Empty/missing response in config', empties.sort());
