'use strict';

/**
 * !game
 * - No args: show current category (reply to invoker).
 * - With args: set category (mods/broadcaster only). On change: broadcast to chat.
 *
 * Config keys (seeded below):
 *   roles: ['everyone']                // everyone can *view*
 *   cooldownSeconds: 5
 *   limitPerUser / limitPerStream: 0
 *   replyToUser: true                  // used for the view case; set case overrides to broadcast
 *   response: "Game: {game}"           // view (no-arg) template
 *   templates:
 *     usage: "Usage: !game <category>"
 *     notFound: "Could not find category: {query}"
 *     forbidden: "Mods only."
 *     same: "Game is already {game}."
 *     changed: "Game set to {game}"
 */

module.exports = {
  schemaVersion: 1,
  name: 'game',
  category: 'moderator',
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      response:        { type: 'string',  default: 'Game: {game}' },
      roles:           { type: 'array',   items: { type: 'string' }, default: ['everyone'] },
      cooldownSeconds: { type: 'integer', minimum: 0, default: 5 },
      limitPerUser:    { type: 'integer', minimum: 0, default: 0 },
      limitPerStream:  { type: 'integer', minimum: 0, default: 0 },
      replyToUser:     { type: 'boolean', default: true },
      failSilently:    { type: 'boolean', default: true },
      aliases:         { type: 'array',   items: { type: 'string' } },
      templates: {
        type: 'object',
        additionalProperties: true,
        properties: {
          usage:     { type: 'string', default: 'Usage: !game <category>' },
          notFound:  { type: 'string', default: 'Could not find category: {query}' },
          forbidden: { type: 'string', default: 'Mods only.' },
          same:      { type: 'string', default: 'Game is already {game}.' },
          changed:   { type: 'string', default: 'Game set to {game}' }
        }
      }
    }
  },
  defaults: {
    response: 'Game: {game}',
    roles: ['everyone'],
    cooldownSeconds: 5,
    replyToUser: true
  },

  async execute(ctx, args, cfg) {
    // helpers
    async function getJSON(res) {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (body && body.message) ? body.message : `status ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return body;
    }

    async function currentGameName() {
      const tok = await ctx.getAppToken();
      const j = await ctx.helix(`/channels?broadcaster_id=${ctx.channel.id}`, { method: 'GET', token: tok }).then(getJSON);
      const row = Array.isArray(j.data) && j.data[0] ? j.data[0] : null;
      return row && row.game_name ? String(row.game_name) : '';
    }

    // No-arg -> show
    if (!args || args.length === 0) {
      const game = (await currentGameName()) || 'Unknown';
      return {
        vars: { game },
        // use configured response (replyToUser default true)
      };
    }

    // With-arg -> set (mods/broadcaster only)
    if (!(ctx.isMod || ctx.isBroadcaster)) {
      const out = String(cfg.templates?.forbidden || 'Mods only.');
      return { vars: { out }, template: '{out}', reply: true };
    }

    const query = args.join(' ').trim();
    if (!query) {
      const out = String(cfg.templates?.usage || 'Usage: !game <category>');
      return { vars: { out }, template: '{out}', reply: true };
    }

    // Resolve category -> id + canonical name
    const appTok = await ctx.getAppToken();
    const search = await ctx.helix(`/search/categories?query=${encodeURIComponent(query)}`, { method: 'GET', token: appTok }).then(getJSON);
    const list = Array.isArray(search.data) ? search.data : [];

    // prefer case-insensitive exact, else first result
    let target = null;
    const qLc = query.toLowerCase();
    target = list.find(x => String(x.name || '').toLowerCase() === qLc) || list[0] || null;

    if (!target || !target.id) {
      const out = String(cfg.templates?.notFound || 'Could not find category: {query}');
      return { vars: { query }, template: out.includes('{query}') ? out : '{out}', message: out.replace('{query}', query), reply: true };
    }

    const newId   = String(target.id);
    const newName = String(target.name || query);

    // If same as current -> reply same
    const prev = await currentGameName();
    if (prev && prev.toLowerCase() === newName.toLowerCase()) {
      const tpl = String(cfg.templates?.same || 'Game is already {game}.');
      return { vars: { game: newName }, template: tpl, reply: true };
    }

    // PATCH channel
    try {
      const bcTok = await ctx.getBroadcasterToken();
      const res = await ctx.helix(`/channels?broadcaster_id=${ctx.channel.id}`, {
        method: 'PATCH',
        token: bcTok,
        json: { game_id: newId }
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`update failed: ${res.status} ${txt}`);
      }
    } catch (e) {
      const msg = e && e.message ? e.message : 'update failed';
      const out = `Could not update game (${msg}).`;
      return { vars: { out }, template: '{out}', reply: true };
    }

    // Success: broadcast (not a reply)
    const tpl = String(cfg.templates?.changed || 'Game set to {game}');
    return { vars: { game: newName }, template: tpl, reply: false };
  }
};
