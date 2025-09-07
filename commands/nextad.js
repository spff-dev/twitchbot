// Show the next scheduled ad time & duration using the broadcaster token.
// Output example: "30 seconds of ads are due in 120 seconds (at 9:05 PM BST)"
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

module.exports = {
  name: 'nextad',
  description: 'Show when the next ad is scheduled and its duration',
  permission: 'everyone',
  cooldownSec: 0,
  async run(ctx) {
    try {
      const clientId = process.env.TWITCH_CLIENT_ID;
      const bTok = await getBroadcasterAccessToken();
      const login = ctx.channel.replace(/^#/, '').toLowerCase();

      // resolve broadcaster id
      const u = await (await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
        headers: { Authorization: `Bearer ${bTok}`, 'Client-Id': clientId }
      })).json();
      const broadcaster_id = u?.data?.[0]?.id;
      if (!broadcaster_id) return ctx.reply('cannot resolve channel');

      // fetch ad schedule
      const sch = await (await fetch(`https://api.twitch.tv/helix/channels/ads?broadcaster_id=${broadcaster_id}`, {
        headers: { Authorization: `Bearer ${bTok}`, 'Client-Id': clientId }
      })).json();
      const row = sch?.data?.[0];
      const nextAt = row?.next_ad_at;
      const dur = Number(row?.duration || 0);

      if (!nextAt || !dur) return ctx.reply('No scheduled mid-roll ads.');

      const tNext = new Date(nextAt).getTime();
      const now = Date.now();
      const deltaSec = Math.max(0, Math.round((tNext - now) / 1000));

      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/London', hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short'
      });
      const parts = Object.fromEntries(fmt.formatToParts(new Date(tNext)).map(p => [p.type, p.value]));
      const when = `${parts.hour}:${parts.minute} ${parts.dayPeriod?.toUpperCase?.() || ''} ${parts.timeZoneName}`;

      return ctx.reply(`${
        dur
      } seconds of ads are due in ${
        deltaSec
      } seconds (at ${when})`);
    } catch (e) {
      console.error('[NEXTAD] error', e);
      return ctx.reply('Could not read the ad schedule.');
    }
  }
};
