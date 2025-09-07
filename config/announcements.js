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
    text: 'Enjoying the stream? Hit Follow to support 💜',
    everyMin: 20,
    jitterSec: 30
  },
  {
    text: 'Use !clip to save a moment you liked!',
    everyMin: 30,
    jitterSec: 30
  },
  {
    text: 'Join our Discord → https://discord.gg/YOURCODE',
    everyMin: 45,
    jitterSec: 30,
    type: 'announcement' // banner instead of chat
  }
];
