'use strict';

module.exports.name = 'so2';
module.exports.aliases = ['soann', 'boost', 'so_announce'];
module.exports.description = 'Post an announcement shoutout in chat';
module.exports.permission = 'mod';
module.exports.cooldownSec = 15;

function toLogin(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^@+/, '');
  const m = s.match(/twitch\.tv\/([^\/\s]+)/i);
  if (m) s = m[1];
  return s.toLowerCase();
}

async function getJSON(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body && body.message ? body.message : `status ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

async function bestGame(ctx, userId, login) {
  const tok = await ctx.getAppToken();

  const s = await ctx.helix(`/streams?user_id=${userId}`, { method: 'GET', token: tok }).then(getJSON);
  const live = s.data && s.data[0];
  if (live && live.game_name) return { name: live.game_name, mode: 'currently' };

  const c = await ctx.helix(`/channels?broadcaster_id=${userId}`, { method: 'GET', token: tok }).then(getJSON);
  const ch = c.data && c.data[0];
  if (ch && ch.game_name) return { name: ch.game_name, mode: 'last seen' };

  const v = await ctx.helix(`/videos?user_id=${userId}&type=archive&first=1`, { method: 'GET', token: tok }).then(getJSON);
  const gameId = v.data && v.data[0] && v.data[0].game_id;
  if (gameId) {
    const g = await ctx.helix(`/games?id=${encodeURIComponent(gameId)}`, { method: 'GET', token: tok }).then(getJSON);
    const name = g.data && g.data[0] && g.data[0].name;
    if (name) return { name, mode: 'from VOD' };
  }

  const q = await ctx.helix(`/search/channels?query=${encodeURIComponent(login)}&live_only=false`, { method: 'GET', token: tok }).then(getJSON);
  const match = (q.data || []).find(d => String(d.broadcaster_login || '').toLowerCase() === login.toLowerCase());
  if (match && match.game_name) return { name: match.game_name, mode: 'search' };

  return null;
}

module.exports.run = async function so2(ctx, args) {
  if (!(ctx.isMod || ctx.isBroadcaster)) return;

  const target = toLogin(args && args[0]);
  if (!target) return ctx.reply('usage: !so2 <user>');

  try {
    // resolve target user with app token
    const appTok = await ctx.getAppToken();
    const ures = await ctx.helix(`/users?login=${encodeURIComponent(target)}`, { method: 'GET', token: appTok });
    const ujson = await getJSON(ures);
    const user = (ujson.data && ujson.data[0]) || null;
    if (!user) return ctx.reply(`unknown user: ${target}`);

    // build the same custom copy as !so
    let gameFrag = '- they are very cool and deserve your support: ';
    try {
      const g = await bestGame(ctx, user.id, user.login);
      if (g && g.name) {
        const upper = String(g.name || '').toUpperCase();
        gameFrag = g.mode === 'currently'
          ? `- they are currently streaming some ${upper}. They are very cool and deserve your support: `
          : `- they were last seen streaming some ${upper}. They are very cool and deserve your support: `;
      }
    } catch {}

    const message = `Please go and give the lovely ${user.display_name} a follow ${gameFrag}https://twitch.tv/${user.login}`;

    // Try to post an Announcement with the bot token and bot user id as moderator_id
    try {
      const botTok = await ctx.getBotToken();
      const modId = String(process.env.BOT_USER_ID || '').trim();
      if (modId) {
        const q = `broadcaster_id=${ctx.channel.id}&moderator_id=${modId}`;
        const res = await ctx.helix(`/chat/announcements?${q}`, {
          method: 'POST',
          token: botTok,
          json: { message, color: 'primary' },
        });
        if (res.status === 204) return; // banner posted
      }
    } catch {
      // fall through to normal message
    }

    // Fallback: normal message so the command still does something useful
    await ctx.say(message);
  } catch (e) {
    console.error('[SO2] error', e);
    return ctx.reply('announcement error.');
  }
};
