module.exports = {
  name: 'rust',
  description: 'Rusty Horizons info',
  permission: 'everyone',
  cooldownSec: 30,
  async run(ctx) {
    return ctx.say("Did you know I run a community Rust server? Rusty Horizons is an allow-listed PVE-focused streamer-friendly Rust server. For more info on how to join go here https://www.rustyhorizons.uk/");
  }
};
