#!/usr/bin/env node
'use strict';

/**
 * Schema v3
 *  v1: initial tables (message_counts, command_usage, etc.)
 *  v2: WAL + busy_timeout, integrity check
 *  v3: moderation tables:
 *      - permits(user_id TEXT, login TEXT, expires_at INTEGER, granted_by TEXT, created_at TEXT)
 *      - moderation_events(type TEXT, user_id TEXT, login TEXT, message_id TEXT, action TEXT, reason TEXT, ts TEXT)
 */

const path = require('path');
const { openDB } = require('../src/core/db.js');

(async () => {
  const db = openDB(path.join(__dirname, '..', 'data', 'bot.db'));

  // Ensure WAL + busy_timeout + integrity sanity (v2)
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  try {
    const ok = db.prepare('PRAGMA integrity_check').pluck().get();
    if (String(ok).toLowerCase() !== 'ok') {
      console.error('[migrate] integrity_check failed:', ok);
    }
  } catch (e) {
    console.error('[migrate] integrity_check error:', e.message || e);
  }

  const get = db.prepare('PRAGMA user_version').pluck().get();
  const cur = Number(get || 0);
  let v = cur;

  db.transaction(() => {
    if (v < 1) {
      db.pragma('user_version = 1');
      v = 1;
    }
    if (v < 2) {
      db.pragma('user_version = 2');
      v = 2;
    }
    if (v < 3) {
      // permits
      db.prepare(`
        CREATE TABLE IF NOT EXISTS permits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          login   TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          granted_by TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
     `).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_permits_user ON permits(user_id);`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_permits_expires ON permits(expires_at);`).run();

      // moderation events log
      db.prepare(`
        CREATE TABLE IF NOT EXISTS moderation_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          user_id TEXT,
          login TEXT,
          message_id TEXT,
          action TEXT,
          reason TEXT,
          ts TEXT DEFAULT (datetime('now'))
        );
      `).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_mod_evt_ts ON moderation_events(ts);`).run();
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_mod_evt_type ON moderation_events(type);`).run();

      db.pragma('user_version = 3');
      v = 3;
    }
  })();

  console.log('[migrate] schema=' + v + ' ok');
  db.close();
})().catch(e => {
  console.error('[migrate] error', e);
  process.exit(1);
});
