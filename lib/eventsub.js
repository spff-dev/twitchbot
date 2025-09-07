// /srv/bots/twitchbot/lib/eventsub.js
const WebSocket = require('ws');
const API = 'https://api.twitch.tv/helix';
const { getTemplates, getCheerGuard, format } = require('./config');

// ---- small Helix helpers ----
async function helix(path, getTok, clientId, opts = {}) {
  const token = await getTok();
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Client-Id': clientId,
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { res, json, text };
}

const _idCache = new Map();
async function getUserId(login, getTok, clientId) {
  const norm = String(login || '').toLowerCase().replace(/^[@#]/, '').trim();
  if (!norm) throw new Error('empty login for getUserId');
  if (_idCache.has(norm)) return _idCache.get(norm);
  const { res, json } = await helix(`/users?login=${encodeURIComponent(norm)}`, getTok, clientId);
  if (!res.ok) throw new Error(`users lookup failed: ${res.status}`);
  const id = json?.data?.[0]?.id;
  if (!id) throw new Error(`unknown user: ${norm}`);
  _idCache.set(norm, id);
  return id;
}
async function getBotUserId(getBotTok, clientId) {
  if (_idCache.has('__self')) return _idCache.get('__self');
  const { res, json } = await helix(`/users`, getBotTok, clientId);
  if (!res.ok) throw new Error(`self lookup failed: ${res.status}`);
  const id = json?.data?.[0]?.id;
  if (!id) throw new Error('could not determine bot user id');
  _idCache.set('__self', id);
  return id;
}

async function postAnnouncement({ message, broadcaster_id, moderator_id }, getBotTok, clientId) {
  const params = `?broadcaster_id=${broadcaster_id}&moderator_id=${moderator_id}`;
  return helix(`/chat/announcements${params}`, getBotTok, clientId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, color: 'primary' })
  });
}

// --- Shoutout (official API) plus announcement helper ---
async function doOfficialShoutout({ to_broadcaster_id, broadcaster_id, moderator_id }, getBotTok, clientId) {
  const params = `?from_broadcaster_id=${broadcaster_id}&to_broadcaster_id=${to_broadcaster_id}&moderator_id=${moderator_id}`;
  await helix(`/chat/shoutouts${params}`, getBotTok, clientId, { method: 'POST' });
}

async function subscribe({ session_id, type, version, condition }, getTok, clientId) {
  const body = JSON.stringify({ type, version, condition, transport: { method: 'websocket', session_id } });
  return helix('/eventsub/subscriptions', getTok, clientId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });
}

function tierLabel(tier) {
  if (tier === 'Prime' || String(tier).toLowerCase() === 'prime') return 'Prime';
  if (tier === '1000' || tier === '1') return 'Tier 1';
  if (tier === '2000' || tier === '2') return 'Tier 2';
  if (tier === '3000' || tier === '3') return 'Tier 3';
  return 'Tier 1';
}

// ---- Bits anti spam guard (per user) ----
const cheerState = new Map(); // key -> { times: number[], mutedUntil: ms }
function cheerKey(ev) {
  if (ev?.is_anonymous) return 'anon';
  return ev?.user_id || (ev?.user_login || ev?.user_name || 'someone').toLowerCase();
}
function shouldAnnounceCheer(ev, now, guard) {
  const key = cheerKey(ev);
  const st = cheerState.get(key) || { times: [], mutedUntil: 0 };
  if (now < st.mutedUntil) {
    cheerState.set(key, st);
    return { ok: false, reason: 'muted' };
  }
  const windowMs = guard.windowSec * 1000;
  st.times = st.times.filter(t => now - t < windowMs);
  st.times.push(now);
  if (st.times.length > guard.max) {
    st.mutedUntil = now + guard.muteSec * 1000;
    cheerState.set(key, st);
    return { ok: false, reason: 'rate' };
  }
  cheerState.set(key, st);
  return { ok: true };
}

