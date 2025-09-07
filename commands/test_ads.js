// Simulate an ad starting now for N seconds by posting the same announcements.
// Mod/broadcaster only, to avoid spam. Usage: !test_ads [seconds]  (default 30, 5-180 clamp)
function isBroadcaster(tags) { const b = tags.badges || {}; return b && b.broadcaster === '1'; }
function isMod(tags) { return !!tags.mod || isBroadcaster(tags); }

module.exports = {
  name: 'test_ads',
  description: 'Simulate an ad start/end announcement. Usage: !test_ads [seconds]',
  permission: 'mod',
  cooldownSec: 5,
  async run(ctx) {
    if (!isMod(ctx.tags)) return; // mods + broadcaster only

    const secs = Math.max(5, Math.min(180, parseInt(ctx.args[0], 10) || 30));
    const clientId = process.env.TWITCH_CLIENT_ID;
    const token = ctx.getToken(); // bot token (has moderator:manage:announcements)
    const login = ctx.channel.replace(/^#/, '').toLowerCase();

    // resolve moderator_id (bot) and broadcaster_id
    const me = await (await fetch('https://api.twitch.tv/helix/users', {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId }
    })).json();
    const moderator_id = me?.data?.[0]?.id;

    const u = await (await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId }
    })).json();
    const broadcaster_id = u?.data?.[0]?.id;

    if (!moderator_id || !broadcaster_id) return ctx.reply('announcement IDs not resolved.');

    const post = async (message) => {
      const res = await fetch(`https://api.twitch.tv/helix/chat/announcements?broadcaster_id=${broadcaster_id}&moderator_id=${moderator_id}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Client-Id': clientId,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message, color: 'primary' })
      });
      return res.status === 204;
    };

    // Start banner (matches your live copy)
    await post(`📣 ${secs} seconds of ads have started, thanks for sticking around`);
    setTimeout(() => {
      post(`✅ Ads are over, welcome back - you didn't miss anything`).catch(() => {});
    }, secs * 1000);
  }
};
