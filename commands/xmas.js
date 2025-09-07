// How many sleeps until Christmas Day (Europe/London)
function londonYMD(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: 'numeric', day: 'numeric'
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

// Count whole calendar days using UTC mid-day anchors to dodge DST edges
function daysBetween(y1, m1, d1, y2, m2, d2) {
  const A = Date.UTC(y1, m1 - 1, d1, 12, 0, 0);
  const B = Date.UTC(y2, m2 - 1, d2, 12, 0, 0);
  const MS_PER_DAY = 86400000;
  const diff = Math.max(0, Math.round((B - A) / MS_PER_DAY));
  return diff;
}

module.exports = {
  name: 'xmas',
  description: 'Count sleeps until 25 December (Europe/London)',
  permission: 'everyone',
  cooldownSec: 0,
  async run(ctx) {
    const { y, m, d } = londonYMD();
    // target Christmas (this year or next)
    const targetYear = (m > 12 || (m === 12 && d > 25)) ? y + 1 : y;
    const sleeps = daysBetween(y, m, d, targetYear, 12, 25);

    const msg = sleeps === 0
      ? '0 sleeps - it’s Christmas! 🎄'
      : `${sleeps} sleep${sleeps === 1 ? '' : 's'} until Christmas 🎄`;

    return ctx.say(msg);
  }
};
