#!/usr/bin/env node
/* Config validator for SpiffyOS. No deps, Node 18+.
   Validates:
   - config/templates.jsonc
   - config/commands.json (metadata, greeting, cheerGuard)
   - config/announcements.js (array of items)
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE_TEMPLATES  = path.join(ROOT, 'config', 'templates.jsonc');
const FILE_COMMANDS   = path.join(ROOT, 'config', 'commands.json');
const FILE_ANNOUNCEMENTS = path.join(ROOT, 'config', 'announcements.js');

function readJsonC(file) {
  const raw0 = fs.readFileSync(file, 'utf8');
  // strip /* ... */ and // ... comments
  let raw = raw0.replace(/\/\*[\s\S]*?\*\//g, '');
  raw = raw.replace(/(^|\s)\/\/.*$/gm, '');
  // remove trailing commas
  raw = raw.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(raw);
}

function fail(msg) { throw new Error(msg); }
function isStr(x) { return typeof x === 'string'; }
function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function isBool(x){ return typeof x === 'boolean'; }
function arr(x) { return Array.isArray(x) ? x : []; }

function validateTemplates() {
  if (!fs.existsSync(FILE_TEMPLATES)) fail(`Missing ${path.relative(ROOT, FILE_TEMPLATES)}`);
  const j = readJsonC(FILE_TEMPLATES);
  const t = j.templates;
  if (!t || typeof t !== 'object') fail(`templates.jsonc must have a "templates" object`);
  const required = ['bits','sub','resub','gift','raidShoutout'];
  for (const k of required) {
    if (!isStr(t[k]) || !t[k].trim()) fail(`templates.${k} must be a nonempty string`);
  }
}

function validateCommands() {
  if (!fs.existsSync(FILE_COMMANDS)) return; // optional, but recommended
  const j = readJsonC(FILE_COMMANDS);

  // commands: metadata only
  if (j.commands && typeof j.commands === 'object') {
    for (const [name, cfg] of Object.entries(j.commands)) {
      if (cfg == null || typeof cfg !== 'object') fail(`commands.${name} must be an object`);
      if (cfg.enabled != null && !isBool(cfg.enabled)) fail(`commands.${name}.enabled must be boolean`);
      if (cfg.aliases != null && !Array.isArray(cfg.aliases)) fail(`commands.${name}.aliases must be array`);
      if (Array.isArray(cfg.aliases) && !cfg.aliases.every(isStr)) fail(`commands.${name}.aliases must be array of strings`);
      if (cfg.permission != null && !['everyone','mod','broadcaster'].includes(String(cfg.permission).toLowerCase())) {
        fail(`commands.${name}.permission must be one of everyone|mod|broadcaster`);
      }
      if (cfg.cooldownSec != null && !(isNum(cfg.cooldownSec) && cfg.cooldownSec >= 0)) {
        fail(`commands.${name}.cooldownSec must be a nonnegative number`);
      }
      if (cfg.description != null && !isStr(cfg.description)) fail(`commands.${name}.description must be a string`);
    }
  }

  // greeting
  if (j.greeting != null) {
    const g = j.greeting;
    if (typeof g !== 'object') fail(`greeting must be an object`);
    if (g.enabled != null && !isBool(g.enabled)) fail(`greeting.enabled must be boolean`);
    if (g.message != null && !isStr(g.message)) fail(`greeting.message must be a string`);
    if (g.delayMs != null && !(isNum(g.delayMs) && g.delayMs >= 0)) fail(`greeting.delayMs must be a nonnegative number`);
    if (g.minIntervalSec != null && !(isNum(g.minIntervalSec) && g.minIntervalSec >= 0)) fail(`greeting.minIntervalSec must be a nonnegative number`);
  }

  // cheerGuard
  if (j.cheerGuard != null) {
    const c = j.cheerGuard;
    if (typeof c !== 'object') fail(`cheerGuard must be an object`);
    for (const k of ['windowSec','max','muteSec']) {
      if (!(isNum(c[k]) && c[k] >= 0)) fail(`cheerGuard.${k} must be a nonnegative number`);
    }
  }

  // Ignore any templates key here by design
}

function validateAnnouncements() {
  // Require the file, but do not crash if it throws; report path and error.
  delete require.cache[FILE_ANNOUNCEMENTS];
  let items;
  try {
    items = require(FILE_ANNOUNCEMENTS);
  } catch (e) {
    fail(`announcements.js failed to load: ${e.message}`);
  }
  if (!Array.isArray(items)) fail(`announcements.js must export an array`);
  items.forEach((it, i) => {
    if (!it || typeof it !== 'object') fail(`announcements[${i}] must be an object`);
    if (!isStr(it.text) || !it.text.trim()) fail(`announcements[${i}].text must be a nonempty string`);
    if (!(isNum(it.everyMin) && it.everyMin > 0)) fail(`announcements[${i}].everyMin must be a number > 0`);
    if (it.initialDelayMin != null && !(isNum(it.initialDelayMin) && it.initialDelayMin >= 0)) {
      fail(`announcements[${i}].initialDelayMin must be a nonnegative number`);
    }
    if (it.jitterSec != null && !(isNum(it.jitterSec) && it.jitterSec >= 0)) {
      fail(`announcements[${i}].jitterSec must be a nonnegative number`);
    }
    if (it.type != null && !['chat','announcement'].includes(it.type)) {
      fail(`announcements[${i}].type must be "chat" or "announcement"`);
    }
    if (it.liveOnly != null && !isBool(it.liveOnly)) {
      fail(`announcements[${i}].liveOnly must be boolean`);
    }
  });
}

function main() {
  const errors = [];
  function run(name, fn) {
    try { fn(); console.log(`OK ${name}`); }
    catch (e) { errors.push(`${name}: ${e.message}`); }
  }
  run('templates.jsonc', validateTemplates);
  run('commands.json', validateCommands);
  run('announcements.js', validateAnnouncements);

  if (errors.length) {
    console.error('\nConfig check failed:');
    for (const e of errors) console.error(' - ' + e);
    process.exit(1);
  } else {
    console.log('\nAll config files OK');
  }
}
main();
