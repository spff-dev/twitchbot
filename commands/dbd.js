module.exports = {
  name: 'dbd',
  description: 'Send DBD ID',
  permission: 'everyone',
  cooldownSec: 0,
  async run(ctx) {
    return ctx.replyThread("ℹ️ Spiff's DBD ID is: Spiff#d0d5 or SPIFFgg#d0d5 - depending on his name in-game.");
  }
};
