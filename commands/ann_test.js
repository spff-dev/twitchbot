module.exports = {
  name: 'ann_test',
  aliases: ['atest'],
  description: 'Post a test announcement',
  permission: 'broadcaster',
  cooldownSec: 10,
  async run(ctx) {
    const token = ctx.getToken();
    const clientId = process.env.TWITCH_CLIENT_ID;
    const API = 'https://api.twitch.tv/helix';

    // who am I (bot/mod id)?
    const me = await (await fetch(`${API}/users`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId }
    })).json();
    const moderator_id = me?.data?.[0]?.id;

    // broadcaster id from channel name
    const login = ctx.channel.replace(/^#/, '').toLowerCase();
    const u = await (await fetch(`${API}/users?login=${login}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId }
    })).json();
    const broadcaster_id = u?.data?.[0]?.id;

    const params = `?broadcaster_id=${broadcaster_id}&moderator_id=${moderator_id}`;
    const body = JSON.stringify({ message: '✅ Announcement test from SpiffyOS', color: 'primary' });
    const res = await fetch(`${API}/chat/announcements${params}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
      body
    });

    if (res.status !== 204) {
      const text = await res.text().catch(() => '');
      return ctx.reply(`announcement failed (${res.status})`);
    }
  }
};
