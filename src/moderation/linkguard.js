'use strict';

const { URL } = require('url');
const path = require('path');
const { openDB } = require('../core/db.js');

const BOT_USER_ID = String(process.env.BOT_USER_ID || '');
const DEBUG = process.env.LINKGUARD_DEBUG === '1';

function db() {
  return openDB(path.join(__dirname, '..', '..', 'data', 'bot.db'));
}

function dlog(...a) { if (DEBUG) console.log('[LG]', ...a); }

/**
 * Extract links from a chat line.
 * - Matches http/https URLs
 * - Also matches bare www.* and normalizes them to http://
 */
function extractLinks(text) {
  const found = new Set();

  // http(s) URLs
  const reHttp = /\bhttps?:\/\/[^\s)]+/gi;
  for (const m of text.matchAll(reHttp)) found.add(m[0]);

  // www.* forms
  const reWww = /\bwww\.[^\s)]+/gi;
  for (const m of text.matchAll(reWww)) {
    const s = m[0].startsWith('http') ? m[0] : `http://${m[0]}`;
    found.add(s);
  }

  return Array.from(found);
}

function hostAllowed(u, whitelist) {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return whitelist.some(w => h === w || h.endsWith('.' + w));
  } catch { return false; }
}

function hasPermit(userId) {
  const now = Math.floor(Date.now() / 1000);
  const row = db().prepare(
    `SELECT 1 FROM permits WHERE user_id=? AND expires_at>? LIMIT 1`
  ).get(userId, now);
  return !!row;
}

function addPermit({ userId, login, ttlSec, grantedBy }) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.max(1, Number(ttlSec || 180));
  db().prepare(
    `INSERT INTO permits(user_id, login, expires_at, granted_by) VALUES(?,?,?,?)`
  ).run(String(userId || ''), String(login || '').toLowerCase(), exp, String(grantedBy || ''));
  return exp;
}

function logEvent({ type, userId, login, messageId, action, reason }) {
  db().prepare(
    `INSERT INTO moderation_events(type,user_id,login,message_id,action,reason) VALUES(?,?,?,?,?,?)`
  ).run(type, userId || null, login || null, messageId || null, action || null, reason || null);
}

async function deleteMessage({ helix, getBotToken, channelId, messageId }) {
  if (!messageId || !BOT_USER_ID) return false;
  try {
    const tok = await getBotToken();
    const q = `broadcaster_id=${encodeURIComponent(channelId)}&moderator_id=${encodeURIComponent(BOT_USER_ID)}&message_id=${encodeURIComponent(messageId)}`;
    const res = await helix(`/moderation/chat?${q}`, { method: 'DELETE', token: tok });
    dlog('delete attempt status', res.status);
    return res.ok;
  } catch (e) {
    dlog('delete error', e.message || e);
    return false;
  }
}

/**
 * checkAndHandle(ev, ctx, cfg)
 *  - Returns true if Link Guard acted (deleted/warned), false to let command router continue.
 */
async function checkAndHandle(ev, ctx, cfg) {
  if (!cfg || !cfg.enabled) return false;
  if (!ev || !ev.text) return false;

  // never police the bot itself
  if (String(ev.userId || '') === BOT_USER_ID) return false;

  const links = extractLinks(ev.text);
  dlog('links:', links);
  if (!links.length) return false;

  // role bypass
  const allowedRoles = (cfg.allowedRoles || []).map(s => String(s).toLowerCase());
  const roleOK =
    (ev.isBroadcaster && (allowedRoles.includes('owner') || allowedRoles.includes('broadcaster'))) ||
    (ev.isMod && allowedRoles.includes('mod'));
  if (roleOK) { dlog('role bypass'); return false; }

  // whitelist
  const white = (cfg.whitelistHosts || []).map(s => s.toLowerCase());
  const allWhite = links.every(u => hostAllowed(u, white));
  if (allWhite) { dlog('whitelisted'); return false; }

  // temporary permit
  if (hasPermit(ev.userId)) { dlog('user permitted'); return false; }

  // moderation: delete & warn
  const deleted = await deleteMessage({
    helix: ctx.helix,
    getBotToken: ctx.getBotToken,
    channelId: ev.channelId,
    messageId: ev.messageId
  });

  const warn = String(cfg.warnTemplate || '@{login} links aren’t allowed. Ask a mod for !permit.');
  const login = ev.userLogin || ev.userName || 'friend';
  const msg = warn.replace(/@\{login\}/g, `@${login}`).replace(/\{login\}/g, login);

  try { await ctx.reply(msg, ev.messageId); } catch {}

  logEvent({
    type: 'link_guard',
    userId: ev.userId,
    login: ev.userLogin,
    messageId: ev.messageId,
    action: deleted ? 'delete' : 'warn-only',
    reason: 'link'
  });

  return true;
}

module.exports = { checkAndHandle, addPermit, hasPermit };
