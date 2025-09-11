'use strict';

module.exports.name = 'cfgreload';

module.exports.run = async function cfgreload(ctx) {
  try {
    if (!(ctx.isMod || ctx.isBroadcaster)) return;
    const ok = ctx.reload && ctx.reload();
    const cfg = ctx.commandsCfg() || {};
    const count = cfg.commands ? Object.keys(cfg.commands).length : 0;
    await ctx.reply(`Config reloaded. Commands=${count}.`);
    return ok;
  } catch (e) {
    console.error('[CFGRELOAD] error', e);
    await ctx.reply('Reload failed.');
    return false;
  }
};
