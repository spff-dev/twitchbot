'use strict';

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const DEFAULT_META = {
  aliases: [],
  roles: ['everyone'],
  cooldownSeconds: 0,
  limitPerUser: 0,
  limitPerStream: 0,
  replyToUser: true,
  failSilently: true,
  category: 'dynamic',
  kind: 'module',
  response: '{out}'
};

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function deepFill(target, defaults) {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) return;
  for (const [k, dv] of Object.entries(defaults)) {
    const tv = target[k];
    if (isBlank(tv)) { target[k] = dv; continue; }
    if (Array.isArray(dv)) {
      if (!Array.isArray(tv) || tv.length === 0) target[k] = dv;
      continue;
    }
    if (dv && typeof dv === 'object') {
      if (!tv || typeof tv !== 'object' || Array.isArray(tv)) target[k] = dv;
      else deepFill(tv, dv);
      continue;
    }
  }
}

function readJSON(fp, fallback) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function walkJsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && p.endsWith('.js')) out.push(p);
    }
  }
  return out;
}

function loadManifestsAndConfig(opts) {
  const commandsDir = opts.commandsDir;
  const configPath = opts.configPath;
  const logger = opts.logger || console;

  let cfg = readJSON(configPath, null);
  if (!cfg) {
    cfg = { commands: {} };
    writeJSON(configPath, cfg);
    logger.log('[CFG] created', path.basename(configPath));
  }
  cfg.commands = cfg.commands || {};

  const ajv = new Ajv({ allErrors: true, useDefaults: true, removeAdditional: false, coerceTypes: true });
  addFormats(ajv);

  const registry = new Map();
  const files = walkJsFiles(commandsDir);
  for (const fp of files) {
    delete require.cache[require.resolve(fp)];
    const mod = require(fp);
    const manifest = mod && mod.schemaVersion ? mod : (mod?.default?.schemaVersion ? mod.default : null);
    if (!manifest) continue;
    const name = manifest.name.toLowerCase();
    manifest.category = manifest.category || 'dynamic';

    let validate = null;
    try {
      validate = ajv.compile({
        type: 'object',
        // IMPORTANT: allow config to carry extra knobs without warnings
        additionalProperties: true,
        properties: {
          ...manifest.schema.properties,
          aliases: { type: 'array', items: { type: 'string' }, default: DEFAULT_META.aliases },
          roles:   { type: 'array', items: { type: 'string' }, default: DEFAULT_META.roles },
          cooldownSeconds: { type: 'integer', minimum: 0, default: DEFAULT_META.cooldownSeconds },
          limitPerUser:    { type: 'integer', minimum: 0, default: DEFAULT_META.limitPerUser },
          limitPerStream:  { type: 'integer', minimum: 0, default: DEFAULT_META.limitPerStream },
          replyToUser:     { type: 'boolean', default: DEFAULT_META.replyToUser },
          failSilently:    { type: 'boolean', default: DEFAULT_META.failSilently },
          category:        { type: 'string', default: manifest.category },
          kind:            { type: 'string', enum: ['module','static'], default: 'module' },
          response:        { type: 'string', default: DEFAULT_META.response }
        },
        required: Array.from(new Set([...(manifest.schema.required || []), 'response']))
      });
    } catch (e) {
      logger.error('[CFG] schema compile failed for', name, e.message);
      continue;
    }
    registry.set(name, { manifest, validate });
  }

  const added = [];
  const normalized = [];

  for (const [name, entry] of registry.entries()) {
    const { manifest, validate } = entry;
    const block = cfg.commands[name] || {};

    deepFill(block, DEFAULT_META);
    deepFill(block, { category: manifest.category, kind: 'module' });
    deepFill(block, manifest.defaults || {});

    const ok = validate(block);
    if (!ok) {
      const msg = (validate.errors || []).map(e => `${e.instancePath||'.'} ${e.message}`).join('; ');
      // Log once; we no longer forbid extra props, so this should be rare/noisy only when types are wrong
      console.warn(`[CFG] normalized "${name}" with schema defaults: ${msg}`);
    }

    if (isBlank(block.response)) block.response = '{out}';

    if (!cfg.commands[name]) { cfg.commands[name] = block; added.push(name); }
    else { normalized.push(name); }
  }

  // Config-only static commands
  for (const [name, block] of Object.entries(cfg.commands)) {
    if ((block.kind || 'module') === 'static' && !registry.has(name)) {
      const manifest = {
        name, schemaVersion: 1, category: block.category || 'static',
        schema: { type: 'object', properties: {}, additionalProperties: true },
        defaults: {},
        async execute() { return { vars: {}, reply: !!block.replyToUser }; }
      };
      registry.set(name, { manifest, validate: ()=>true });
      if (isBlank(block.response)) block.response = '{out}';
      if (isBlank(block.roles))    block.roles = ['everyone'];
      if (isBlank(block.category)) block.category = 'static';
    }
  }

  if (added.length || normalized.length) {
    writeJSON(configPath, cfg);
    if (added.length)     logger.log('[CFG] added:', added.join(', '));
    if (normalized.length)logger.log('[CFG] normalized:', normalized.join(', '));
  }

  const aliasMap = new Map();
  for (const [name, block] of Object.entries(cfg.commands)) {
    aliasMap.set(name, name);
    const aliases = Array.isArray(block.aliases) ? block.aliases : [];
    for (const a of aliases) aliasMap.set(String(a).toLowerCase(), name);
  }

  return { registry, aliasMap, config: cfg };
}

module.exports = { loadManifestsAndConfig, DEFAULT_META };
