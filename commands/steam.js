module.exports = {
  name: 'steam',
  description: 'Send Steam profile url',
  permission: 'everyone',
  cooldownSec: 15,
  async run(ctx) {
    return ctx.replyThread("Spiff's Steam profile is: https://steamcommunity.com/id/spiffgg/");
  }
};
