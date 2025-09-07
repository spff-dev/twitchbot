# SpiffyOS - Twitch Chat Bot

A self-hosted Twitch bot for the `spiffgg` channel. Built on Node.js with IRC (tmi.js) plus EventSub WebSocket for subs/bits/follows/ads, with auto-refreshing OAuth tokens, timed announcements, and hot-reloadable commands.

## Features
- **Chat commands**: `!ping`, `!help`, `!time`, `!xmas`, `!lurk`, `!uptime`, `!title`, `!game`, `!clip`, `!nextad`, `!test_ads`, `!so`, `!so2`, `!reload` (and more in `/commands`).
- **Shoutouts**: Official `/helix/chat/shoutouts` + an announcement variant with best-effort game detection.
- **EventSub**: Follows, subs, resubs, gift subs, bits, and **ad start** detection.
- **Ads flow**: 60s “ads due” warning (from ad schedule), banner on start, banner on end.
- **Timed announcements**: Configurable messages at intervals, live-only by default.
- **Threaded replies**: Real “reply to message” via `/helix/chat/messages`.

## Requirements
- **Node.js 18+** (uses global `fetch`)
- **PM2** (optional, for service management)
- A Twitch application (Client ID/Secret) and two OAuth tokens:
  - **Bot account user token** (`TWITCH_REFRESH_TOKEN`) with chat/mod scopes
  - **Broadcaster user token** (`BROADCASTER_REFRESH_TOKEN`) with channel scopes

## Setup
```bash
git clone git@github.com:spff-dev/twitchbot.git
cd twitchbot
npm install

# configure environment
cp .env.example .env
# fill out the values in .env

# run (PM2)
pm2 start bot.js --name twitchbot
pm2 save
