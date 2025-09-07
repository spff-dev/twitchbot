const fs = require('fs');
const path = require('path');

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

function loadMeta(commandsDir, cfgPath) {
  const files = fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'));
  const metas = [];
  let overrides = {};
  try { overrides = readJsonC(cfgPath).commands || {}; } catch { overrides = {}; }

  for (const f of files) {
    try {
      const mod = require(path.join(commandsDir, f));
      if (!mod || !mod.name) continue;
      const ov = overrides[(mod.name || '').toLowerCase()] || {};
      if (ov.enabled === false) continue;
      metas.push({
        name: String(mod.name),
        aliases: (ov.aliases ?? mod.aliases ?? []).map(a => String(a)),
        description: String((ov.description ?? mod.description ?? '')).trim(),
        permission: String((ov.permission ?? mod.permission ?? 'everyone'))
      });
    } catch { /* ignore bad modules */ }
  }
  metas.sort((a, b) => a.name.localeCompare(b.name));
  return metas;
}

module.exports = {
  name: 'help',
  aliases: ['commands', 'cmds'],
  description: 'List commands or get details: !help [command]',
  permission: 'everyone',
  cooldownSec: 2,
  async run(ctx) {
    const { args, say, reply, prefix } = ctx;
    const metas = loadMeta(path.join(__dirname), path.join(__dirname, '..', 'config', 'commands.json'));

    if (args.length) {
      const raw = args[0].toLowerCase();
      const q = raw.startsWith(prefix.toLowerCase()) ? raw.slice(prefix.length) : raw;
      const m = metas.find(m =>
        m.name.toLowerCase() === q ||
        (m.aliases || []).some(a => a.toLowerCase() === q)
      );
      if (!m) return reply(`no command named "${args[0]}"`);
      const aliasStr = m.aliases && m.aliases.length ? ` (aliases: ${m.aliases.join(', ')})` : '';
      const desc = m.description || 'no description';
      return say(`${prefix}${m.name}${aliasStr} - ${desc} [perm: ${m.permission}]`);
    }

    const names = metas.map(m => `${prefix}${m.name}`);
    let out = 'Commands: ';
    const shown = [];
    for (const n of names) {
      if ((out + (shown.length ? ', ' : '') + n).length > 450) break;
      shown.push(n);
      out += (shown.length === 1 ? '' : ', ') + n;
    }
    const remaining = names.length - shown.length;
    if (remaining > 0) out += ` … (+${remaining} more)`;
    out += ` - try "${prefix}help <command>"`;
    return say(out);
  }
};
