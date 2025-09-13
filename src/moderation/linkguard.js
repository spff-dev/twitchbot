'use strict';

/**
 * Link guard: reply in-thread (if possible), then delete offending message.
 * Respects permits from permit-store. Whitelists configured hosts.
 *
 * Exported API expected by bot.js:
 *   checkAndHandle(ev, ctx, cfg) -> true if it acted (warned/deleted), else false
 *
 * ev:  { text, userLogin, userId, channelId, messageId, isMod, isBroadcaster }
 * ctx: { helix, getBotToken, clientId, broadcasterUserId, botUserId, say(text), reply(text, parentId), generalCfg() }
 * cfg: bot-general-config.json -> moderation.linkGuard (may be null/undefined)
 */

const store = require('./permit-store');

// very forgiving matcher: scheme-less domains, with or without paths
const URLish = /(?:(?:https?:\/\/)?(?:www\.)?)([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/\S*)?/i;

function extractHost(s) {
  const text = String(s || '');
  const m = text.match(URLish);
  if (!m) return null;
  // normalize: strip leading www.
  const host = String(m[1] || '').toLowerCase();
  return host.replace(/^www\./, '');
}

async function deleteMessage(ev, ctx) {
  if (!ev?.messageId) return false;
  try {
    const token = await ctx.getBotToken();
    const q = new URLSearchParams({
      broadcaster_id: ctx.broadcasterUserId,
      moderator_id:   ctx.botUserId,
      message_id:     ev.messageId
    }).toString();
    const res = await ctx.helix(`/moderation/chat?${q}`, {
      method: 'DELETE',
      token
    });
    if (res.status === 204) {
      if (process.env.LINKGUARD_DEBUG) console.log('[LG] deletemsg 204 ok');
      return true;
    }
    const txt = await res.text().catch(() => '');
    console.warn('[LG] deletemsg', res.status, txt);
  } catch (e) {
    console.warn('[LG] deletemsg err', e.message || e);
  }
  return false;
}

module.exports = {
  async checkAndHandle(ev, ctx, cfg) {
    if (!cfg || cfg.enabled === false) return false;

    if (process.env.LINKGUARD_DEBUG) {
      try { console.log('[LG] routeChat start', { text: ev?.text, user: ev?.userLogin }); } catch {}
    }

    // skip broadcaster/mods completely
    if (ev?.isBroadcaster || ev?.isMod) {
      if (process.env.LINKGUARD_DEBUG) console.log('[LG] skip privileged', ev.userLogin);
      return false;
    }

    const text = String(ev?.text || '');
    if (!text) return false;

    // Extract/normalize host
    const rawHost = extractHost(text);
    if (!rawHost) return false;

    // permit bypass
    if (store.isPermitted(ev.channelId, ev.userLogin)) {
      if (process.env.LINKGUARD_DEBUG) console.log('[LG] permit bypass', ev.userLogin);
      return false;
    }

    // Whitelist
    const wl = (cfg.whitelistHosts || []).map(h => String(h || '').toLowerCase());
    const host = rawHost.replace(/^www\./, '');
    const isWhitelisted = wl.some(w => host === w || host.endsWith('.' + w));
    if (isWhitelisted) {
      if (process.env.LINKGUARD_DEBUG) console.log('[LG] whitelisted host', host);
      return false;
    }

    // At this point we’re going to warn + delete
    if (process.env.LINKGUARD_DEBUG) console.log('[LG] flag', { from: ev.userLogin, host: host, text });

    // Prefer threaded reply to avoid "cannot be replied to" after deletion.
    let warnMsg = String(cfg.warnTemplate || '@{login} links aren’t allowed. Ask a mod for !permit.')
      .replace(/{login}/g, ev.userLogin);

    // When replying in thread, the UI already indicates who we replied to.
    // If the template starts with "@login", strip it to avoid a doubled mention.
    warnMsg = warnMsg.replace(new RegExp(`^@${ev.userLogin}\\b\\s*`, 'i'), '');

    // Try to send the threaded warning first
    let warned = false;
    try {
      await ctx.reply(warnMsg, ev.messageId);
      warned = true;
      if (process.env.LINKGUARD_DEBUG) console.log('[LG] warn sent', { to: ev.userLogin, threaded: true });
    } catch {
      // Fallback: non-threaded message
      try {
        await ctx.say(`@${ev.userLogin} ${warnMsg}`);
        warned = true;
        if (process.env.LINKGUARD_DEBUG) console.log('[LG] warn sent', { to: ev.userLogin, threaded: false });
      } catch {}
    }

    // Delete the offending message (best-effort)
    await deleteMessage(ev, ctx);

    return warned; // acted
  }
};
