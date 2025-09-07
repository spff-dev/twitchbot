// Show stream uptime with a global 60s cooldown
let lastRunAt = 0;
const COOLDOWN_MS = 60_000;

module.exports = {
  name: 'uptime',
  description: 'Show how long the stream has been live (global 60s cooldown)',
  permission: 'everyone',
  cooldownSec: 0, // we implement a global cooldown ourselves
  async run(ctx) {
    const now = Date.now();
    const left = COOLDOWN_MS - (now - lastRunAt);
    if (left > 0) {
      // keep it low-noise: only tell the caller, not the whole chat
      const secs = Math.ceil(left / 1000);
      return ctx.reply(`uptime is on cooldown (${secs}s)`);
    }

    const token = ctx.getToken();
    const clientId = process.env.TWITCH_CLIENT_ID;
    const login = ctx.channel.replace(/^#/, '').toLowerCase();

    // Get stream status
    const res = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(login)}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId }
    });
    if (!res.ok) { return ctx.reply(`can't read uptime right now (${res.status})`); }
    const data = await res.json();
    const s = data?.data?.[0];

    if (!s) { lastRunAt = now; return ctx.say('Uptime: offline'); }

    const start = new Date(s.started_at).getTime();
    const durMs = Math.max(0, now - start);
    const h = Math.floor(durMs / 3600000);
    const m = Math.floor((durMs % 3600000) / 60000);
    const out = h > 0 ? `${h}h ${m}m` : `${m}m`;
    lastRunAt = now;
    return ctx.say(`Uptime: ${out}`);
  }
};
