module.exports = {
  name: 'lurk',
  description: 'Send a friendly lurk message',
  permission: 'everyone',
  cooldownSec: 0,
  async run(ctx) {
    return ctx.replyThread('Enjoy your lurk! Spiff appreciates you being here!');
  }
};
