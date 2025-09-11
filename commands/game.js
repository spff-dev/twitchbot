'use strict';

// Get or set stream game/category
// No args: show current game
// With args: search categories and set the first match

module.exports.name = 'game';

async function getJSON(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body && body.message ? body.message : `status ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

module.exports.run = async function game(ctx, args) {
  try {
    const bcId = ctx.channel.id;

    if (!args || args.length === 0) {
      const tok = await ctx.getAppToken();
      const res = await ctx.helix(`/channels?broadcaster_id=${bcId}`, { method: 'GET', token: tok });
      const js = await getJSON(res);
      const row = js.data && js.data[0];
      const g = row && row.game_name ? row.game_name : '(none)';
      await ctx.reply(`Game: ${g}`);
      return;
    }

    if (!(ctx.isMod || ctx.isBroadcaster)) {
      return;
    }

    const q = String(args.join(' ')).trim();
    const tok = await ctx.getAppToken();
    const sres = await ctx.helix(`/search/categories?query=${encodeURIComponent(q)}`, { method: 'GET', token: tok });
    const sjs = await getJSON(sres);
    const list = Array.isArray(sjs.data) ? sjs.data : [];
    if (list.length === 0) {
      await ctx.reply(`Game not found: ${q}`);
      return;
    }
    // prefer case-insensitive exact match, else first
    const exact = list.find(x => String(x.name || '').toLowerCase() === q.toLowerCase()) || list[0];

    const bcTok = await ctx.getBroadcasterToken();
    const pres = await ctx.helix(`/channels?broadcaster_id=${bcId}`, {
      method: 'PATCH',
      token: bcTok,
      json: { game_id: exact.id },
    });
    await getJSON(pres);
    await ctx.reply(`Game updated to ${exact.name}.`);
  } catch (e) {
    await ctx.reply(`Game error: ${e.message}`);
  }
};
