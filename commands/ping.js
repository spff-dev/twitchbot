module.exports = {
  name: 'ping',
  aliases: ['ping'],
  description: 'Latency check',
  permission: 'everyone',        // 'everyone' | 'mod' | 'broadcaster'
  cooldownSec: 3,                // per-user cooldown (seconds)
  async run(ctx) {
    // ctx: { client, channel, tags, user, args, say, reply }
    await ctx.say('Pong!');
  }
};
