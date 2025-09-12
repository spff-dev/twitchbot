'use strict';

module.exports = {
  schemaVersion: 1,
  name: 'xmas',
  category: 'dynamic',
  // Config schema merged by manifest-loader; response text lives in config.
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      response:         { type: 'string',  default: '🎄 Christmas in {days}d {hours}h' },
      roles:            { type: 'array',   items: { type: 'string' } },
      cooldownSeconds:  { type: 'integer', minimum: 0, default: 5 },
      limitPerUser:     { type: 'integer', minimum: 0, default: 0 },
      limitPerStream:   { type: 'integer', minimum: 0, default: 0 },
      replyToUser:      { type: 'boolean', default: true },
      failSilently:     { type: 'boolean', default: true }
    }
  },
  defaults: {
    response: '🎄 Christmas in {days}d {hours}h',
    cooldownSeconds: 5,
    replyToUser: true
  },
  async execute(ctx, args, cfg) {
    const now = new Date();

    // Target is Dec 25 of the CURRENT year if not yet passed, else next year.
    const yearNow = now.getFullYear();
    // Months are 0-indexed in JS: 11 => December
    const target = new Date(now);
    target.setMonth(11, 25);  // Dec 25 (day-of-month = 25)
    target.setHours(0, 0, 0, 0);

    if (now > target) {
      target.setFullYear(yearNow + 1);
    }

    const diffMs = target - now;
    if (diffMs <= 0) {
      return {
        vars: { days: 0, hours: 0, totalDays: 0, totalHours: 0, date: target.toISOString().slice(0, 10), out: 'today!' },
        reply: cfg.replyToUser !== false
      };
    }

    const totalHours = Math.floor(diffMs / 3600000);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours - days * 24;
    const totalDays = Math.ceil(diffMs / 86400000);

    return {
      vars: {
        days,
        hours,
        totalDays,
        totalHours,
        date: target.toISOString().slice(0, 10),
        out: `${days}d ${hours}h`
      },
      reply: cfg.replyToUser !== false
    };
  }
};
