module.exports = {
  name: 'dbd',
  description: 'Send DBD ID',
  permission: 'everyone',
  cooldownSec: 0,
  async run(ctx) {
    return ctx.replyThread("Spiff's DBD ID is: Spiff#d0d5");
  }
};
