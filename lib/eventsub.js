'use strict';

/**
 * EventSub over WebSocket with three sessions:
 *  - APP: channel.chat.message using BOT user token (WebSocket requires user token)
 *  - BC:  subs, bits, ads, raid using Broadcaster user token
 *  - BOT: follows using Bot user token
 *
 * Reconnects on welcome and obeys reconnect URLs.
 * Logs:
 *  [EVT/APP], [EVT/BC], [EVT/BOT]
 */

const WebSocket = require('ws');

const WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const HELIX_SUBS = 'https://api.twitch.tv/helix/eventsub/subscriptions';

function jitter(ms) {
  return ms + Math.floor(Math.random() * 250);
}

async function postSub({ clientId, token, type, version, condition, sessionId }) {
  const res = await fetch(HELIX_SUBS, {
    method: 'POST',
    headers: {
      'Client-Id': clientId,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      type,
      version,
      condition,
      transport: {
        method: 'websocket',
        session_id: sessionId,
      },
    }),
  });
  return res;
}

class Session {
  constructor(label, tokenProvider, topicsFactory, clientId, handlers) {
    this.label = label;
    this.tokenProvider = tokenProvider;
    this.topicsFactory = topicsFactory;
    this.clientId = clientId;
    this.handlers = handlers;
    this.ws = null;
    this.sessionId = null;
    this.reconnectUrl = null;
    this.pingTimer = null;
    this.backoff = 1000;
  }

  log(...args) {
    console.log(`[${this.label}]`, ...args);
  }

  async connect(url) {
    const target = url || WS_URL;
    this.ws = new WebSocket(target);
    this.ws.on('open', () => this.log('open', target));
    this.ws.on('message', (buf) => this.onMessage(buf));
    this.ws.on('close', (code, reason) => this.onClose(code, reason));
    this.ws.on('error', (err) => {
      this.log('error', err.message);
    });
  }

  async onMessage(buf) {
    let data;
    try {
      data = JSON.parse(buf.toString('utf8'));
    } catch {
      this.log('bad json');
      return;
    }
    const meta = data.metadata || {};
    const payload = data.payload || {};

    switch (meta.message_type) {
      case 'session_welcome': {
        this.sessionId = payload.session && payload.session.id;
        this.reconnectUrl = null;
        this.log('welcome', this.sessionId);
        await this.subscribeAll();
        break;
      }
      case 'session_reconnect': {
        const newUrl = payload.session && payload.session.reconnect_url;
        this.log('reconnect', newUrl);
        this.reconnectUrl = newUrl;
        try { this.ws.close(4000, 'reconnect'); } catch {}
        break;
      }
      case 'notification': {
        this.onNotification(payload);
        break;
      }
      case 'session_keepalive': {
        break;
      }
      case 'revocation': {
        this.log('revocation', JSON.stringify(payload.subscription || {}));
        break;
      }
      default:
        break;
    }
  }

  onClose(code, reason) {
    this.log('close', code, String(reason || ''));
    clearTimeout(this.pingTimer);
    this.ws = null;
    this.sessionId = null;
    const url = this.reconnectUrl || null;
    setTimeout(() => this.connect(url), jitter(this.backoff));
    this.backoff = Math.min(this.backoff * 2, 15000);
  }

