'use strict';

const fs = require('fs');
const path = require('path');

function readJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return null; }
}

function writeJSON(fp, obj) {
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + '\n');
}

function walkJs(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [path.resolve(dir)]; // force absolute
  while (stack.length) {
    const d = stack.pop();
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.resolve(d, ent.name); // force absolute
      if (ent.isDirectory()) stack.push(fp);
      else if (ent.isFile() && fp.endsWith('.js')) out.push(fp);
    }
  }
  return out;
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return (override ?? base);
  if (base && typeof base === 'object' && override && typeof override === 'object') {
    const out = { ...base };
    for (const k of Object.keys(override)) out[k] = deepMerge(base[k], override[k]);
    return out;
  }
  return (override !== undefined ? override : base);
}

function safeLower(x, fallback = '') {
  const s = (x === undefined || x === null) ? fallback : String(x);
  return s.toLowerCase();
}

function normalizeKind(k) {
  const s = safeLower(k, 'module');
  if (s === 'static' || s === 'dynamic' || s === 'module') return s;
  return 'module';
}

/**
 * Loads all manifest commands from /commands and merges with config JSON.
 * Returns { registry, aliasMap, config } for the router.
 */
function loadManifestsAndConfig({ root, commandsDir, configPath, logger = console }) {
  const files = walkJs(commandsDir);
  const manifests = [];

  for (const fileAbs of files) {
    // Always absolute; cache-bust and load
    try { delete require.cache[require.resolve(fileAbs)]; } catch {}
    let mod;
    try {
      mod = require(fileAbs);
    } catch (e) {
      logger.warn('[CFG] skip require failed', path.relative(root || process.cwd(), fileAbs), e.message);
      continue;
    }

    const schemaVersion = mod?.schemaVersion ?? mod?.default?.schemaVersion;
    const m = mod?.manifest ?? mod?.default?.manifest;
    if (schemaVersion !== 3 || !m) {
      // Not a v3 manifest command, ignore silently
      continue;
    }

    const name = m.name || path.basename(fileAbs, '.js');
    const kind = normalizeKind(m.kind);
    const category = safeLower(m.category, (kind === 'static' ? 'static' : 'dynamic'));

    manifests.push({
      file: fileAbs,
      name,
      manifest: { ...m, name, kind, category }
    });
  }

  const cfg = readJSON(configPath) || {};
  cfg.commands = cfg.commands || {};

  for (const entry of manifests) {
    const name = entry.name;
    const defaults = entry.manifest.defaults || {};
    const existing = cfg.commands[name] || {};

    // Merge manifest defaults -> existing config
    const merged = deepMerge(defaults, existing);

    // Normalize kind/category with safe fallbacks
    merged.kind = normalizeKind(merged.kind || entry.manifest.kind || 'module');
    merged.category = safeLower(
      merged.category || entry.manifest.category || (merged.kind === 'static' ? 'static' : 'dynamic')
    );

    // Ensure response exists for non-module commands
    if (merged.kind !== 'module' && typeof merged.response !== 'string') {
      merged.response = '';
    }

    cfg.commands[name] = merged;
  }

  // Persist any new seeds/normalizations
  try { writeJSON(configPath, cfg); }
  catch (e) { logger.warn('[CFG] write failed', e.message); }

  // Build runtime maps for router
  const registry = new Map();
  const aliasMap = new Map();

  for (const entry of manifests) {
    const name = entry.name;
    const meta = cfg.commands[name] || {};
    registry.set(name, { manifest: entry.manifest, config: meta, file: entry.file });

    const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
    for (const a of aliases) {
      if (!a) continue;
      aliasMap.set(String(a).toLowerCase(), name);
    }
  }

  return { registry, aliasMap, config: cfg };
}

module.exports = { loadManifestsAndConfig };
