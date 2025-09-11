module.exports = {
  name: 'specs',
  description: 'Send PC specs',
  permission: 'everyone',
  cooldownSec: 30,
  async run(ctx) {
    return ctx.say("🖥️ Motherboard: Gigabyte Z690 Aorus Elite AX / CPU: Intel Core i9-12900K / RAM: Kingston Fury Beast 64Gb DDR5 / GPU: Gigabyte GeForce RTX 4090 GAMING OC 24G / OS: Windows 11");
  }
};
