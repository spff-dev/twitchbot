'use strict';

// !so <channel>
// - Official shoutout (optional, default on)
// - Then try an announcement using the configured response template
// - If announcement 204 => suppress chat; else fallback to chat message from config
// Tokens supported in config.response (old + new):
//   {userDisplayName} {displayName} {userLogin} {login} {gameName} {GAME_UPPER} {gameMode} {gameFragment}

module.exports = {
  schemaVersion: 1,
  name: 'so',
  category: 'moderator',
  schema: {
    type: 'object',
    additionalProperties: true, // allow extra knobs
    properties: {
      response:         { type: 'string',  default: 'Please go and give the lovely {userDisplayName} a follow {gameFragment}https://twitch.tv/{userLogin}' },
      roles:            { type: 'array',   items: { type: 'string' }, default: ['mod'] },
      cooldownSeconds:  { type: 'integer', minimum: 0, default: 15 },
      limitPerUser:     { type: 'integer', minimum: 0, default: 0 },
      limitPerStream:   { type: 'integer', minimum: 0, default: 0 },
      replyToUser:      { type: 'boolean', default: false },
      failSilently:     { type: 'boolean', default: true },
      doShoutout:       { type: 'boolean', default: true },
      templates: {
        type: 'object',
        additionalProperties: true,
        properties: {
          usage:     { type: 'string', default: 'Usage: !so <channel>' },
          notFound:  { type: 'string', default: 'Could not find channel {target}.' },
          fragments: {
            type: 'object',
            additionalProperties: true,
            properties: {
              none:      { type: 'string', default: '- they are very cool and deserve your support: ' },
              currently: { type: 'string', default: '- they are currently streaming some {GAME_UPPER}. They are very cool and deserve your support: ' },
              last:      { type: 'string', default: '- they were last seen streaming some {GAME_UPPER}. They are very cool and deserve your support: ' },
              vod:       { type: 'string', default: '- they were last seen streaming some {GAME_UPPER}. They are very cool and deserve your support: ' }
            }
          }
        }
      }
    }
  },
  defaults: {
    roles: ['mod'],
    cooldownSeconds: 15,
    replyToUser: false,
    doShoutout: true
  },

  async execute(ctx, args, cfg) {
    const render = (str, tokens) =>
      String(str || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => {
        const v = tokens[k]; return v === undefined || v === null ? '' : String(v);
      });

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
        const msg = (body && body.message) ? body.message : `status ${res.status}`;
        throw new Error(msg);
      }
      return body;
    }

    async function bestGame(userId, login) {
      const tok = await ctx.getAppToken();

      const s = await ctx.helix(`/streams?user_id=${userId}`, { method: 'GET', token: tok }).then(getJSON);
      const live = s.data && s.data[0];
      if (live && live.game_name) return { name: live.game_name, mode: 'currently' };

      const c = await ctx.helix(`/channels?broadcaster_id=${userId}`, { method: 'GET', token: tok }).then(getJSON);
      const ch = c.data && c.data[0];
      if (ch && ch.game_name) return { name: ch.game_name, mode: 'last' };

      const v = await ctx.helix(`/videos?user_id=${userId}&type=archive&first=1`, { method: 'GET', token: tok }).then(getJSON);
      const gameId = v.data && v.data[0] && v.data[0].game_id;
      if (gameId) {
        const g = await ctx.helix(`/games?id=${encodeURIComponent(gameId)}`, { method: 'GET', token: tok }).then(getJSON);
        const name = g.data && g.data[0] && g.data[0].name;
        if (name) return { name, mode: 'vod' };
      }

      const q = await ctx.helix(`/search/channels?query=${encodeURIComponent(login)}&live_only=false`, { method: 'GET', token: tok }).then(getJSON);
      const match = (q.data || []).find(d => String(d.broadcaster_login || '').toLowerCase() === login.toLowerCase());
      if (match && match.game_name) return { name: match.game_name, mode: 'last' };

      return null;
    }

    // ----- parse args -----
    const target = toLogin(args && args[0]);
    if (!target) {
      if (!cfg.failSilently) return { vars: { out: cfg.templates?.usage || 'Usage: !so <channel>' }, reply: true };
      return { vars: {}, suppress: true };
    }

    // ----- resolve user -----
    const appTok = await ctx.getAppToken();
    const ujson = await ctx.helix(`/users?login=${encodeURIComponent(target)}`, { method: 'GET', token: appTok })
      .then(async res => {
        const b = await res.json().catch(()=>({}));
        if (!res.ok) throw new Error((b && b.message) || `status ${res.status}`);
        return b;
      });
    const user = (ujson.data && ujson.data[0]) || null;
    if (!user) {
      const msg = render(cfg.templates?.notFound || 'Could not find channel {target}.', { target });
      if (!cfg.failSilently) return { vars: { out: msg }, reply: true };
      return { vars: {}, suppress: true };
    }

    // ----- enrich game + tokens (old + new) -----
    let gameName = '';
    let gameMode = 'recently';
    let GAME_UPPER = '';
    try {
      const g = await bestGame(user.id, user.login);
      if (g && g.name) {
        gameName = String(g.name);
        GAME_UPPER = gameName.toUpperCase();
        gameMode = g.mode || 'recently';
      }
    } catch {}
    const fragKey = gameName ? (gameMode === 'currently' ? 'currently' : (gameMode === 'vod' ? 'vod' : 'last')) : 'none';
    const fragTpl = (cfg.templates && cfg.templates.fragments && cfg.templates.fragments[fragKey]) ||
                    '- they are very cool and deserve your support: ';
    const gameFragment = render(fragTpl, { GAME_UPPER });

    // tokens both ways so older templates keep working
    const vars = {
      displayName: String(user.display_name || user.login),
      userDisplayName: String(user.display_name || user.login),
      login: String(user.login),
      userLogin: String(user.login),
      gameName,
      GAME_UPPER,
      gameMode,
      gameFragment
    };

    // ----- official shoutout (optional) -----
    if (cfg.doShoutout !== false) {
      try {
        const bcTok = await ctx.getBroadcasterToken();
        await ctx.helix('/chat/shoutouts', {
          method: 'POST',
          token: bcTok,
          json: {
            from_broadcaster_id: ctx.broadcasterUserId,
            to_broadcaster_id: user.id,
            moderator_id: ctx.broadcasterUserId
          }
        });
      } catch (e) {
        // non-fatal
      }
    }

    // ----- try announcement; suppress chat on success -----
    try {
      const botTok = await ctx.getBotToken();
      const q = `broadcaster_id=${ctx.channel.id}&moderator_id=${ctx.botUserId}`;
      const message = render(String(cfg.response || ''), vars);
      if (message && message.trim() !== '') {
        const res = await ctx.helix(`/chat/announcements?${q}`, {
          method: 'POST',
          token: botTok,
          json: { message, color: 'primary' }
        });
        if (res.status === 204) {
          return { vars, suppress: true, reply: false };
        }
      }
    } catch (e) {
      // fall through to chat fallback
    }

    // Chat fallback via router using cfg.response + vars
    return { vars, reply: !!cfg.replyToUser };
  }
};
