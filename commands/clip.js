'use strict';

// Create a clip with a global 30s cooldown. Anyone can trigger.
// Replies with the clip URL when successful, or a clear reason otherwise.

let lastRunAt = 0;
const COOLDOWN_MS = 30000;

async function asJSON(res) {
  const txt = await res.text().catch(() => '');
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch {}
  return { ok: res.ok, status: res.status, json: j, text: txt };
}

module.exports = {
  name: 'clip',
  description: 'Create a clip (global 30s cooldown)',
  permission: 'everyone',
  cooldownSec: 0,
  async run(ctx) {
    const now = Date.now();
    const left = COOLDOWN_MS - (now - lastRunAt);
    if (left > 0) {
      const secs = Math.ceil(left / 1000);
      return ctx.replyThread(`clip is on cooldown (${secs}s)`);
    }

    try {
      const bcId = ctx.channel.id;

      // Check live state with app token
      const appTok = await ctx.getAppToken();
      const sRes = await ctx.helix(`/streams?user_id=${bcId}`, { method: 'GET', token: appTok });
      const s = await asJSON(sRes);
      if (!s.ok) {
        lastRunAt = now;
        return ctx.replyThread(`cannot read stream state (${s.status})`);
      }
      const live = s.json && s.json.data && s.json.data[0];
      if (!live) {
        lastRunAt = now;
        return ctx.replyThread('you cannot clip while the channel is offline');
      }

      // Create the clip with the broadcaster token
      const bcTok = await ctx.getBroadcasterToken();
      const cRes = await ctx.helix(`/clips?broadcaster_id=${bcId}`, { method: 'POST', token: bcTok });
      const c = await asJSON(cRes);

      if (c.status === 429) {
        lastRunAt = now;
        return ctx.replyThread('clip is rate limited, try again soon');
      }
      if (c.status !== 202) {
        lastRunAt = now;
        return ctx.replyThread(`clip failed (${c.status})`);
      }

      // Twitch often returns the id payload even though status is 202
      const id = c.json && c.json.data && c.json.data[0] && c.json.data[0].id;
      lastRunAt = now;

      if (!id) {
        return ctx.replyThread('clip created, but no id was returned');
      }

      // small delay to let the clip page come up
      await new Promise(r => setTimeout(r, 1500));
      return ctx.replyThread(`here is your clip -> https://clips.twitch.tv/${id}`);
    } catch (e) {
      lastRunAt = now;
      return ctx.replyThread('clip failed');
    }
  }
};
