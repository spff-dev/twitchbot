const { getTemplates, format } = require('../lib/config');
module.exports = {
  name: 'test_bits',
  aliases: ['tbits'],
  description: 'Simulate a bits cheer announcement. Usage: !test_bits [amount] [name]',
  permission: 'broadcaster',
  cooldownSec: 5,
  async run(ctx) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const token = ctx.getToken();
    const API = 'https://api.twitch.tv/helix';
    const tpls = getTemplates();

    const amount = Math.max(1, parseInt(ctx.args[0], 10) || 50);
    const who = ctx.args[1] || 'Someone';

    const me = await (await fetch(`${API}/users`, { headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId } })).json();
    const moderator_id = me?.data?.[0]?.id;
    const login = ctx.channel.replace(/^#/, '').toLowerCase();
    const u = await (await fetch(`${API}/users?login=${login}`, { headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId } })).json();
    const broadcaster_id = u?.data?.[0]?.id;

    const message = format(tpls.bits, { USER: who, BITS: amount });
    const params = `?broadcaster_id=${broadcaster_id}&moderator_id=${moderator_id}`;
    const res = await fetch(`${API}/chat/announcements${params}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, color: 'primary' })
    });
    if (res.status !== 204) ctx.reply(`bits test failed (${res.status})`);
  }
};
