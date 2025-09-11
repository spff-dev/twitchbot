'use strict';

/**
 * App Access Token cache for Chat Messages and EventSub chat
 */

let _appToken = null;
let _exp = 0;

const CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

function getClientId() {
  return CLIENT_ID;
}

async function getAppToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_appToken && _exp - now > 120) return _appToken;

  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error('[AUTH] app token failed', res.status, txt);
    throw new Error('app token failed');
  }
  const json = await res.json();
  _appToken = json.access_token;
  _exp = now + (json.expires_in || 0);
  console.log('[AUTH] app token minted');
  return _appToken;
}

function invalidate() {
  _appToken = null;
  _exp = 0;
}

module.exports = {
  getAppToken,
  getClientId,
  invalidate,
};
