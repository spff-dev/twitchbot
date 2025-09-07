module.exports = {
  name: 'discord',
  description: 'Send link to the Discord',
  permission: 'everyone',
  cooldownSec: 30,
  async run(ctx) {
    return ctx.say("Join the Spiffcord! https://discord.gg/x65rDmMycn");
  }
};