  async subscribeAll() {
    const topics = await this.topicsFactory();
    for (const t of topics) {
      try {
        const token = await this.tokenProvider();
        const res = await postSub({
          clientId: this.clientId,
          token,
          type: t.type,
          version: t.version || '1',
          condition: t.condition,
          sessionId: this.sessionId,
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          this.log('subscribe fail', t.type, res.status, txt);
        } else {
          const js = await res.json().catch(() => ({}));
          this.log('subscribed', t.type, js.data && js.data[0] && js.data[0].id ? js.data[0].id : '');
        }
      } catch (e) {
        this.log('subscribe error', t.type, e.message);
      }
    }
  }

  onNotification(payload) {
    const sub = payload.subscription || {};
    const ev = payload.event || {};
    const type = sub.type;

    if (type === 'channel.chat.message') {
      const msg = ev.message || {};
      const badges = Array.isArray(ev.badges) ? ev.badges : [];
      const badgeSet = new Set(badges.map(b => (b.set_id || b.id || '').toLowerCase()));
      const isMod = !!badgeSet.has('moderator');
      const isBroadcaster = !!badgeSet.has('broadcaster') || ev.chatter_user_id === ev.broadcaster_user_id;

      const out = {
        type: 'chat',
        channelId: ev.broadcaster_user_id,
        channelLogin: ev.broadcaster_user_login,
        userId: ev.chatter_user_id,
        userLogin: ev.chatter_user_login,
        userName: ev.chatter_user_name,
        isMod,
        isBroadcaster,
        messageId: msg.message_id || msg.id || ev.message_id || null,
        text: msg.text || '',
        replyParentMessageId: (msg.reply && msg.reply.parent_message_id) || ev.reply_parent_message_id || null,
      };
      this.handlers.onChatMessage && this.handlers.onChatMessage(out);
      return;
    }

    if (type === 'channel.follow') {
      this.handlers.onFollow && this.handlers.onFollow({
        userId: ev.user_id,
        userLogin: ev.user_login,
        userName: ev.user_name,
      });
      return;
    }

    if (type === 'channel.cheer') {
      this.handlers.onCheer && this.handlers.onCheer({
        userId: ev.user_id,
        userLogin: ev.user_login,
        userName: ev.user_name,
        bits: ev.bits,
      });
      return;
    }

    if (type === 'channel.raid') {
      this.handlers.onRaid && this.handlers.onRaid({
        fromBroadcasterId: ev.from_broadcaster_user_id,
        fromBroadcasterLogin: ev.from_broadcaster_user_login,
        viewers: ev.viewers,
      });
      return;
    }

    if (type === 'channel.subscribe') {
      this.handlers.onSub && this.handlers.onSub({
        userId: ev.user_id,
        userLogin: ev.user_login,
        userName: ev.user_name,
        tier: ev.tier,
        isGift: !!ev.is_gift,
      });
      return;
    }

    if (type === 'channel.subscription.message') {
      this.handlers.onResub && this.handlers.onResub({
        userId: ev.user_id,
        userLogin: ev.user_login,
        userName: ev.user_name,
        message: ev.message && ev.message.text || '',
        months: ev.cumulative_months || 0,
      });
      return;
    }

    if (type === 'channel.subscription.gift') {
      this.handlers.onSubGift && this.handlers.onSubGift({
        userId: ev.user_id,
        userLogin: ev.user_login,
        userName: ev.user_name,
        total: ev.total || 0,
        tier: ev.tier || '',
      });
      return;
    }

    if (type === 'channel.ad_break.begin') {
      this.handlers.onAd && this.handlers.onAd({
        duration: ev.duration_seconds || 0,
      });
      return;
    }
  }
}

function startEventSub(opts) {
  const {
    clientId,
    getAppToken,
    getBroadcasterToken,
    getBotToken,
    broadcasterUserId,
    botUserId,
    onChatMessage,
    onFollow,
    onSub,
    onResub,
    onSubGift,
    onCheer,
    onRaid,
    onAd,
  } = opts;

  // APP session for chat reads
  // WebSocket requires a USER token. Use the bot's user token.
  const appSession = null; // webhook handles chat
// BC session for subs, bits, ads, raids
  const bcSession = new Session('EVT/BC', getBroadcasterToken, async () => ([
    { type: 'channel.subscribe', version: '1', condition: { broadcaster_user_id: broadcasterUserId } },
    { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: broadcasterUserId } },
    { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: broadcasterUserId } },
    { type: 'channel.cheer', version: '1', condition: { broadcaster_user_id: broadcasterUserId } },
    { type: 'channel.ad_break.begin', version: '1', condition: { broadcaster_user_id: broadcasterUserId } },
    { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: broadcasterUserId } },
  ]), clientId, { onSub, onResub, onSubGift, onCheer, onRaid, onAd });

  // BOT session for follows
  const botSession = new Session('EVT/BOT', getBotToken, async () => ([
    { type: 'channel.follow', version: '2', condition: { broadcaster_user_id: broadcasterUserId, moderator_user_id: botUserId } },
  ]), clientId, { onFollow });
// appSession disabled
  bcSession.connect();
  botSession.connect();

  return { appSession, bcSession, botSession };
}

module.exports = {
  startEventSub,
};
