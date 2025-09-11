module.exports = {
  name: 'ping',
  defaults: {
    aliases: [],
    roles: ['everyone'],
    cooldownSeconds: 10,
    limitPerUser: 0,
    replyToUser: true,
    failSilently: true,
    response: 'pong ({latency}ms)'
  },
  run: async () => {
    const latency = Math.floor(Math.random() * 10) + 20;
    return { vars: { latency } };
  }
};