// ---- Game/category helpers for raid and shoutout copy ----
async function getGameInfoForUser(userId, getTok, clientId) {
  // 1) Live? /streams holds current game_name
  {
    const r = await helix(`/streams?user_id=${userId}`, getTok, clientId);
    const s = r.json?.data?.[0];
    if (r.res.ok && s?.game_name) return { name: s.game_name, mode: 'currently' };
  }
  // 2) Offline? /channels has game_name of playing or last played
  {
    const r = await helix(`/channels?broadcaster_id=${userId}`, getTok, clientId);
    const c = r.json?.data?.[0];
    if (r.res.ok && c?.game_name) return { name: c.game_name, mode: 'last seen' };
  }
  return null;
}

function gameFragFrom(info) {
  if (!info || !info.name) return '- go drop a follow! ';
  const upper = String(info.name || '').toUpperCase();
  return info.mode === 'currently'
    ? `- they are currently streaming some ${upper}. They are very cool and deserve your support: `
    : `- they were last seen streaming some ${upper}. They are very cool and deserve your support: `;
}

// ---- shared event router (used by both sessions) ----
async function handleNotification(subType, ev, ids, getBotTok, clientId, hooks) {
  const { broadcaster_id, moderator_id } = ids;
  const tpls = getTemplates();

  if (subType === 'channel.follow') {
    const name = ev?.user_name || ev?.user_login || 'someone';
    hooks.onFollowChat?.(name);
    return;
  }

  if (subType === 'channel.cheer') {
    const who  = ev?.user_name || ev?.user_login || 'someone';
    const bits = ev?.bits || 0;
    const guard = getCheerGuard();
    const gate  = shouldAnnounceCheer(ev, Date.now(), guard);
    if (!gate.ok) {
      console.log(`[EVT/BC] cheer from ${who} suppressed (${gate.reason}); window=${guard.windowSec}s max=${guard.max} mute=${guard.muteSec}s`);
      return;
    }
    const message = format(tpls.bits, { USER: who, BITS: bits });
    await postAnnouncement({ message, broadcaster_id, moderator_id }, getBotTok, clientId);
    hooks.onBitsAnnounce?.(who, bits);
    return;
  }

  if (subType === 'channel.subscribe') {
    const who  = ev?.user_name || ev?.user_login || 'someone';
    const tier = tierLabel(ev?.tier || '');
    const message = format(tpls.sub, { USER: who, TIER: tier });
    await postAnnouncement({ message, broadcaster_id, moderator_id }, getBotTok, clientId);
    hooks.onSubAnnounce?.(who, tier, !!ev?.is_gift);
    return;
  }

  if (subType === 'channel.subscription.message') {
    const who    = ev?.user_name || ev?.user_login || 'someone';
    const tier   = tierLabel(ev?.tier || '');
    const months = ev?.cumulative_months || ev?.streak_months || 0;
    const message = format(tpls.resub, { USER: who, TIER: tier, MONTHS: months });
    await postAnnouncement({ message, broadcaster_id, moderator_id }, getBotTok, clientId);
    hooks.onResubAnnounce?.(who, tier, months);
    return;
  }

  if (subType === 'channel.subscription.gift') {
    const gifter = ev?.user_name || ev?.user_login || 'Someone';
    const count  = ev?.total || 1;
    const tier   = tierLabel(ev?.tier || '');
    const anon   = ev?.is_anonymous ? 'Anonymous ' : '';
    const message = format(tpls.gift, {
      GIFTER: gifter, COUNT: count, TIER: tier, S: count > 1 ? 's' : '', ANON: anon
    });
    await postAnnouncement({ message, broadcaster_id, moderator_id }, getBotTok, clientId);
    hooks.onGiftAnnounce?.(gifter, tier, count, !!ev?.is_anonymous);
    return;
  }

  // ---- Ads begin -> start plus schedule end banners
  if (subType === 'channel.ad_break.begin') {
    const dur = Number(ev?.duration_seconds || 0);
    await postAnnouncement({
      message: `📣 ${dur} seconds of ads have started, thanks for sticking around`,
      broadcaster_id, moderator_id
    }, getBotTok, clientId);

    if (dur > 0) {
      setTimeout(() => {
        postAnnouncement({
          message: `✅ Ads are over, welcome back - you didn't miss anything`,
          broadcaster_id, moderator_id
        }, getBotTok, clientId).catch(() => {});
      }, dur * 1000);
    }
    return;
  }

  // ---- RAID received -> banner plus auto shoutout (official plus announcement)
  if (subType === 'channel.raid') {
    const fromId    = ev?.from_broadcaster_user_id;
    const fromLogin = ev?.from_broadcaster_user_login || ev?.from_broadcaster_user_name || 'someone';
    const fromName  = ev?.from_broadcaster_user_name  || fromLogin;
    const viewers   = Number(ev?.viewers || 0);

    // Best effort game (live or last set)
    let gameInfo = null;
    try { gameInfo = await getGameInfoForUser(fromId, getBotTok, clientId); } catch {}

    const gamePart = gameInfo?.name ? `- they were streaming ${gameInfo.name}` : '';
    await postAnnouncement({
      message: `🚀 Raid from ${fromName} with ${viewers} - welcome in! ${gamePart}`.trim(),
      broadcaster_id, moderator_id
    }, getBotTok, clientId);

    // Official shoutout (may be on cooldown - ignore errors quietly)
    try {
      await doOfficialShoutout({ to_broadcaster_id: fromId, broadcaster_id, moderator_id }, getBotTok, clientId);
    } catch (e) {
      // ignore
    }

    // Announcement style shoutout using your template
    try {
      const tplsLocal = getTemplates();
      const frag = gameFragFrom(gameInfo);
      const shout = format(tplsLocal.shoutout || 'Please go and give {USER} a follow {GAMEFRAG}https://twitch.tv/{LOGIN}', {
        USER: fromName,
        LOGIN: fromLogin,
        GAMEFRAG: frag
      });
      await postAnnouncement({ message: shout, broadcaster_id, moderator_id }, getBotTok, clientId);
    } catch (e) {
      // ignore
    }
    return;
  }
}

