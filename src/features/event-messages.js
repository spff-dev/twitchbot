'use strict';

/**
 * Event-driven messages (follow, sub, resub, gift, bits, raid)
 * - Per-event enable flags under general config "events"
 * - Anonymous follow option
 * - Extra tokens where data exists
 *
 * Config keys expected in config/bot-general-config.json:
 * {
 *   "templates": { "follow": "...", "sub": "...", "resub": "...", "subgift": "...", "bits": "...", "raid": "..." },
 *   "events": {
 *     "follow":  { "enabled": true,  "anonymous": false, "anonymousName": "friend" },
 *     "sub":     { "enabled": true },
 *     "resub":   { "enabled": true },
 *     "subgift": { "enabled": true },
 *     "bits":    { "enabled": true },
 *     "raid":    { "enabled": true }
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

module.exports = function initEventMessages(deps) {
  const {
    generalCfgPath,   // absolute path to config/bot-general-config.json
    sendChat,         // async (text) => boolean
    helix,            // async helix(path, {method, token, json})
    getAppToken,      // async () => app access token
    broadcasterUserId // string
  } = deps;

  function loadCfg() {
    try {
      const raw = fs.readFileSync(generalCfgPath, 'utf8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  function render(tpl, tokens) {
    const all = tokens || {};
    return String(tpl || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => {
      const v = all[k];
      return v === undefined || v === null ? '' : String(v);
    });
  }

  function mapTier(raw) {
    const t = String(raw || '').toLowerCase();
    if (t === 'prime' || t === 'amazonprime' || t === 'primegaming') return 'Prime';
    if (t === '1000' || t === 'tier1' || t === '1' || t === 'tier 1') return 'Tier 1';
    if (t === '2000' || t === 'tier2' || t === '2' || t === 'tier 2') return 'Tier 2';
    if (t === '3000' || t === 'tier3' || t === '3' || t === 'tier 3') return 'Tier 3';
    return raw || '';
  }

  async function maybeSend(templateKey, tokens, eventKey) {
    const cfg = loadCfg();
    const enabled = !!(cfg.events && cfg.events[eventKey] && cfg.events[eventKey].enabled);
    if (!enabled) return;

    const tpl = cfg.templates && cfg.templates[templateKey];
    if (!tpl) return;

    const msg = render(tpl, tokens);
    if (!msg.trim()) return;

    try { await sendChat(msg); } catch {}
  }

  // If you later decide some events should be live-only, you can add a gate here.
  async function isLive() {
    try {
      const token = await getAppToken();
      const res = await helix(`/streams?user_id=${broadcasterUserId}`, { method: 'GET', token });
      if (!res.ok) return false;
      const j = await res.json();
      return Array.isArray(j.data) && j.data.length > 0;
    } catch {
      return false;
    }
  }

  // Handlers

  async function onFollow(ev) {
    const cfg = loadCfg();
    const followCfg = (cfg.events && cfg.events.follow) || {};
    const anon = !!followCfg.anonymous;
    const anonName = String(followCfg.anonymousName || 'friend');

    const user = anon ? anonName : (ev.userLogin || ev.userName || 'friend');

    await maybeSend('follow', { user }, 'follow');
  }

  async function onSub(ev) {
    // ev fields we will try to use if present:
    // ev.userLogin/userName, ev.tier, ev.plan, ev.cumulativeMonths, ev.months, ev.streakMonths
    const tokens = {
      user: ev.userLogin || ev.userName || 'friend',
      months: ev.cumulativeMonths || ev.months || ev.streakMonths || '',
      tier: mapTier(ev.tier || ev.plan)
    };
    await maybeSend('sub', tokens, 'sub');
  }

  async function onResub(ev) {
    const tokens = {
      user: ev.userLogin || ev.userName || 'friend',
      months: ev.cumulativeMonths || ev.months || '',
      streak: ev.streakMonths || ''
    };
    await maybeSend('resub', tokens, 'resub');
  }

  async function onSubGift(ev) {
    // ev may include: gifter info as userLogin/userName, total count or bundle size
    const tokens = {
      user: ev.userLogin || ev.userName || 'friend',
      count: ev.count || ev.total || ''
    };
    await maybeSend('subgift', tokens, 'subgift');
  }

  async function onCheer(ev) {
    // ev.bits or ev.bitsAmount is typical
    const tokens = {
      user: ev.userLogin || ev.userName || 'friend',
      bitsAmount: ev.bits || ev.bitsAmount || ''
    };
    await maybeSend('bits', tokens, 'bits');
  }

  async function onRaid(ev) {
    // Message template for raids in addition to your auto shoutout
    const tokens = {
      user: ev.fromLogin || ev.userLogin || ev.userName || 'friend',
      viewers: ev.viewers || ev.viewersCount || ''
    };
    await maybeSend('raid', tokens, 'raid');
  }

  return { onFollow, onSub, onResub, onSubGift, onCheer, onRaid };
};
