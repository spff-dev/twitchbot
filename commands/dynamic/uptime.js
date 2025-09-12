'use strict';
const define = require('../../src/core/define-command');

module.exports = define({
  name: 'uptime',
  category: 'dynamic',
  schemaVersion: 1,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      response: { type: 'string', default: 'Uptime: {uptimeText}' },
      templates: {
        type: 'object', additionalProperties: false,
        properties: {
          offline:     { type: 'string', default: 'offline' },
          onlineShort: { type: 'string', default: '{m}m' },
          onlineLong:  { type: 'string', default: '{h}h {m}m' }
        },
        default: {}
      },
      cooldownSeconds: { type: 'integer', minimum: 0, default: 60 },
      replyToUser: { type: 'boolean', default: true }
    },
    required: ['response']
  },
  defaults: {
    roles: ['everyone'],
    limitPerUser: 0,
    limitPerStream: 0
  },

  async execute(ctx, args, cfg) {
    try {
      const tok = await ctx.getAppToken();
      const r = await ctx.helix(`/streams?user_id=${ctx.channel.id}`, { method: 'GET', token: tok });
      if (!r.ok) throw new Error(`helix ${r.status}`);
      const j = await r.json();
      const live = Array.isArray(j.data) && j.data[0];
      if (!live) return { vars: { uptimeText: cfg.templates.offline || 'offline' }, reply: true };

      const start = new Date(live.started_at).getTime();
      const now = Date.now();
      const dur = Math.max(0, now - start);
      const h = Math.floor(dur / 3600000);
      const m = Math.floor((dur % 3600000) / 60000);
      const text = h > 0
        ? String(cfg.templates.onlineLong || '{h}h {m}m').replace('{h}', h).replace('{m}', m)
        : String(cfg.templates.onlineShort || '{m}m').replace('{m}', m);

      return { vars: { uptimeText: text }, reply: true };
    } catch (e) {
      return { vars: { uptimeText: 'offline' }, reply: true };
    }
  }
});
