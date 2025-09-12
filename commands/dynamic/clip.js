'use strict';

// !clip - creates a clip for the current live stream and replies with the URL
// Strict offline guard: never attempts Create Clip unless /streams confirms `type: "live"`.
//
// Requirements: Broadcaster user token with scope `clips:edit`.
// Config keys:
//   response         : template with {url} and {id}  (default "Here's your clip! --> {url}")
//   roles            : ['everyone'] by default (tune as you like)
//   cooldownSeconds  : 15
//   limitPerUser     : 2
//   limitPerStream   : 0
//   replyToUser      : true
//   failSilently     : false
//   templates.offline: "I can only clip while we're live."
//   templates.error  : "Sorry, I couldn't create a clip right now."

module.exports = {
  schemaVersion: 1,
  name: 'clip',
  category: 'dynamic',
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      response:        { type: 'string',  default: "Here's your clip! --> {url}" },
      roles:           { type: 'array',   items: { type: 'string' }, default: ['everyone'] },
      cooldownSeconds: { type: 'integer', minimum: 0, default: 15 },
      limitPerUser:    { type: 'integer', minimum: 0, default: 2 },
      limitPerStream:  { type: 'integer', minimum: 0, default: 0 },
      replyToUser:     { type: 'boolean', default: true },
      failSilently:    { type: 'boolean', default: false },
      templates: {
        type: 'object',
        additionalProperties: true,
        properties: {
          offline: { type: 'string', default: "I can only clip while we're live." },
          error:   { type: 'string', default: "Sorry, I couldn't create a clip right now." }
        }
      }
    }
  },
  defaults: {
    response: "Here's your clip! --> {url}",
    roles: ['everyone'],
    cooldownSeconds: 15,
    limitPerUser: 2,
    replyToUser: true,
    failSilently: false
  },

  async execute(ctx, _args, cfg) {
    const offlineMsg = String(cfg.templates?.offline || "I can only clip while we're live.");
    const errorMsg   = String(cfg.templates?.error   || "Sorry, I couldn't create a clip right now.");

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

    // 1) Strict live check - stop immediately if not confirmed live
    try {
      const appTok = await ctx.getAppToken();
      const j = await ctx.helix(`/streams?user_id=${ctx.channel.id}`, { method: 'GET', token: appTok }).then(getJSON);
      const row = Array.isArray(j.data) && j.data[0] ? j.data[0] : null;
      const isLive = !!(row && String(row.type || '').toLowerCase() === 'live');
      if (!isLive) {
        if (cfg.failSilently) return { vars: {}, suppress: true };
        return { vars: { out: offlineMsg }, template: '{out}', reply: true };
      }
    } catch (e) {
      if (cfg.failSilently) return { vars: {}, suppress: true };
      return { vars: { out: offlineMsg }, template: '{out}', reply: true };
    }

    // 2) Create clip using broadcaster token (requires `clips:edit`)
    try {
      const bcTok = await ctx.getBroadcasterToken();
      const res = await ctx.helix(`/clips?broadcaster_id=${ctx.channel.id}`, {
        method: 'POST',
        token: bcTok
      });
      const j = await getJSON(res);
      const id = j && j.data && j.data[0] && j.data[0].id;
      if (!id) throw new Error('No clip id returned');

      const url = `https://clips.twitch.tv/${id}`;
      // Success → use configured success template (router will render it)
      return { vars: { id, url }, reply: !!cfg.replyToUser };
    } catch (e) {
      if (cfg.failSilently) return { vars: {}, suppress: true };
      return { vars: { out: errorMsg }, template: '{out}', reply: true };
    }
  }
};
