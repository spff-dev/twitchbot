// /srv/bots/twitchbot/commands/so.js
// Shoutout: official API + always-do announcement using same copy as so2
const API = 'https://api.twitch.tv/helix';

const idCache = new Map();
let selfId = null;

async function helix(path, token, clientId, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Client-Id': clientId,
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { res, json, text };
}

// Convenience wrapper that returns a real Response (for parity with so2)
async function h(path, token, clientId, opts = {}) {
  return fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Client-Id': clientId,
      ...(opts.headers || {})
    }
  });
}

async function getUserByLogin(login, token, clientId) {
  const key = login.toLowerCase().replace(/^[@#]/, '');
  if (idCache.has(key)) return idCache.get(key);
  const { res, json } = await helix(`/users?login=${encodeURIComponent(key)}`, token, clientId);
  if (!res.ok) throw new Error(`unknown user: ${login}`);
  const user = json?.data?.[0];
  if (!user) throw new Error(`unknown user: ${login}`);
  idCache.set(key, user);
  return user; // { id, login, display_name }
}

async function getSelfId(token, clientId) {
  if (selfId) return selfId;
  const { res, json } = await helix(`/users`, token, clientId);
  if (!res.ok) throw new Error(`self lookup failed: ${res.status}`);
  selfId = json?.data?.[0]?.id;
  if (!selfId) throw new Error('could not determine bot user id');
  return selfId;
}

// Best-effort game detector: live -> channel info -> last VOD -> search channels
async function getBestGameForChannel(userId, login, token, clientId) {
  // 1) If live, /streams has game_name
  {
    const r = await helix(`/streams?user_id=${userId}`, token, clientId);
    const s = r.json?.data?.[0];
    if (r.res.ok && s?.game_name) return { name: s.game_name, mode: 'currently' };
  }

  // 2) Offline? /channels has game_name of "playing or last played"
  {
    const r = await helix(`/channels?broadcaster_id=${userId}`, token, clientId);
    const c = r.json?.data?.[0];
    if (r.res.ok && c?.game_name) return { name: c.game_name, mode: 'last seen' };
  }

  // 3) No channel category? Try last VOD’s game_id -> /games
  {
    const v = await helix(`/videos?user_id=${userId}&type=archive&first=1`, token, clientId);
    const gameId = v.json?.data?.[0]?.game_id;
    if (v.res.ok && gameId) {
      const g = await helix(`/games?id=${encodeURIComponent(gameId)}`, token, clientId);
      const name = g.json?.data?.[0]?.name;
      if (g.res.ok && name) return { name, mode: 'from VOD' };
    }
  }

  // 4) Fallback: /search/channels includes “playing or last played”
  {
    const q = encodeURIComponent(login);
    const r = await helix(`/search/channels?query=${q}&live_only=false`, token, clientId);
    const match = r.json?.data?.find(d => (d.broadcaster_login || '').toLowerCase() === login.toLowerCase());
    if (r.res.ok && match?.game_name) return { name: match.game_name, mode: 'search' };
  }

  return null;
}

module.exports = {
  name: 'so',
  aliases: ['shoutout'],
  description: 'Shout out another streamer. Usage: !so @username',
  permission: 'mod',
  cooldownSec: 5,

  async run(ctx) {
    const token = ctx.getToken();                  // bot token (mod scopes)
    const clientId = process.env.TWITCH_CLIENT_ID;

    const mention = (ctx.args[0] || '').trim();
    if (!mention) return ctx.reply('usage: !so @username');

    const targetLogin = mention
      .replace(/^@/, '')
      .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '')
      .replace(/[^a-zA-Z0-9_]/g, '')
      .toLowerCase();

    if (!targetLogin) return ctx.reply('who am I shouting out?');

    const channelLogin = ctx.channel.replace(/^#/, '').toLowerCase();

    try {
      // Resolve IDs (bot/mod, broadcaster, target)
      const me = await (await h(`/users`, token, clientId)).json();
      const moderator_id = me?.data?.[0]?.id;

      const bc = await (await h(`/users?login=${encodeURIComponent(channelLogin)}`, token, clientId)).json();
      const broadcaster_id = bc?.data?.[0]?.id;
      if (!broadcaster_id) return ctx.reply(`cannot resolve broadcaster id`);

      const tu = await (await h(`/users?login=${encodeURIComponent(targetLogin)}`, token, clientId)).json();
      const targetUser = tu?.data?.[0];
      if (!targetUser) return ctx.reply(`no user named "${targetLogin}"`);

      // 1) Attempt official shoutout (quiet on normal failures)
      try {
        const res = await fetch(`${API}/chat/shoutouts?from_broadcaster_id=${broadcaster_id}&to_broadcaster_id=${targetUser.id}&moderator_id=${moderator_id}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Client-Id': clientId },
        });
        if (res.status !== 204) {
          const text = await res.text().catch(() => '');
          // Known/benign: 400 (not live/0 viewers), 409 (cooldown), 403 (permissions)
          if (![204, 400, 403, 409].includes(res.status)) {
            console.warn(`[SO] unexpected shoutout error ${res.status} ${text}`);
          }
        }
      } catch (e) {
        console.warn('[SO] shoutout request threw', e?.message || e);
      }

      // 2) Build the SAME announcement text as your so2.js
      let gameFrag = '- they are very cool and deserve your support: ';
      try {
        const g = await getBestGameForChannel(targetUser.id, targetUser.login, token, clientId);
        if (g && g.name) {
          const upper = (g.name || '').toUpperCase();
          gameFrag = g.mode === 'currently'
            ? `- they are currently streaming some ${upper}. They are very cool and deserve your support: `
            : `- they were last seen streaming some ${upper}. They are very cool and deserve your support: `;
        }
      } catch { /* keep default */ }

      const message =
        `Please go and give the lovely ${targetUser.display_name} a follow ${gameFrag}https://twitch.tv/${targetUser.login}`;

      // 3) Always post the announcement variant
      try {
        const params = `?broadcaster_id=${broadcaster_id}&moderator_id=${moderator_id}`;
        const res = await fetch(`${API}/chat/announcements${params}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Client-Id': clientId,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ message, color: 'primary' })
        });
        if (res.status !== 204) {
          const text = await res.text().catch(() => '');
          console.warn(`[SO] announcement failed ${res.status} ${text}`);
        }
      } catch (e) {
        console.warn('[SO] announcement threw', e?.message || e);
      }
    } catch (e) {
      console.error('[SO] error', e);
      return ctx.reply('shoutout error.');
    }
  }
};
