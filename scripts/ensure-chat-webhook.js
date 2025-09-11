'use strict';

require('dotenv').config();
const fetch = global.fetch;

const CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';
const CALLBACK = process.env.WEBHOOK_URL || '';
const SECRET = process.env.WEBHOOK_SECRET || '';
const BC_ID = process.env.BROADCASTER_USER_ID || '';
const BOT_ID = process.env.BOT_USER_ID || '';

function die(msg, code = 1) { console.error('[ENSURE]', msg); process.exit(code); }
async function appToken() {
  const r = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  if (!r.ok) die('app token failed ' + r.status);
  const j = await r.json();
  return j.access_token;
}

async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) die('missing client id or secret');
  if (!CALLBACK || !SECRET) die('missing WEBHOOK_URL or WEBHOOK_SECRET');
  if (!BC_ID || !BOT_ID) die('missing BROADCASTER_USER_ID or BOT_USER_ID');

  const tok = await appToken();

  // list current subs for this type
  const list = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions?type=channel.chat.message', {
    headers: { 'Client-Id': CLIENT_ID, 'Authorization': 'Bearer ' + tok }
  });
  if (!list.ok) die('list failed ' + list.status);
  const js = await list.json();

  const mine = (js.data || []).filter(s =>
    s.transport?.method === 'webhook' &&
    String(s.transport?.callback || '') === String(CALLBACK) &&
    s.condition?.broadcaster_user_id === String(BC_ID) &&
    s.condition?.user_id === String(BOT_ID)
  );

  const enabled = mine.find(s => s.status === 'enabled');
  if (enabled) {
    console.log('[ENSURE] ok id=' + enabled.id + ' status=' + enabled.status);
    return;
  }

  // create one
  const payload = {
    type: 'channel.chat.message',
    version: '1',
    condition: { broadcaster_user_id: String(BC_ID), user_id: String(BOT_ID) },
    transport: { method: 'webhook', callback: String(CALLBACK), secret: String(SECRET) }
  };

  const cre = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    method: 'POST',
    headers: { 'Client-Id': CLIENT_ID, 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const txt = await cre.text();
  if (!cre.ok) die('create failed ' + cre.status + ' ' + txt);

  const cj = txt ? JSON.parse(txt) : { data: [] };
  const row = (cj.data || [])[0] || {};
  console.log('[ENSURE] created id=' + (row.id || '-') + ' status=' + (row.status || '-'));
}
main().catch(e => die(e.message || String(e)));
