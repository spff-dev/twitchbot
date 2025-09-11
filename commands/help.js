'use strict';

const fs = require('fs');
const path = require('path');

module.exports.name = 'help';

function readJsonC(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    raw = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    raw = raw.replace(/(^|\s)\/\/.*$/gm, '');
    raw = raw.replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(raw);
  } catch {
    return { commands: {} };
  }
}

function loadMetas() {
  const dir = path.join(__dirname);
  const cfg = readJsonC(path.join(__dirname, '..', 'config', 'commands.json'));
  const ov = cfg.commands || {};
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.js') && !f.endsWith('.old') && f !== 'help.js');

  const metas = [];
  for (const f of files) {
    try {
      const mod = require(path.join(dir, f));
      const name = String(mod.name || '').toLowerCase();
      if (!name) continue;
      const o = ov[name] || {};
      if (o.enabled === false) continue;
      metas.push({
        name,
        aliases: (o.aliases ?? mod.aliases ?? []).map(a => String(a)),
        description: String((o.description ?? mod.description ?? '')).trim(),
        permission: String((o.permission ?? mod.permission ?? 'everyone')).toLowerCase(),
      });
    } catch {
      // ignore bad modules
    }
  }

  metas.sort((a, b) => a.name.localeCompare(b.name));
  return { metas, ov };
}

module.exports.run = async function help(ctx, args) {
  const prefix = String(process.env.CMD_PREFIX || '!');
  const { metas, ov } = loadMetas();

  if (args && args.length) {
    const raw = String(args[0]).toLowerCase();
    const q = raw.startsWith(prefix.toLowerCase()) ? raw.slice(prefix.length) : raw;

    const m = metas.find(m =>
      m.name === q ||
      (m.aliases || []).some(a => a.toLowerCase() === q)
    );

    if (!m) {
      await ctx.reply(`no command named "${args[0]}"`);
      return;
    }

    const aliasStr = m.aliases && m.aliases.length ? ` (aliases: ${m.aliases.join(', ')})` : '';
    const desc = m.description || 'no description';
    const perm = m.permission || 'everyone';
    const ovMeta = ov[m.name] || {};
    const cd = ovMeta.cooldownSec != null ? ` cooldown ${ovMeta.cooldownSec}s` : '';
    await ctx.reply(`ℹ️ ${prefix}${m.name}${aliasStr} - ${desc} [perm: ${perm}]${cd}`);
    return;
  }

  if (!metas.length) {
    await ctx.reply('ℹ️ No commands are available.');
    return;
  }

  const names = metas.map(m => `${prefix}${m.name}`);
  let out = 'ℹ️ Commands: ';
  const shown = [];
  for (const n of names) {
    if ((out + (shown.length ? ', ' : '') + n).length > 440) break;
    shown.push(n);
    out += (shown.length === 1 ? '' : ', ') + n;
  }
  const remaining = names.length - shown.length;
  if (remaining > 0) out += ` ... (+${remaining} more)`;
  out += ` - try "${prefix}help <command>"`;
  await ctx.reply(out);
};
