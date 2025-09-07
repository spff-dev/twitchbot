module.exports = {
  name: 'cfgreload',
  description: 'Reload templates and command metadata, restart timed announcements',
  permission: 'mod',
  cooldownSec: 3,
  async run(ctx) {
    try {
      await ctx.reloadConfig();
      return ctx.replyThread('Config reloaded.');
    } catch (e) {
      console.error('[CFGRELOAD] error', e);
      return ctx.replyThread('Config reload failed.');
    }
  }
};
