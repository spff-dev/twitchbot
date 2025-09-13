'use strict';

/**
 * Manifest command: !permit <user> [ttl]
 * Grants a temporary link-permit so linkguard will not delete that user's URLs.
 *
 * Router calls: entry.manifest.execute(ctx, args, meta)
 *  - ctx: { say(), reply(), user, channel, isMod, isBroadcaster, generalCfg() }
 *  - args: array of tokens after the command (or string); we handle both
 *  - meta: the merged command config from bot-commands-config.json
 */

const store = require('../../src/moderation/permit-store');

function toLogin(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^@+/, '');
  return s.toLowerCase();
}

function parseTTL(raw, fallbackSec) {
  if (!raw) return fallbackSec;
  const s = String(raw).trim().toLowerCase();
  const m = s.match(/^(\d+)\s*([smhd]?)$/);
  if (!m) return fallbackSec;
  const n = Number(m[1] || '0');
  const unit = m[2] || 's';
  if (!n) return fallbackSec;
  switch (unit) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default:  return fallbackSec;
  }
}

module.exports = {
  schemaVersion: 3,

  manifest: {
    name: 'permit',
    category: 'moderator',
    kind: 'module',

    // Defaults that seed/merge into config/bot-commands-config.json
    defaults: {
      aliases: [],
      roles: ['mod', 'owner'],       // router will gate for mods/broadcaster
      cooldownSeconds: 0,
      limitPerUser: 0,
      limitPerStream: 0,
      replyToUser: true,
      failSilently: true,
      // Keep response simple and under config control. We return {out}.
      response: '{out}',
      templates: {
        usage: 'Usage: !permit <user> [ttl]',
        ok: 'Permitted {target} for {seconds}s.',
        noPerms: 'Mods only.',
        invalid: 'Usage: !permit <user> [ttl]'
      }
    },

    // Used by your loader to compile/validate config shape
    configSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        aliases: { type: 'array', items: { type: 'string' } },
        roles:   { type: 'array', items: { type: 'string' } },
        cooldownSeconds: { type: 'integer', minimum: 0 },
        limitPerUser:    { type: 'integer', minimum: 0 },
        limitPerStream:  { type: 'integer', minimum: 0 },
        replyToUser:     { type: 'boolean' },
        failSilently:    { type: 'boolean' },
        response:        { type: 'string' },
        templates: {
          type: 'object',
          additionalProperties: false,
          properties: {
            usage:    { type: 'string' },
            ok:       { type: 'string' },
            noPerms:  { type: 'string' },
            invalid:  { type: 'string' }
          }
        }
      }
    },

    /**
     * Execute the command.
     * Return tokens for renderer: we always return { out } so "{out}" works by default.
     */
    async execute(ctx, args, meta) {
      const isPriv = !!(ctx.isMod || ctx.isBroadcaster);
      if (!isPriv) {
        const out = (meta.templates && meta.templates.noPerms) || 'Mods only.';
        return { out };
      }

      const parts = Array.isArray(args)
        ? args
        : String(args || '').trim().split(/\s+/).filter(Boolean);

      const targetLogin = toLogin(parts && parts[0]);
      if (!targetLogin) {
        const out = (meta.templates && meta.templates.usage) || 'Usage: !permit <user> [ttl]';
        return { out };
      }

      // TTL: arg[1] or fallback to general.cfg.moderation.linkGuard.permitTtlSec (default 180)
      const general = (typeof ctx.generalCfg === 'function') ? (ctx.generalCfg() || {}) : {};
      const fallbackSec = Number(
        general?.moderation?.linkGuard?.permitTtlSec ?? 180
      ) || 180;

      const seconds = parseTTL(parts[1], fallbackSec);

      // Channel-scoped grant
      const channelId = ctx?.channel?.id || '';
      store.grant(channelId, targetLogin, seconds);

      const out = ((meta.templates && meta.templates.ok) || 'Permitted {target} for {seconds}s.')
        .replace('{target}', targetLogin)
        .replace('{seconds}', String(seconds));

      return { out };
    }
  }
};
