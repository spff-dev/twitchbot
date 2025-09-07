// View/set the stream title. Anyone can view; mods+broadcaster can set.
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
  name: 'title',
  description: 'Show or set the stream title. Usage: !title | !title New Title Here',
  permission: 'everyone',
  cooldownSec: 0,
  async run(ctx) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const channelLogin = ctx.channel.replace(/^#/, '').toLowerCase();
    const wantsSet = ctx.args.length > 0;

    const bTok = await getBroadcasterAccessToken();
    // Resolve broadcaster id once
    const u = await (await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(channelLogin)}`, {
      headers: { 'Authorization': `Bearer ${bTok}`, 'Client-Id': clientId }
    })).json();
    const broadcaster_id = u?.data?.[0]?.id;
    if (!broadcaster_id) return ctx.reply('cannot resolve channel');

    if (!wantsSet) {
      const ch = await (await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${broadcaster_id}`, {
        headers: { 'Authorization': `Bearer ${bTok}`, 'Client-Id': clientId }
      })).json();
      const title = ch?.data?.[0]?.title || 'Untitled';
      return ctx.say(`Title: ${title}`);
    }

    if (!isMod(ctx.tags)) return; // only mods + broadcaster may change
    const newTitle = ctx.args.join(' ').trim();
    if (!newTitle) return ctx.reply('usage: !title New Stream Title');

    const res = await fetch(`https://api.twitch.tv/helix/channels?broadcaster_id=${broadcaster_id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${bTok}`,
        'Client-Id': clientId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title: newTitle })
    });

    if (res.status !== 204) return ctx.reply(`title update failed (${res.status})`);
    return ctx.say(`Title updated → ${newTitle}`);
  }
};
