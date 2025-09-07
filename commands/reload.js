module.exports = {
  name: 'reload',
  aliases: ['rl', 'rehash'],
  description: 'Hot-reload all command modules',
  permission: 'broadcaster',  // change to 'mod' if you prefer
  cooldownSec: 3,
  async run(ctx) {
    try {
      const { count } = ctx.reload();
      await ctx.say(`🔁 Reloaded ${count} command${count === 1 ? '' : 's'}.`);
    } catch (e) {
      await ctx.say(`Reload failed: ${e.message}`);
    }
  }
};
