const { getTemplates, format } = require('../lib/config');
function tierLabel(t) {
  const v = String(t || '1000');
  if (v === '1' || v === '1000') return 'Tier 1';
  if (v === '2' || v === '2000') return 'Tier 2';
  if (v === '3' || v === '3000') return 'Tier 3';
  return 'Tier 1';
}
module.exports = {
  name: 'test_gift',
  aliases: ['tgift'],
  description: 'Simulate a gift sub announcement. Usage: !test_gift [count] [tier] [gifter] [anon:true|false]',
  permission: 'broadcaster',
  cooldownSec: 5,
  async run(ctx) {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const token = ctx.getToken();
    const API = 'https://api.twitch.tv/helix';
    const tpls = getTemplates();

    const count = Math.max(1, parseInt(ctx.args[0], 10) || 5);
    const tier = tierLabel(ctx.args[1]);
    const gifter = ctx.args[2] || 'Someone';
    const anon = String(ctx.args[3] || '').toLowerCase() === 'true' ? 'Anonymous ' : '';

    const me = await (await fetch(`${API}/users`, { headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId } })).json();
    const moderator_id = me?.data?.[0]?.id;
    const login = ctx.channel.replace(/^#/, '').toLowerCase();
    const u = await (await fetch(`${API}/users?login=${login}`, { headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId } })).json();
    const broadcaster_id = u?.data?.[0]?.id;

    const message = format(tpls.gift, { ANON: anon, GIFTER: gifter, COUNT: count, TIER: tier, S: count > 1 ? 's' : '' });
    const params = `?broadcaster_id=${broadcaster_id}&moderator_id=${moderator_id}`;
    const res = await fetch(`${API}/chat/announcements${params}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, color: 'primary' })
    });
    if (res.status !== 204) ctx.reply(`gift test failed (${res.status})`);
  }
};
