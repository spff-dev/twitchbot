module.exports = {
  name: 'links',
  description: 'Send links urls',
  permission: 'everyone',
  cooldownSec: 30,
  async run(ctx) {
    return ctx.say("Spiff's links: https://spiff.gg/");
  }
};
