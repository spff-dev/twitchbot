const fs = require('fs');
const path = require('path');
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'commands.json');

function readJsonC(file) {
  let raw = fs.readFileSync(file, 'utf8');
  raw = raw.replace(/\/\*[\s\S]*?\*\//g, '');   // /* block */
  raw = raw.replace(/(^|\s)\/\/.*$/gm, '');     // // line
  raw = raw.replace(/,(\s*[}\]])/g, '$1');      // trailing commas
  return JSON.parse(raw);
}
function getConfig() {
  try { return readJsonC(CONFIG_PATH); } catch { return {}; }
}

const DEFAULT_TEMPLATES = {
  bits:  '⭐ {USER} just cheered {BITS} bits — thank you!',
  sub:   '💜 {USER} just subscribed ({TIER}) — thank you!',
  resub: '💜 {USER} resubscribed ({TIER}) — {MONTHS} months!',
  gift:  '🎁 {ANON}{GIFTER} gifted {COUNT} {TIER} sub{S}!'
};
function getTemplates() {
  const cfg = getConfig();
  return { ...DEFAULT_TEMPLATES, ...(cfg.templates || {}) };
}

const DEFAULT_CHEER_GUARD = { windowSec: 30, max: 3, muteSec: 300 };
function getCheerGuard() {
  const cfg = getConfig();
  const cg  = cfg.cheerGuard || {};
  return {
    windowSec: Number(cg.windowSec ?? DEFAULT_CHEER_GUARD.windowSec),
    max:       Number(cg.max       ?? DEFAULT_CHEER_GUARD.max),
    muteSec:   Number(cg.muteSec   ?? DEFAULT_CHEER_GUARD.muteSec),
  };
}

// simple formatter: replaces {TOKEN}
function format(tpl, ctx) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) =>
    (ctx[k] === 0 ? '0' : (ctx[k] ?? '')));
}

module.exports = { CONFIG_PATH, getConfig, getTemplates, getCheerGuard, format };
