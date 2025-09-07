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
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { res, json, text };
}

async function getUserByLogin(login, token, clientId) {
  const key = login.toLowerCase();
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

  // 4) Ultimate fallback: /search/channels also includes “playing or last played”
  {
    const q = encodeURIComponent(login);
    const r = await helix(`/search/channels?query=${q}&live_only=false`, token, clientId);
    const match = r.json?.data?.find(d => (d.broadcaster_login || '').toLowerCase() === login.toLowerCase());
    if (r.res.ok && match?.game_name) return { name: match.game_name, mode: 'search' };
  }

  return null;
}

module.exports = {
  name: 'so2',
  aliases: ['soann', 'boost', 'so_announce'],
  description: 'Post an announcement shoutout in chat',
  permission: 'mod',
  cooldownSec: 15, // separate, slightly longer cooldown
  async run(ctx) {
    const { channel, args, reply, say, getToken } = ctx;
    if (!args.length) return reply('usage: !so_announce <user>');

    let target = args[0].trim()
      .replace(/^@/, '')
      .replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '')
      .replace(/[^a-zA-Z0-9_]/g, '');
    if (!target) return reply('who am I announcing?');

    const token = getToken();
    const clientId = process.env.TWITCH_CLIENT_ID;
    const broadcasterLogin = channel.replace(/^#/, '').toLowerCase();

    try {
      const broadcaster = await getUserByLogin(broadcasterLogin, token, clientId);
      const moderatorId = await getSelfId(token, clientId);
      const targetUser = await getUserByLogin(target, token, clientId);

      // build message

      let gameFrag = '- they are very cool and deserve your support: ';
      try {
        const g = await getBestGameForChannel(targetUser.id, targetUser.login, token, clientId);
        if (g && g.name) {
        gameFrag = g.mode === 'currently'
          ? `- they are currently streaming some ${(g.name ?? '').toUpperCase()}. They are very cool and deserve your support: `
          : `- they were last seen streaming some ${(g.name ?? '').toUpperCase()}. They are very cool and deserve your support: `;
      }
    } catch { /* keep default */ }

      const message =
        `Please go and give the lovely ${targetUser.display_name} a follow ${gameFrag}https://twitch.tv/${targetUser.login}`;

      // POST /chat/announcements
      const params = `?broadcaster_id=${broadcaster.id}&moderator_id=${moderatorId}`;
      const body = JSON.stringify({ message, color: 'primary' });
      const { res, text } = await helix(`/chat/announcements${params}`, token, clientId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      });

      if (res.status === 204) return; // announcement posted; Twitch renders it
      if (res.status === 403) return reply('bot needs announcements scope and mod status.');
      if (res.status === 429) return reply('announcement rate-limited; try again soon.');

      console.error('[SO_ANN] API error', res.status, text);
      return reply('announcement failed.');
    } catch (e) {
      console.error('[SO_ANN] error', e);
      return reply('announcement error.');
    }
  }
};
