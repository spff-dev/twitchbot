#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fetch = global.fetch || require('node-fetch'); // node 18+ has fetch; fallback for older

const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env;
if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
  console.error('Missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET in .env');
  process.exit(1);
}

async function main() {
  const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok) {
    console.error('Token error:', tokenJson);
    process.exit(1);
  }
  const appToken = tokenJson.access_token;

  const subsRes = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
    headers: {
      'Client-Id': TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${appToken}`
    }
  });
  const subsJson = await subsRes.json();
  if (!subsRes.ok) {
    console.error('List error:', subsJson);
    process.exit(1);
  }

  const rows = (subsJson.data || []).map(s => ({
    id: s.id,
    type: s.type,
    status: s.status,
    method: s.transport?.method,
    callback: s.transport?.callback
  }));
  console.table(rows);
  const hasChatWebhook = rows.some(r => r.type === 'channel.chat.message' && r.method === 'webhook' && r.status === 'enabled');
  console.log('chatWebhookEnabled:', hasChatWebhook);
}

main().catch(e => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
