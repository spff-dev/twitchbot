// /srv/bots/twitchbot/lib/config.js
const fs = require('fs');
const path = require('path');

const COMMANDS_PATH  = path.join(__dirname, '..', 'config', 'commands.json');   // JSONC
const TEMPLATES_PATH = path.join(__dirname, '..', 'config', 'templates.jsonc'); // JSONC

function readJsonC(file) {
  let raw = fs.readFileSync(file, 'utf8');
  // strip /* ... */ and // ... comments
  raw = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  raw = raw.replace(/(^|\s)\/\/.*$/gm, '');
  // remove trailing commas
  raw = raw.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(raw);
}

let templatesCache = {
  bits: "⭐ {USER} just cheered {BITS} bits - thank you!",
  sub: "💜 {USER} just subscribed ({TIER}) - thank you!",
  resub: "💜 {USER} resubscribed ({TIER}) - {MONTHS} months!",
  gift: "🎁 {ANON}{GIFTER} gifted {COUNT} {TIER} sub{S}!",
  raidShoutout: "Please go and give {USER} a follow {GAMEFRAG}https://twitch.tv/{LOGIN}"
};

let cheerGuardCache = { windowSec: 30, max: 3, muteSec: 300 };

function safeRead(file, fallbackObj, picker) {
  try {
    if (!fs.existsSync(file)) return fallbackObj;
    const j = readJsonC(file);
    return picker(j) || fallbackObj;
  } catch {
    return fallbackObj;
  }
}

function reloadConfig() {
  // Load templates
  templatesCache = safeRead(TEMPLATES_PATH, templatesCache, (j) => j.templates);

  // Load cheer guard from commands.json if present
  cheerGuardCache = safeRead(COMMANDS_PATH, cheerGuardCache, (j) => j.cheerGuard);
}

function getTemplates() {
  return { ...templatesCache };
}

function getCheerGuard() {
  return { ...cheerGuardCache };
}

// naive formatter: replaces {KEY} with values.KEY
function format(tpl, values) {
  return String(tpl || '').replace(/\{([A-Z0-9_]+)\}/g, (_, k) => {
    const v = values && values[k];
    return v == null ? '' : String(v);
  });
}

// initial load on module import
reloadConfig();

module.exports = { reloadConfig, getTemplates, getCheerGuard, format };
