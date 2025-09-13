'use strict';

const linkguard = require('../../src/moderation/linkguard');

module.exports = {
  schemaVersion: 1,
  name: 'permit',
  kind: 'module',
  category: 'moderator',

  // JSON Schema so your loader can validate/seed defaults
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      aliases: { type: 'array', items: { type: 'string' }, default: [] },
      roles: {
        type: 'array',
        items: { type: 'string', enum: ['everyone','vip','mod','owner','broadcaster'] },
        default: ['mod','owner']
      },
      cooldownSeconds: { type: 'integer', minimum: 0, default: 2 },
      limitPerUser: { type: 'integer', minimum: 0, default: 0 },
      limitPerStream: { type: 'integer', minimum: 0, default: 0 },
      replyToUser: { type: 'boolean', default: true },
      failSilently: { type: 'boolean', default: false },
      response: { type: 'string', default: 'Permitted {target} to post links for {ttl}s.' },
      templates: {
        type: 'object',
        additionalProperties: false,
        properties: {
          usage:    { type: 'string', default: 'Usage: !permit <user> [seconds]' },
          notFound: { type: 'string', default: 'Unknown user: {target}' },
          done:     { type: 'string', default: 'Permitted {target} for {ttl}s.' },
          error:    { type: 'string', default: 'permit error: {reason}' }
        },
        default: {}
      }
    }
  },

  // Defaults your loader will merge/seed into bot-commands-config.json
  defaults: {
    aliases: [],
    roles: ['mod','owner'],
    cooldownSeconds: 2,
    limitPerUser: 0,
    limitPerStream: 0,
    replyToUser: true,
    failSilently: false,
    response: 'Permitted {target} to post links for {ttl}s.',
    templates: {
      usage: 'Usage: !permit <user> [seconds]',
      notFound: 'Unknown user: {target}',
      done: 'Permitted {target} for {ttl}s.',
      error: 'permit error: {reason}'
    }
  },

  /**
   * run(ctx, args)
   *   - resolve target via Helix /users
   *   - ttl = arg2 or general.moderation.linkGuard.permitTtlSec (fallback 180)
   *   - store permit; reply using config response
   */
  run: async (ctx, args) => {
    try {
      if (!(ctx.isMod || ctx.isBroadcaster)) return false;

      const meta = (ctx.commandMeta && ctx.commandMeta('permit')) || {};
      const cfgGen = (ctx.generalCfg && ctx.generalCfg()) || {};
      const lg = (cfgGen.moderation && cfgGen.moderation.linkGuard) || {};
      const usage = (meta.templates && meta.templates.usage) || 'Usage: !permit <user> [seconds]';

      const raw = (args && args[0]) || '';
      let target = String(raw).trim().replace(/^@+/, '');
      if (!target) { await ctx.reply(usage); return true; }

      let ttl = Number(args && args[1]) || Number(lg.permitTtlSec || 180);
      if (!Number.isFinite(ttl) || ttl <= 0) ttl = Number(lg.permitTtlSec || 180);

      // resolve user
      const appTok = await ctx.getAppToken();
      const res = await ctx.helix(`/users?login=${encodeURIComponent(target)}`, { method: 'GET', token: appTok });
      const j = await res.json().catch(() => ({}));
      const user = j && j.data && j.data[0];
      if (!user) {
        const nf = (meta.templates && meta.templates.notFound) || 'Unknown user: {target}';
        await ctx.reply(nf.replace(/\{target\}/g, target));
        return true;
      }

      // store permit
      linkguard.addPermit({ userId: user.id, login: user.login, ttlSec: ttl, grantedBy: ctx.user && ctx.user.id });

      // respond from config
      const tmpl = String(meta.response || (meta.templates && meta.templates.done) || 'Permitted {target} for {ttl}s.');
      const out = tmpl.replace(/\{target\}/g, user.login).replace(/\{ttl\}/g, String(ttl));
      if (meta.replyToUser) await ctx.reply(out); else await ctx.say(out);

      return true;
    } catch (e) {
      const meta = (ctx.commandMeta && ctx.commandMeta('permit')) || {};
      const tpl = (meta.templates && meta.templates.error) || 'permit error.';
      const out = tpl.replace(/\{reason\}/g, e.message || 'unknown');
      try { await ctx.reply(out); } catch {}
      return true;
    }
  }
};