// ---- Ad schedule polling (60s warning) ----
function startAdSchedulePoller({ broadcaster_id, getBroadcasterToken, getBotTok, clientId, warnLeadSec = 60 }) {
  let adWarnTimer = null;
  let lastWarnedFor = ''; // RFC3339 we already warned for

  async function tick() {
    try {
      const { res, json } = await helix(`/channels/ads?broadcaster_id=${broadcaster_id}`, getBroadcasterToken, clientId);
      if (!res.ok) return;

      const row = json?.data?.[0];
      const nextAt = row?.next_ad_at || '';
      const dur = Number(row?.duration || 0);

      if (adWarnTimer) { clearTimeout(adWarnTimer); adWarnTimer = null; }
      if (!nextAt || !dur) { lastWarnedFor = ''; return; }

      const tNext = new Date(nextAt).getTime();
      const now = Date.now();
      const warnAt = tNext - warnLeadSec * 1000;
      const delay = warnAt - now;

      const warnOnce = async () => {
        if (lastWarnedFor !== nextAt) {
          await postAnnouncement({
            message: `📢 ${dur} seconds of ads are due in ${warnLeadSec} seconds`,
            broadcaster_id,
            moderator_id: await getBotUserId(getBotTok, clientId)
          }, getBotTok, clientId);
          lastWarnedFor = nextAt;
        }
      };

      if (delay <= 0) {
        await warnOnce();
      } else {
        adWarnTimer = setTimeout(() => { warnOnce().catch(() => {}); }, delay);
      }
    } catch {
      // quiet
    }
  }

  const iv = setInterval(tick, 30_000);
  tick(); // initial
  return () => { clearInterval(iv); if (adWarnTimer) clearTimeout(adWarnTimer); };
}

