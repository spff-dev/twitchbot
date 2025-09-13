'use strict';

/**
 * In-memory, channel-scoped permit store (shared singleton via Node's require cache).
 * API intentionally generous with method names to match any earlier usage.
 */

const byChannel = new Map(); // channelId -> Map<login, expiryTsMs>

function nowMs() { return Date.now(); }

function _getMap(channelId) {
  const id = String(channelId || '');
  let m = byChannel.get(id);
  if (!m) { m = new Map(); byChannel.set(id, m); }
  return m;
}

function grant(channelId, login, ttlSec) {
  const id = String(channelId || '');
  const who = String(login || '').toLowerCase();
  const sec = Math.max(1, Number(ttlSec || 0));
  const until = nowMs() + sec * 1000;
  _getMap(id).set(who, until);
}

function isPermitted(channelId, login) {
  const id = String(channelId || '');
  const who = String(login || '').toLowerCase();
  const m = byChannel.get(id);
  if (!m) return false;
  const until = m.get(who) || 0;
  if (until <= nowMs()) {
    if (until) m.delete(who);
    return false;
  }
  return true;
}

function prune() {
  const t = nowMs();
  for (const [id, m] of byChannel) {
    for (const [who, until] of m) {
      if (until <= t) m.delete(who);
    }
    if (!m.size) byChannel.delete(id);
  }
}

// Provide multiple aliases so any previous code keeps working
module.exports = {
  grant,
  permit: grant,
  add: grant,
  allow: grant,
  set: grant,
  isPermitted,
  has: isPermitted,
  check: isPermitted,
  prune,
};
