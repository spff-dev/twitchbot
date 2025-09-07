// View/set the stream's category. Anyone can view; mods+broadcaster can set (fuzzy match).
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
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  if (!res.ok) throw new Error(`broadcaster token error ${res.status}`);
  const j = await res.json();
  return j.access_token;
}

function isBroadcaster(tags) { const b = tags.badges || {}; return b && b.broadcaster === '1'; }
function isMod(tags) { return !!tags.mod || isBroadcaster(tags); }

module.exports = {
  name: 'game',
  description: 'Show or set the stream category. Usage: !game | !game "<category>"',
  permission: 'everyone',
  cooldownSec: 0,
  async run(ctx) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const channelLogin = ctx.channel.replace(/^#/, '').toLowerCase();
    const wantsSet = ctx.args.length > 0;

    // Read-only: show current category (use broadcaster token to avoid edge auth quirks)
    if (!wantsSet) {
      const bTok = await getBroadcasterAccessToken();
      const u = await (await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channelLogin)}`, {
        headers: { 'Authorization': `Bearer ${bTok}`, 'Client-Id': clientId }
      })).json();
      const broadcaster_id = u?.data?.[0]?.id;
      if (!broadcaster_id) return ctx.replyThread('❌ Cannot resolve channel');

      const ch = await (await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${broadcaster_id}`, {
        headers: { 'Authorization': `Bearer ${bTok}`, 'Client-Id': clientId }
      })).json();
      const name = ch?.data?.[0]?.game_name || 'Unknown';
      return ctx.say(`Category: ${name}`);
    }

    // Set flow: only mods + broadcaster
    if (!isMod(ctx.tags)) return; // silently ignore for non-mods

    // Fuzzy match via search/categories (pick top hit)
    const raw = ctx.args.join(' ').trim().replace(/^["']|["']$/g, '');
    if (!raw) return ctx.replyThreaded('ℹ️ Usage: !game "<category>"');

    const bTok = await getBroadcasterAccessToken();
    const search = await (await fetch(`https://api.twitch.tv/helix/search/categories?query=${encodeURIComponent(raw)}&first=1`, {
      headers: { 'Authorization': `Bearer ${bTok}`, 'Client-Id': clientId }
    })).json();
    const hit = search?.data?.[0];
    if (!hit) return ctx.replyThreaded(`❌ No category found for "${raw}"`);

    // Resolve broadcaster id
    const u = await (await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channelLogin)}`, {
      headers: { 'Authorization': `Bearer ${bTok}`, 'Client-Id': clientId }
    })).json();
    const broadcaster_id = u?.data?.[0]?.id;
    if (!broadcaster_id) return ctx.replyThreaded('❌ Cannot resolve channel');

    // PATCH channel info with new game_id
    const res = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${broadcaster_id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${bTok}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ game_id: hit.id })
    });

    if (res.status !== 204) return ctx.replyThreaded(`❌ Category update failed (${res.status})`);
    return ctx.say(`✅ Category updated → ${hit.name}`);
  }
};
