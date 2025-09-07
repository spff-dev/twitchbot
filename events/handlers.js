module.exports = function buildHandlers({ tmiClient, channel }) {
  return {
    // Follows → normal chat line
    onFollowChat: (name) => {
      try { tmiClient.say(channel, `Welcome @${name} - thanks for the follow!`); } catch {}
    },
    // These already post announcements inside eventsub.js; hooks provided if you want extra chat lines:
    onBitsAnnounce:   () => {},
    onSubAnnounce:    () => {},
    onResubAnnounce:  () => {},
    onGiftAnnounce:   () => {}
  };
};
