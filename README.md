# SpiffyOS Twitch Bot

A production chat bot for Twitch channels.

Version: v1.1.0

## What changed in v1.1.0

- No IRC or tmi.js. All chat sends use Helix Chat Messages API.
- Chat reads use EventSub channel.chat.message via webhook transport.
- Bot messages show the Chat Bot badge.
- Bot appears under Chat Bots in the Users in Chat list.
- Existing features preserved: shoutouts, raid auto shoutout banner, ads prewarning and end banners, bits and sub announcements with anti spam, timed announcements, threaded replies, help, ping, title, game, uptime, time, clip, xmas, lurk, reload, cfgreload, reloadable JSONC configs.
- Three EventSub sessions:
  - Webhook: channel.chat.message (reads chat)
  - WebSocket Broadcaster: subs, sub messages, gifts, cheers, ad breaks, raids
  - WebSocket Bot: follows
- App token cache helper for Helix calls.

## Requirements

- Node.js 18+ and npm
- Debian or similar Linux
- PM2 for process management
- Nginx (or any reverse proxy) for webhook TLS termination

## Repository layout

- bot.js - main process, command router, Helix send, configs, intake for webhook
- lib/eventsub.js - EventSub over WebSocket for BC and BOT sessions
- lib/apptoken.js - app access token mint and cache
- commands/ - command modules
- config/templates.jsonc - event copy (JSON with comments)
- config/commands.json - command metadata and greeting
- config/announcements.js - timed announcements
- scripts/twitch-webhook.js - local HTTP server that verifies Twitch signatures and forwards to bot intake
- scripts/ensure-chat-webhook.js - creates or verifies the chat webhook subscription

## Environment

Create .env containing:

```
BOT_USERNAME=bot_username
CHANNELS=#your_twitch_channel
TWITCH_CLIENT_ID=your_client_id
TWITCH_CLIENT_SECRET=your_client_secret
BOT_REFRESH_TOKEN=bot_refresh_token_with_user:bot
BROADCASTER_REFRESH_TOKEN=broadcaster_refresh_token_with_channel:bot
CMD_PREFIX=!

BROADCASTER_USER_ID=broadcaster_user_id 
BOT_USER_ID=bot_user_id

WEBHOOK_URL='https://your.domain/hooks/twitchbot'
WEBHOOK_SECRET='64+ byte random string'
INTAKE_SECRET='same_as_WEBHOOK_SECRET_or_another_secret'
```

## One time OAuth grants

Required on the Twitch application:
- channel:bot authorized by the broadcaster account
- user:bot authorized by the bot account

Authorize in a browser with response_type=code and your registered redirect URL:

```
https://id.twitch.tv/oauth2/authorize?client_id=CLIENT_ID&redirect_uri=REDIRECT&response_type=code&scope=channel:bot&force_verify=true
https://id.twitch.tv/oauth2/authorize?client_id=CLIENT_ID&redirect_uri=REDIRECT&response_type=code&scope=user:bot&force_verify=true
```

Exchange the code for a refresh token (never paste real tokens publicly):

```
curl -s -X POST https://id.twitch.tv/oauth2/token   -d client_id=$CLIENT_ID   -d client_secret=$CLIENT_SECRET   -d code=$CODE_FROM_BROWSER   -d grant_type=authorization_code   -d redirect_uri=$REDIRECT
```

Store the refresh_token values in .env as BOT_REFRESH_TOKEN and BROADCASTER_REFRESH_TOKEN.

## Derive numeric user IDs with an app token

After you have a valid app token, resolve IDs with Helix users endpoint:

```
APP="$(curl -s -X POST https://id.twitch.tv/oauth2/token   -d client_id=$CLIENT_ID   -d client_secret=$CLIENT_SECRET   -d grant_type=client_credentials | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')"

BOT_LOGIN="$(sed -n 's/^BOT_USERNAME=\(.*\)$/\1/p' .env | tr A-Z a-z)"
FIRST_CHANNEL="$(sed -n 's/^CHANNELS=\(.*\)$/\1/p' .env | cut -d',' -f1)"
BROADCASTER_LOGIN="$(printf %s "$FIRST_CHANNEL" | sed 's/^#//' | tr A-Z a-z)"

BOT_USER_ID="$(curl -s -H "Client-Id: $CLIENT_ID" -H "Authorization: Bearer $APP"   "https://api.twitch.tv/helix/users?login=$BOT_LOGIN" | sed -n 's/.*"id":"\([0-9]\+\)".*/\1/p')"

BROADCASTER_USER_ID="$(curl -s -H "Client-Id: $CLIENT_ID" -H "Authorization: Bearer $APP"   "https://api.twitch.tv/helix/users?login=$BROADCASTER_LOGIN" | sed -n 's/.*"id":"\([0-9]\+\)".*/\1/p')"

printf "\nBROADCASTER_USER_ID='%s'\nBOT_USER_ID='%s'\n" "$BROADCASTER_USER_ID" "$BOT_USER_ID" >> .env
```

## Webhook transport and reverse proxy

Expose a TLS URL that forwards to the local verifier.

Nginx example:

```
location /hooks/twitchbot {
  proxy_pass http://127.0.0.1:18081/hooks/twitchbot;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_set_header X-Forwarded-Proto https;
}
```

Start the verifier forwarder:

```
pm2 start scripts/twitch-webhook.js --name twitchhook
pm2 logs twitchhook --lines 10
```

Set INTAKE_URL and INTAKE_SECRET if you override defaults. By default, the forwarder posts to http://127.0.0.1:18082/_intake/chat and sends X-Intake-Secret if INTAKE_SECRET is set.

## Ensure the chat webhook subscription exists

```
node scripts/ensure-chat-webhook.js
```

You should see either:
- [ENSURE] ok id=... status=enabled
- or [ENSURE] created id=... status=webhook_callback_verification_pending followed by verification in logs and then enabled.

## Running the bot

Install dependencies and start:

```
npm ci
pm2 start bot.js --name twitchbot
pm2 logs twitchbot --lines 20
```

You should see:
- [INTAKE] listening 127.0.0.1:18082
- [EVT/BC] subscribed ...
- [EVT/BOT] subscribed ...
- [SEND] ok
- [BOOT] greeted

## How sending works

All sends use Helix POST /helix/chat/messages with an App Access Token and include:
- broadcaster_id from .env
- sender_id from .env

This produces the Chat Bot badge.

## How reading works

All chat reads come from EventSub channel.chat.message using webhook transport with an app token and condition including:
- broadcaster_user_id
- user_id

This places the bot under the Chat Bots section in the Users in Chat list.

## Commands and configs

Command metadata and greeting live in config/commands.json. Event copy lives in config/templates.jsonc. Timed announcements live in config/announcements.js.

Hot reload:
- !reload - reload command modules
- !cfgreload - reload configs and restart announcements

## Development guard rails

- Pre commit hook runs config checker
- JSONC is used for templates
- Logging is terse and grep friendly

## Troubleshooting

- If you see duplicate replies, ensure the APP WebSocket chat subscription is disabled and only the webhook is active.
- Verify the webhook forwarder logs 204 when forwarding to intake.
- Verify one enabled channel.chat.message subscription with method=webhook.

