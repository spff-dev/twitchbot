'use strict';

const fs = require('fs');
const path = require('path');

module.exports.name = 'reload';
module.exports.aliases = ['rl', 'rehash'];
module.exports.description = 'Hot reload all command modules';
module.exports.permission = 'broadcaster';
module.exports.cooldownSec = 3;

function countFromDir() {
  const dir = path.join(__dirname);
  try {
    const files = fs.readdirSync(dir).filter(f =>
      f.endsWith('.js') && !f.endsWith('.old')
    );
    return files.length;
  } catch {
    return 0;
  }
}

module.exports.run = async function reload(ctx) {
  if (!(ctx.isBroadcaster || ctx.isMod)) return;

  try {
    await ctx.reload();
    let count = 0;
    try {
      if (typeof ctx.listCommands === 'function') {
        count = (ctx.listCommands() || []).length;
      } else if (ctx.commands && typeof ctx.commands.size === 'number') {
        count = ctx.commands.size;
      } else {
        count = countFromDir();
      }
    } catch {
      count = countFromDir();
    }

    await ctx.say(`Reloaded ${count} command${count === 1 ? '' : 's'}.`);
  } catch (e) {
    await ctx.say('Reload failed.');
    console.error('[RELOAD] error', e && e.message ? e.message : e);
  }
};
