module.exports = {
  apps: [
    {
      name: "twitchbot",
      script: "bot.js",
      cwd: "/srv/bots/twitchbot",
      watch: false,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
}
