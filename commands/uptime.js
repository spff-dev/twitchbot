'use strict';

// Show stream uptime with a global 60s cooldown

let lastRunAt = 0;
const COOLDOWN_MS = 60000;

async function asJSON(res) {
  const txt = await res.text().catch(() => '');
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch {}
  return { ok: res.ok, status: res.status, json: j, text: txt };
}

module.exports = {
  name: 'uptime',
  description: 'Show how long the stream has been live (global 60s cooldown)',
  permission: 'everyone',
  cooldownSec: 0,
  async run(ctx) {
    const now = Date.now();
    const left = COOLDOWN_MS - (now - lastRunAt);
    if (left > 0) {
      return; // silent cooldown
    }

    try {
      const bcId = ctx.channel.id;

      // Read stream state with app token
      const appTok = await ctx.getAppToken();
      const sRes = await ctx.helix(`/streams?user_id=${bcId}`, { method: 'GET', token: appTok });
      const s = await asJSON(sRes);
      if (!s.ok) {
        lastRunAt = now;
        console.error('[UPTIME] http', s.status, s.text || '');
        return; // silent error
      }

      const live = s.json && s.json.data && s.json.data[0];
      if (!live) {
        lastRunAt = now;
        return ctx.say('Uptime: offline');
      }

      const start = new Date(live.started_at).getTime();
      const durMs = Math.max(0, now - start);
      const h = Math.floor(durMs / 3600000);
      const m = Math.floor((durMs % 3600000) / 60000);
      const out = h > 0 ? `${h}h ${m}m` : `${m}m`;

      lastRunAt = now;
      return ctx.say(`Uptime: ${out}`);
    } catch (e) {
      lastRunAt = now;
      console.error('[UPTIME] error', e && e.message ? e.message : e);
      return; // silent error
    }
  }
};
