# SpiffyOS Twitch Bot

[![Tag](https://img.shields.io/github/v/tag/spff-dev/twitchbot?label=tag)](https://github.com/spff-dev/twitchbot/tags)
[![Issues](https://img.shields.io/github/issues/spff-dev/twitchbot)](https://github.com/spff-dev/twitchbot/issues)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518.x-brightgreen)](#environment)
[![Platform](https://img.shields.io/badge/platform-Linux-lightgrey?logo=linux)](#environment)
[![Process Manager](https://img.shields.io/badge/process%20manager-PM2-lightgrey)](https://pm2.keymetrics.io/)
[![Twitch EventSub](https://img.shields.io/badge/twitch-EventSub-9146FF)](https://dev.twitch.tv/docs/eventsub/)
[![DB](https://img.shields.io/badge/db-better--sqlite3-green)](https://github.com/WiseLibs/better-sqlite3)
[![SQLite](https://img.shields.io/badge/sqlite-WAL%20mode-informational)](#database)
[![PRs](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/spff-dev/twitchbot/pulls)

A lightweight Twitch bot for a single channel that reads chat via EventSub, sends chat via Helix, and logs usage into SQLite. It is config first, JSON only, and production friendly on a small VPS.

## Table of contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
  - [Commands JSON](#commands-json)
  - [General JSON](#general-json)
  - [Enable boot greeting](#enable-boot-greeting)
- [Commands model](#commands-model)
- [Webhook](#webhook)
- [Health checks](#health-checks)
- [Database](#database)
  - [Backups](#backups)
- [Runtime with PM2](#runtime-with-pm2)
- [Scripts](#scripts)
- [Environment](#environment)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Features

- Reads chat via EventSub channel.chat.message delivered to your webhook.
- Sends chat via Helix POST /helix/chat/messages using an App token.
- JSON only configuration. No JS config files.
- Commands are modular. Each commands/*.js exports logic and defaults. The JSON file is the source of truth at runtime.
- SQLite via better-sqlite3 with WAL enabled and a busy timeout. Counts and per stream usage tracking.
- Built in announcements with online only option that respects the channel live status.
- Boot greeting, rate limits, role checks, aliases, and templated responses.
- PM2 ready: bot, webhook, and a rotating backup cron job.

## Architecture

ASCII sketch of the data flow.

```
Twitch EventSub -> HTTPS (your domain)
                   |
                   v
            scripts/twitch-webhook.js
                   |
                   |  HTTP POST raw JSON
                   v
        bot.js local intake http://127.0.0.1:18082/_intake/chat
                   |
            command router + DB logging
                   |
          Helix POST /helix/chat/messages
                   |
                   v
                 Twitch chat
```

## Quick start

```
cp .env.example .env   # fill in secrets
node scripts/migrate.js
pm2 start bot.js --name twitchbot
pm2 start scripts/twitch-webhook.js --name twitchhook

# create EventSub chat subscription if you have not already
node scripts/ensure-chat-webhook.js
```

## Configuration

All runtime configuration lives in two JSON files. The bot seeds defaults automatically but the JSON is authoritative at runtime.

### Commands JSON

`config/bot-commands-config.json`

Structure per command:

```jsonc
{
  "commands": {
    "ping": {
      "aliases": ["p"],
      "roles": ["everyone"],          // everyone, mod, owner
      "cooldownSeconds": 3,           // global cooldown per command
      "limitPerUser": 2,              // per stream usage limit, 0 means unlimited
      "replyToUser": true,            // reply to the triggering message if available
      "failSilently": true,           // if false, prints cooldown or forbidden messages
      "response": "pong ({latency}ms)"
    }
  }
}
```

### General JSON

`config/bot-general-config.json`

```json
{
  "announcements": {
    "enabled": false,
    "onlineOnly": true,
    "intervalSeconds": 600,
    "messages": [
      "Remember to follow",
      "Check out the socials"
    ]
  },
  "greeter": {
    "bootGreeting": {
      "enabled": false,
      "message": "I am online",
      "delayMs": 1500,
      "minIntervalSec": 900
    }
  },
  "templates": {
    "follow": "Thanks for the follow, {user}!",
    "sub": "Thanks for the sub, {user}!",
    "resub": "Thanks for resubbing, {user}!",
    "subgift": "{user} gifted subs, thank you!",
    "bits": "Thanks for the bits, {user}!"
  }
}
```

### Enable boot greeting

```
jq '.greeter.bootGreeting.enabled=true' config/bot-general-config.json | sponge config/bot-general-config.json
pm2 restart twitchbot
```

## Commands model

Each file in `commands/` exports logic only and an optional defaults block to seed the JSON. At runtime, the router uses only the JSON. The command can return variables for templating and optionally force reply to thread.

Example module:

```js
// commands/ping.js
module.exports = {
  name: 'ping',
  defaults: {
    aliases: [],
    roles: ['everyone'],
    cooldownSeconds: 3,
    limitPerUser: 2,
    replyToUser: true,
    failSilently: true,
    response: 'pong ({latency}ms)'
  },
  run: async (ctx) => {
    const latency = Math.floor(Math.random() * 10) + 20;
    return { vars: { latency } };
  }
};
```

Router rules:

- If a response string exists in JSON, it is used. Text returned by run is ignored.
- run may return { vars, reply } to supply template variables and override reply to thread behavior.
- Cooldowns are global per command. Per user per stream limits are enforced in SQLite.
- Role checks support everyone, mod, owner.

## Webhook

`scripts/twitch-webhook.js` verifies Twitch signatures, handles callback verification, and forwards raw notifications to the bot intake at `http://127.0.0.1:18082/_intake/chat` with header `X-Intake-Secret`. The webhook exposes a simple `GET /healthz` that does not touch SQLite:

```json
{ "status": "ok", "pid": 1234, "hostname": "...", "uptimeSec": 42, "startedAt": "...", "lastEventAt": "...", "eventsReceived": 12 }
```

## Health checks

- Webhook: `GET http://127.0.0.1:18081/healthz`
- Bot: tail PM2 logs for `[INTAKE] listening`, `[AUTH] app token pre-warmed`, `[EVT] open`, and `[ANN] timer started`

## Database

- File: `data/bot.db`
- Mode: WAL, synchronous normal, busy timeout 5000 ms
- Tables: `command_usage`, `message_counts`, `permits`, `streams`, `users`, `meta`

Migration and probes:

```
node scripts/migrate.js
node scripts/probe-db.js   # prints {"journal_mode":"wal","busy_timeout":5000}
```

### Backups

A simple gzip plus sha256 job with rotation.

```
pm2 start scripts/db-backup.js --name twitchbot-db-backup --cron "7 3 * * *" --time
pm2 save

# on demand
node scripts/db-backup.js
ls -lh backups
```

## Runtime with PM2

```
pm2 start bot.js --name twitchbot
pm2 start scripts/twitch-webhook.js --name twitchhook
pm2 logs twitchbot --lines 50
pm2 logs twitchhook --lines 50
pm2 save
```

## Scripts

- `scripts/migrate.js` initializes or upgrades the SQLite schema.
- `scripts/ensure-chat-webhook.js` ensures EventSub channel.chat.message is subscribed to your webhook.
- `scripts/list-eventsubs.js` audits EventSub subscriptions.
- `scripts/check-config.js` verifies JSON configs exist and parse.
- `scripts/checkpoint.js` optional local sanity checker.
- `scripts/probe-db.js` prints journal mode and busy timeout.
- `scripts/db-backup.js` creates compressed backups and rotates old ones.

## Environment

Required variables:

- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `BROADCASTER_USER_ID`
- `BOT_USER_ID`
- `WEBHOOK_SECRET` length 16 or more

Useful variables:

- `CMD_PREFIX` default "!"
- `INTAKE_PORT` default 18082

## Roadmap

- Link guard with `!permit user [minutes]`
- First time chat greeter and first time this stream greeter
- Stats like top chatter and most used commands
- Shoutout enhancements and buddy auto SO list

## Contributing

PRs are welcome. Please keep changes small and focused. If you are adding a command, export a defaults block so it auto seeds the JSON on boot.

## License

MIT
