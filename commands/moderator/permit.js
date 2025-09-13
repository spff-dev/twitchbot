'use strict';

const linkguard = require('../../src/moderation/linkguard');

function parseTtlSec(raw, fallback) {
  const s = String(raw || '').trim();
  if (!s) return fallback;
  const m = s.match(/^(\d+)\s*(s|m|h)?$/i);
  if (!m) return fallback;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 's').toLowerCase();
  const mult = unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return Math.max(1, Math.min(n * mult, 3600)); // cap at 1h
}

module.exports = {
  schemaVersion: 3,
  manifest: {
    name: 'permit',
    kind: 'module',
    category: 'moderator',

    // Defaults the loader merges into config/bot-commands-config.json
    defaults: {
      aliases: [],
      roles: ['mod', 'owner'],
      cooldownSeconds: 0,
      limitPerUser: 0,
      limitPerStream: 0,
      replyToUser: false,
      // Router will render this using returned vars
      response: '✅ @{target} you have a permit for {ttl}s to post a link.',
      templates: {
        usage: 'Usage: !permit <user> [seconds]',
        ok:    '✅ @{target} you have a permit for {ttl}s to post a link.',
        noPerms: 'Mods only.',
        error: 'Error setting permit.'
      }
    },

    /**
     * execute(ctx, args, cfg)
     * - ctx.has: helix, getAppToken, getBroadcasterToken, getBotToken, clientId,
     *            broadcasterUserId, botUserId, generalCfg(), commandMeta(), user/channel info,
     *            isMod, isBroadcaster, say(), reply()
     * - args: array of tokens after the command name
     * - cfg:  merged command config (cfg.templates, cfg.response, etc)
     */
    async execute(ctx, args, cfg) {
      const T = (cfg && cfg.templates) || {};
      // Only mods/owner can grant permits (router also enforces roles)
      if (!(ctx.isMod || ctx.isBroadcaster)) {
        return { vars: { out: String(T.noPerms || 'Mods only.') }, reply: true, suppress: false };
      }

      const targetRaw = (args[0] || '').trim().replace(/^@/, '');
      if (!targetRaw) {
        return { vars: { out: String(T.usage || 'Usage: !permit <user> [seconds]') }, reply: true };
      }
      const target = targetRaw.toLowerCase();

      // Default TTL from general config, fallback 120s
      const g = (ctx.generalCfg && ctx.generalCfg()) || {};
      const lgCfg = (g.moderation && g.moderation.linkGuard) || {};
      const defTtl = Number(lgCfg.permitTtlSec || 120);

      const ttlSec = parseTtlSec(args[1], defTtl);

      try {
        // Tell linkguard to allow this user for ttlSec
        if (typeof linkguard.setPermit === 'function') {
          linkguard.setPermit(target, ttlSec);
        }

        // Return tokens router will inject into cfg.response
        const out = String(T.ok || cfg.response || '✅ @{target} you have a permit for {ttl}s to post a link.')
          .replace('{ttl}', String(ttlSec))
          .replace('{target}', target);

        return {
          vars: { ttl: ttlSec, target, out },
          reply: false // send as normal chat (not threaded)
        };
      } catch (e) {
        const out = String(T.error || 'Error setting permit.');
        return { vars: { out }, reply: true };
      }
    }
  }
};
