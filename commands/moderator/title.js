'use strict';
const define = require('../../src/core/define-command');

module.exports = define({
  name: 'title',
  category: 'moderator',
  schemaVersion: 1,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      response: { type: 'string', default: '{out}' },
      templates: {
        type: 'object', additionalProperties: false,
        properties: {
          usage:   { type: 'string', default: 'Usage: !title [new title]' },
          show:    { type: 'string', default: 'Title: {title}' },
          updated: { type: 'string', default: 'Title updated to: {title}' },
          noChange:{ type: 'string', default: 'Title already: {title}' },
          noPerms: { type: 'string', default: 'Mods only.' },
          error:   { type: 'string', default: 'Error updating title.' }
        },
        default: {}
      },
      cooldownSeconds: { type: 'integer', minimum: 0, default: 5 },
      replyToUser: { type: 'boolean', default: true }
    },
    required: ['response']
  },
  defaults: {
    roles: ['everyone'],     // everyone can view; set path requires mod/broadcaster (checked in execute)
    limitPerUser: 0,
    limitPerStream: 0
  },

  async execute(ctx, args, cfg) {
    const T = cfg.templates || {};
    const bcId = ctx.channel.id;

    // SHOW
    if (!args || args.length === 0) {
      try {
        const tok = await ctx.getAppToken();
        const r = await ctx.helix(`/channels?broadcaster_id=${bcId}`, { method: 'GET', token: tok });
        const j = await r.json();
        const ch = j && j.data && j.data[0];
        const title = (ch && ch.title) || 'None';
        return { vars: { out: String(T.show||'Title: {title}').replace('{title}', title) }, reply: true };
      } catch {
        return { vars: { out: 'Title: (unknown)' }, reply: true };
      }
    }

    // SET requires mod/owner
    if (!(ctx.isMod || ctx.isBroadcaster)) {
      return { vars: { out: String(T.noPerms||'Mods only.') }, reply: true, suppress: false };
    }

    const newTitle = args.join(' ').trim();
    if (!newTitle) {
      return { vars: { out: String(T.usage||'Usage: !title [new title]') }, reply: true };
    }

    try {
      const tok = await ctx.getBroadcasterToken();
      // avoid no-op: fetch current
      const cr = await ctx.getAppToken().then(appTok => ctx.helix(`/channels?broadcaster_id=${bcId}`, { method: 'GET', token: appTok }));
      const cj = await cr.json(); const cur = cj && cj.data && cj.data[0] && cj.data[0].title || '';
      if (cur === newTitle) {
        return { vars: { out: String(T.noChange||'Title already: {title}').replace('{title}', cur) }, reply: false };
      }

      const pr = await ctx.helix(`/channels?broadcaster_id=${bcId}`, { method: 'PATCH', token: tok, json: { title: newTitle } });
      if (!pr.ok) throw new Error(`patch ${pr.status}`);
      return { vars: { out: String(T.updated||'Title updated to: {title}').replace('{title}', newTitle) }, reply: false };
    } catch {
      return { vars: { out: String(T.error||'Error updating title.') }, reply: true };
    }
  }
});
