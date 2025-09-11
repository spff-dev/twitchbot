/**
 * Timed announcements config.
 * - text: message text
 * - everyMin: repeat interval in minutes
 * - initialDelayMin?: delay before the FIRST post (minutes). Defaults to everyMin.
 * - jitterSec?: add 0..jitterSec random seconds to each post time (to desync from other bots).
 * - type?: 'chat' | 'announcement'  (default 'chat')
 * - liveOnly?: boolean  (default true) - if true, skip when the channel is offline
 */
module.exports = [
  {
    text: 'Enjoying the stream? Hit Follow to support me! 💜',
    everyMin: 45,
    jitterSec: 60
  },
  {
    text: 'Join the Spiffcord! https://discord.gg/x65rDmMycn',
    everyMin: 60,
    jitterSec: 60
  }
];
