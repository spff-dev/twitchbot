module.exports = {
  name: 'ping',
  aliases: ['ping'],
  description: 'Latency check',
  permission: 'mod',        // 'everyone' | 'mod' | 'broadcaster'
  cooldownSec: 1,                // per-user cooldown (seconds)
  async run(ctx) {
    // ctx: { client, channel, tags, user, args, say, reply }
    await ctx.reply('pong!');
  }
};
