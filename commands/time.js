// Show current date/time in Europe/London (12-hour with AM/PM)
module.exports = {
  name: 'time',
  description: 'Show current date & time (Europe/London, 12-hour)',
  permission: 'everyone',
  cooldownSec: 0,
  async run(ctx) {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',       // 12-hour hour
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short'
    });

    const parts = fmt.formatToParts(now);
    const get = (t) => parts.find(p => p.type === t)?.value || '';
    // Uppercase AM/PM (en-GB returns "am"/"pm")
    const ampm = (parts.find(p => p.type === 'dayPeriod')?.value || '').toLowerCase() ||
                 (now.getUTCHours() >= 12 ? 'pm' : 'am');

    const out = `The time for Spiff is: ${get('hour')}:${get('minute')}${ampm} ${get('timeZoneName')}`;
    return ctx.say(out);
  }
};

