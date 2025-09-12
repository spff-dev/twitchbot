'use strict';

/**
 * Router: config-first command execution.
 * - Supports manifest commands (files in commands/**) and
 *   config-only static commands (kind: "static" in config).
 * - Centralizes roles, cooldowns, per-user/stream limits, usage logging.
 * - Rendering:
 *     - Normally use meta.response with tokens
 *     - result.message → bypass template with exact string
 *     - result.template → override template for this run (e.g., offline/error)
 * - Actions: announce, shoutout (best-effort; errors are warned, not fatal)
 */

function render(str, tokens) {
  const all = tokens || {};
  return String(str || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => {
    const v = all[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

function createRouter(opts) {
  const {
    registry, aliasMap, config,
    db, sendChat,
    getAppToken, getBroadcasterToken, getBotToken,
    helix, broadcasterUserId, botUserId,
    cmdPrefix
  } = opts;

  // DB statements
  const STMT_USAGE = db.prepare(`
    INSERT INTO command_usage(ts, stream_id, user_id, login, command, ok, reason, message_id)
    VALUES (?, 0, ?, ?, ?, ?, ?, ?)
  `);

  // Cooldowns (global per command name)
  const cooldowns = new Map();
  const cdLeft = (name) => {
    const now = Date.now();
    const until = cooldowns.get(name) || 0;
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  };
  const setCd = (name, secs) => { if (secs) cooldowns.set(name, Date.now() + secs * 1000); };

  // Side effects (best-effort)
  async function runActions(actions, ctx) {
    if (!Array.isArray(actions)) return;
    for (const a of actions) {
      if (!a || typeof a !== 'object') continue;
      try {
        if (a.type === 'announce') {
          const botTok = await getBotToken();
          const q = `broadcaster_id=${ctx.channel.id}&moderator_id=${botUserId}`;
          await helix(`/chat/announcements?${q}`, {
            method: 'POST',
            token: botTok,
            json: { message: a.message, color: a.color || 'primary' }
          });
        } else if (a.type === 'shoutout') {
          const bcTok = await getBroadcasterToken();
          await helix('/chat/shoutouts', {
            method: 'POST',
            token: bcTok,
            json: {
              from_broadcaster_id: broadcasterUserId,
              to_broadcaster_id: a.toBroadcasterId,
              moderator_id: broadcasterUserId
            }
          });
        }
      } catch (e) {
        console.warn('[ACTION]', a.type, 'failed:', e.message);
      }
    }
  }

  async function handle(ev) {
    const text = (ev.text || '').trim();
    if (!text.startsWith(cmdPrefix)) return false;

    const parts = text.slice(cmdPrefix.length).trim().split(/\s+/);
    const rawName = (parts.shift() || '').toLowerCase();
    const canonical = aliasMap.get(rawName) || rawName;

    const meta = (config && config.commands && config.commands[canonical]) || null;

    // If we have no config block at all, this isn’t a known command
    if (!meta) return false;

    // Resolve entry:
    // - manifest (from registry), OR
    // - config-only static fallback (kind: "static" → synthetic manifest)
    let entry = registry.get(canonical);
    if (!entry) {
      const kind = (meta.kind || '').toLowerCase();
      if (kind === 'static' || (kind === '' && typeof meta.response === 'string')) {
        // synthetic no-op manifest: router will render meta.response
        entry = { manifest: { execute: async () => ({}) } };
      } else {
        // not static and no manifest file → not executable
        return false;
      }
    }

    // Context passed to commands
    const ctx = {
      user: { id: ev.userId, login: ev.userLogin, display: ev.userName },
      channel: { id: ev.channelId, login: ev.channelLogin },
      messageId: ev.messageId,
      isMod: !!ev.isMod, isBroadcaster: !!ev.isBroadcaster,
      prefix: cmdPrefix,
      getAppToken, getBroadcasterToken, getBotToken,
      helix,
      broadcasterUserId, botUserId
    };

    // Roles
    const roles = Array.isArray(meta.roles) ? meta.roles : ['everyone'];
    const isOwner = (ctx.isBroadcaster || ctx.isMod); // treat broadcaster/mod as elevated
    if (roles.includes('owner') && !isOwner) {
      STMT_USAGE.run(new Date().toISOString(), String(ev.userId||''), String(ev.userLogin||''), canonical, 0, 'forbidden', String(ev.messageId||''));
      if (!meta.failSilently) await sendChat('Not allowed.', { reply_parent_message_id: ev.messageId });
      return true;
    }
    if (roles.includes('mod') && !(ctx.isMod || ctx.isBroadcaster)) {
      STMT_USAGE.run(new Date().toISOString(), String(ev.userId||''), String(ev.userLogin||''), canonical, 0, 'forbidden', String(ev.messageId||''));
      if (!meta.failSilently) await sendChat('Mods only.', { reply_parent_message_id: ev.messageId });
      return true;
    }

    // Cooldown
    const left = cdLeft(canonical);
    if (left > 0) {
      STMT_USAGE.run(new Date().toISOString(), String(ev.userId||''), String(ev.userLogin||''), canonical, 0, 'cooldown', String(ev.messageId||''));
      if (!meta.failSilently) await sendChat(`Command on cooldown, wait ${left}s.`, { reply_parent_message_id: ev.messageId });
      return true;
    }

    // Per-user limit
    if ((meta.limitPerUser|0) > 0) {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM command_usage WHERE stream_id=0 AND user_id=? AND command=? AND ok=1`)
        .get(String(ev.userId||''), canonical);
      if ((row && row.c) >= (meta.limitPerUser|0)) {
        STMT_USAGE.run(new Date().toISOString(), String(ev.userId||''), String(ev.userLogin||''), canonical, 0, 'limit-user', String(ev.messageId||''));
        if (!meta.failSilently) await sendChat(`You've hit the per-user limit.`, { reply_parent_message_id: ev.messageId });
        return true;
      }
    }

    // Per-stream limit
    if ((meta.limitPerStream|0) > 0) {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM command_usage WHERE stream_id=0 AND command=? AND ok=1`)
        .get(canonical);
      if ((row && row.c) >= (meta.limitPerStream|0)) {
        STMT_USAGE.run(new Date().toISOString(), String(ev.userId||''), String(ev.userLogin||''), canonical, 0, 'limit-stream', String(ev.messageId||''));
        if (!meta.failSilently) await sendChat(`Stream limit reached.`, { reply_parent_message_id: ev.messageId });
        return true;
      }
    }

    // Execute command logic (manifest or synthetic static)
    let result = null;
    try {
      result = await entry.manifest.execute(ctx, parts, meta);
    } catch (e) {
      console.error('[CMD]', canonical, 'error:', e.message);
      STMT_USAGE.run(new Date().toISOString(), String(ev.userId||''), String(ev.userLogin||''), canonical, 0, 'error', String(ev.messageId||''));
      return true;
    }

    // Optional side-effects
    await runActions(result && result.actions, ctx);

    // Tokens for render (command vars override base chat tokens)
    const vars  = (result && result.vars) || {};
    const reply = (result && typeof result.reply === 'boolean') ? result.reply : !!meta.replyToUser;

    const tokens = {
      login: ev.userLogin || '',
      displayName: ev.userName || '',
      channelLogin: ev.channelLogin || '',
      ...vars
    };

    // Rendering decision
    const configured = String(meta.response || '{out}');
    const templateOverride = typeof result?.template === 'string' ? result.template : null;
    const messageOverride  = typeof result?.message  === 'string' ? result.message  : null;

    let rendered = '';
    if (messageOverride) {
      rendered = messageOverride;
    } else {
      const templateToUse = templateOverride || configured;
      rendered = render(templateToUse, tokens);
      // Fallback: if template renders empty but vars.out exists, say {out}
      if ((!rendered || rendered.trim() === '') && vars.out != null) {
        rendered = String(vars.out);
      }
    }

    if (!result || result.suppress !== true) {
      if (rendered && rendered.trim() !== '') {
        if (reply) await sendChat(rendered, { reply_parent_message_id: ev.messageId });
        else await sendChat(rendered);
      } else {
        console.warn('[ROUT] empty render for command:', canonical);
      }
    }

    if (meta.cooldownSeconds) setCd(canonical, meta.cooldownSeconds);
    STMT_USAGE.run(new Date().toISOString(), String(ev.userId||''), String(ev.userLogin||''), canonical, 1, null, String(ev.messageId||''));
    return true;
  }

  return { handle };
}

module.exports = { createRouter };
