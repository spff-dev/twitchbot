'use strict';

// Get or set stream title
// No args: show current title
// With args: set title to the provided text (mods or broadcaster)

module.exports.name = 'title';

async function getJSON(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body && body.message ? body.message : `status ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

module.exports.run = async function title(ctx, args) {
  try {
    const bcId = ctx.channel.id;

    if (!args || args.length === 0) {
      const tok = await ctx.getAppToken();
      const res = await ctx.helix(`/channels?broadcaster_id=${bcId}`, { method: 'GET', token: tok });
      const js = await getJSON(res);
      const row = js.data && js.data[0];
      const title = row && row.title ? row.title : '(unknown)';
      await ctx.reply(`Title: ${title}`);
      return;
    }

    if (!(ctx.isMod || ctx.isBroadcaster)) {
      return;
    }
    const newTitle = String(args.join(' ')).trim().slice(0, 140);
    const tok = await ctx.getBroadcasterToken();
    const res = await ctx.helix(`/channels?broadcaster_id=${bcId}`, {
      method: 'PATCH',
      token: tok,
      json: { title: newTitle },
    });
    await getJSON(res);
    await ctx.reply(`Title updated.`);
  } catch (e) {
    await ctx.reply(`Title error: ${e.message}`);
  }
};