// ---- Start a single WS session with the given token and topics ----
async function startSession({ label, clientId, getTok, getBotTok, broadcasterLogin, topics, hooks, afterOnline }) {
  const broadcaster_id = await getUserId(broadcasterLogin, getBotTok, clientId);
  const moderator_id   = await getBotUserId(getBotTok, clientId); // the bot

  let ws = null;
  let currentUrl = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30';

  function connect(url = currentUrl) {
    ws = new WebSocket(url);

    ws.on('message', async (data) => {
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      const type = msg.metadata?.message_type;

      if (type === 'session_welcome') {
        const session_id = msg.payload?.session?.id;

        for (const t of topics) {
          // Per topic conditions
          let condition;
          if (t.type === 'channel.follow' && t.version === '2') {
            condition = { broadcaster_user_id: broadcaster_id, moderator_user_id: moderator_id };
          } else if (t.type === 'channel.raid') {
            condition = { to_broadcaster_user_id: broadcaster_id }; // receiving raids
          } else {
            condition = { broadcaster_user_id: broadcaster_id };
          }

          const { res, text } = await subscribe(
            { session_id, type: t.type, version: t.version, condition },
            getTok, clientId
          );
          if (res.status !== 202) console.warn(`[EVT/${label}] subscribe failed`, t.type, res.status, text);
        }
        console.log(`[EVT/${label}] EventSub online for ${String(broadcasterLogin).replace(/^[@#]/,'')} (broadcaster_id=${broadcaster_id}, moderator_id=${moderator_id})`);

        // callback for extra setup (for example schedule poller)
        if (typeof afterOnline === 'function') {
          try { afterOnline({ broadcaster_id, moderator_id }); } catch {}
        }
      }

      else if (type === 'notification') {
        const subType = msg.payload?.subscription?.type;
        const ev      = msg.payload?.event;
        try {
          await handleNotification(subType, ev, { broadcaster_id, moderator_id }, getBotTok, clientId, hooks || {});
        } catch (e) {
          console.error(`[EVT/${label}] handler error`, subType, e);
        }
      }

      else if (type === 'session_reconnect') {
        const url = msg.payload?.session?.reconnect_url;
        try { ws.close(); } catch {}
        if (url) { currentUrl = url; connect(url); }
      }
    });

    ws.on('close', () => setTimeout(() => connect(currentUrl), 2000 + Math.random() * 3000));
  }

  connect();
  return { broadcaster_id, moderator_id };
}

// Public helpers: one session for BOT (follows), one for BROADCASTER (subs/bits/ads/raids)
async function startEventSubBot(opts) {
  const { clientId, getBotToken, broadcasterLogin, onFollowChat, ...rest } = opts;
  return startSession({
    label: 'BOT',
    clientId,
    getTok: getBotToken,
    getBotTok: getBotToken,
    broadcasterLogin,
    topics: [{ type: 'channel.follow', version: '2' }],
    hooks: { onFollowChat, ...rest }
  });
}

async function startEventSubBroadcaster(opts) {
  const { clientId, getBroadcasterToken, getBotToken, broadcasterLogin, ...hooks } = opts;
  let stopWarn = null;

  const session = await startSession({
    label: 'BC',
    clientId,
    getTok: getBroadcasterToken,
    getBotTok: getBotToken,            // announcements and shoutouts use bot token
    broadcasterLogin,
    topics: [
      { type: 'channel.cheer',                version: '1' },
      { type: 'channel.subscribe',            version: '1' },
      { type: 'channel.subscription.message', version: '1' },
      { type: 'channel.subscription.gift',    version: '1' },
      { type: 'channel.ad_break.begin',       version: '1' },
      { type: 'channel.raid',                 version: '1' }
    ],
    hooks,
    afterOnline: ({ broadcaster_id }) => {
      stopWarn = startAdSchedulePoller({
        broadcaster_id,
        getBroadcasterToken,
        getBotTok: getBotToken,
        clientId,
        warnLeadSec: 60
      });
    }
  });

  return { ...session, stop: () => { if (stopWarn) stopWarn(); } };
}

module.exports = { startEventSubBot, startEventSubBroadcaster };
