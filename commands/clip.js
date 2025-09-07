// Create a clip (global 30s cooldown). Anyone can trigger.
// Replies: "Here's the clip -> https://clips.twitch.tv/<ID>"
let lastRunAt = 0;
const COOLDOWN_MS = 30_000;

async function getBroadcasterAccessToken() {
  const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, BROADCASTER_REFRESH_TOKEN } = process.env;
  if (!BROADCASTER_REFRESH_TOKEN) throw new Error('Missing BROADCASTER_REFRESH_TOKEN');
  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: BROADCASTER_REFRESH_TOKEN
  });
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!res.ok) throw new Error(`broadcaster token error ${res.status}`);
  const j = await res.json();
  return j.access_token;
}

module.exports = {
  name: 'clip',
  description: 'Create a clip (global 30s cooldown)',
  permission: 'everyone',
  cooldownSec: 0, // global cooldown handled here
  async run(ctx) {
    const now = Date.now();
    const left = COOLDOWN_MS - (now - lastRunAt);
    if (left > 0) {
      return ctx.reply(`- !clip is on cooldown (${Math.ceil(left / 1000)}s)`);
    }

    const clientId = process.env.TWITCH_CLIENT_ID;
    const bTok = await getBroadcasterAccessToken();
    const login = ctx.channel.replace(/^#/, '').toLowerCase();

    // Resolve broadcaster id
    const uRes = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
      headers: { Authorization: `Bearer ${bTok}`, 'Client-Id': clientId }
    });
    if (!uRes.ok) return ctx.reply(`- can't clip right now (${uRes.status})`);
    const u = await uRes.json();
    const broadcaster_id = u?.data?.[0]?.id;
    if (!broadcaster_id) return ctx.reply('- cannot resolve channel');

    // Must be live
    const sRes = await fetch(`https://api.twitch.tv/helix/streams?user_id=${broadcaster_id}`, {
      headers: { Authorization: `Bearer ${bTok}`, 'Client-Id': clientId }
    });
    if (!sRes.ok) return ctx.reply(`- can't read stream state (${sRes.status})`);
    const s = await sRes.json();
    if (!s?.data?.[0]) { lastRunAt = now; return ctx.reply("- you can't clip while the channel is offline."); }

    // Create the clip
    const cRes = await fetch(`https://api.twitch.tv/helix/clips?broadcaster_id=${broadcaster_id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bTok}`, 'Client-Id': clientId }
    });

    if (cRes.status === 429) return ctx.reply('- clip rate-limited; try again soon.');
    if (cRes.status !== 202) {
      const t = await cRes.text().catch(() => '');
      return ctx.reply(`- sorry, clip failed (${cRes.status})`);
    }

    const c = await cRes.json().catch(() => null);
    const id = c?.data?.[0]?.id;
    if (!id) return ctx.reply('- clip created, but no ID returned.');

    lastRunAt = now;
    // Give Twitch a tiny moment to make the clip page available
    await new Promise(r => setTimeout(r, 2000));

    return ctx.reply(`Here's the clip -> https://clips.twitch.tv/${id}`);
  }
};
