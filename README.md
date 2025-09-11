# SpiffyOS Twitch Bot

A lightweight Twitch bot for a single channel that:
- Reads chat via EventSub (channel.chat.message) delivered to your webhook.
- Sends chat via Helix `POST /helix/chat/messages` with an App token.
- Uses SQLite (better-sqlite3) for counts and command usage.
- Is configured by JSON only (no JS configs).
- Runs under PM2 (bot process + webhook process + optional backup cron job).

## Quick start

```bash
cp .env.example .env   # fill in secrets
node scripts/migrate.js
pm2 start bot.js --name twitchbot
pm2 start scripts/twitch-webhook.js --name twitchhook
```

EventSub must be subscribed to `channel.chat.message` pointing at `https://YOUR_DOMAIN/hooks/twitchbot`. Use `scripts/ensure-chat-webhook.js` to create it, or `scripts/list-eventsubs.js` to audit.

## Configuration (JSON only)

All runtime configuration lives in two files:

- `config/bot-commands-config.json` - the single source of truth for every command.
  - Keys per command: `aliases`, `roles`, `cooldownSeconds`, `limitPerUser`, `replyToUser`, `failSilently`, `response`.
  - On boot, the bot loads `commands/*.js` and auto-seeds missing blocks from `module.exports.defaults`. At runtime the JSON is authoritative.
- `config/bot-general-config.json` - announcements, greeter, and event templates.
  - `announcements`: `{ enabled, onlineOnly, intervalSeconds, messages[] }`
  - `greeter.bootGreeting`: `{ enabled, message, delayMs, minIntervalSec }`
  - `templates`: `{ follow, sub, resub, subgift, bits }`

### Enable boot greeting
```bash
# enable once, then restart
jq '.greeter.bootGreeting.enabled=true' config/bot-general-config.json | sponge config/bot-general-config.json
pm2 restart twitchbot
```

## Commands model

Each file in `commands/` exports logic only and an optional `defaults` block to seed config. Example:

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
  run: async () => {
    const latency = Math.floor(Math.random() * 10) + 20;
    return { vars: { latency } }; // variables only; wording is from JSON
  }
};
```

Router rules:
- If `response` exists in JSON, it is used and any text returned by `run()` is ignored.
- `run()` may return `{ vars, reply }` to supply template variables and override reply-to-thread behavior.
- Cooldowns are global per command. Per-user per-stream limits are enforced via the database.

## Webhook

`scripts/twitch-webhook.js` verifies Twitch signatures, handles verification, and forwards raw notifications to the bot's local intake at `http://127.0.0.1:18082/_intake/chat`. Its `/healthz` endpoint does not touch SQLite.

## Health checks

- Webhook: `GET http://127.0.0.1:18081/healthz` -> `{ status, pid, hostname, uptimeSec, startedAt, lastEventAt, eventsReceived }`
- Bot: tail PM2 logs for `[INTAKE] listening`, `[EVT] open`, `[AUTH] app token pre-warmed`, and `[ANN] timer started`.

## Database

- SQLite file: `data/bot.db` (journal_mode=WAL, busy_timeout=5000).
- Tables: `command_usage`, `message_counts`, `permits`, `streams`, `users`, `meta`.
- Migration: `node scripts/migrate.js`
- Probe: `node scripts/probe-db.js` -> prints `{ "journal_mode": "wal", "busy_timeout": 5000 }`

Backups:
- Script: `scripts/db-backup.js` (writes `backups/bot.db.YYYYMMDDTHHMMSSZ.gz` + `.sha256`, rotates, KEEP=14).
- PM2 cron: `pm2 start scripts/db-backup.js --name twitchbot-db-backup --cron "7 3 * * *" --time`

## Intake path

The bot exposes a local intake at `/_intake/chat` on port 18082. The webhook posts the exact raw EventSub body to this intake with header `X-Intake-Secret` equal to your `WEBHOOK_SECRET`.

## Environment

Required:
- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `BROADCASTER_USER_ID`
- `BOT_USER_ID`
- `WEBHOOK_SECRET` (>= 16 chars)

Useful:
- `CMD_PREFIX` (default `!`)
- `INTAKE_PORT` (default `18082`)

## PM2 tips

```bash
pm2 logs twitchbot --lines 50
pm2 restart twitchbot
pm2 save
```

## License

MIT

