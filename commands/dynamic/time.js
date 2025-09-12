'use strict';

// !time - shows current time in configured timezone
// Configurable keys:
//   response:   template using {time}, {date}, {tz}
//   timezone:   IANA zone, e.g. "Europe/London"
//   roles:      ['everyone' | 'mod' | 'owner']
//   cooldownSeconds, limitPerUser, limitPerStream, replyToUser, failSilently

module.exports = {
  schemaVersion: 1,
  name: 'time',
  category: 'dynamic',
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      response:        { type: 'string',  default: 'Time: {time}' },
      timezone:        { type: 'string',  default: 'Europe/London' },
      roles:           { type: 'array',   items: { type: 'string' }, default: ['everyone'] },
      cooldownSeconds: { type: 'integer', minimum: 0, default: 5 },
      limitPerUser:    { type: 'integer', minimum: 0, default: 0 },
      limitPerStream:  { type: 'integer', minimum: 0, default: 0 },
      replyToUser:     { type: 'boolean', default: true },
      failSilently:    { type: 'boolean', default: true }
    }
  },
  defaults: {
    response: 'Time: {time}',
    timezone: 'Europe/London',
    roles: ['everyone'],
    cooldownSeconds: 5,
    replyToUser: true
  },

  async execute(_ctx, _args, cfg) {
    const tz = String(cfg.timezone || 'Europe/London');
    const now = new Date();

    // time e.g. "21:37"
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false
    }).format(now);

    // date e.g. "12 Sep 2025"
    const date = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, day: '2-digit', month: 'short', year: 'numeric'
    }).format(now);

    return {
      vars: { time, date, tz },
      reply: !!cfg.replyToUser
    };
  }
};
