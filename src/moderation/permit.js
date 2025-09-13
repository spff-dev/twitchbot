'use strict';

const { grantPermit } = require('../../src/moderation/linkguard');

module.exports = {
  schemaVersion: 1,
  name: 'permit',
  aliases: [],
  kind: 'module',
  category: 'moderator',

  defaults: {
    roles: ['mod','owner'],
    cooldownSeconds: 1,
    limitPerUser: 0,
    limitPerStream: 0,
    replyToUser: true,
    failSilently: false,
    response: 'Permitted {login} for {ttl}s.',
    templates: {
      usage: 'Usage: !permit <user> [seconds]',
      notFound: 'Unknown user: {target}',
      ok: 'Permitted {login} for {ttl}s.',
      onlyMods: 'Mods only.',
    }
  },

  async action(ctx, ev, _meta) {
    const args = (ev.text || '').trim().split(/\s+/).slice(1);
    const target = (args[0] || '').replace(/^@+/, '').toLowerCase();
    const ttlArg = Number(args[1] || 0);
    const gen = ctx.generalCfg() || {};
    const lgCfg = gen.moderation && gen.moderation.linkGuard || {};
    const ttl = ttlArg > 0 ? ttlArg : Number(lgCfg.permitTtlSec || 120);

    if (!target) {
      await ctx.reply(ctx.render('{templates.usage}'), ev.messageId);
      return true;
    }

    // No API call needed - just grant locally
    grantPermit(target, ttl);

    // Announce success (reply to invoker)
    const rendered = ctx.render('{templates.ok}', { login: target, ttl });
    await ctx.reply(rendered, ev.messageId);
    return true;
  }
};
