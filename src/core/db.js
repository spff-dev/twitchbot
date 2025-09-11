'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'bot.db');

function openDB({ readOnly = false } = {}) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // Open DB
  const db = new Database(DB_PATH, {
    readonly: !!readOnly,
    fileMustExist: false, // migrator will create tables if fresh
    timeout: 5000         // coarse timeout at open; we also set busy_timeout below
  });

  // Concurrency & durability
  db.pragma('journal_mode = WAL');     // safe cross-process reads, one writer
  db.pragma('synchronous = NORMAL');   // good trade-off for WAL
  db.pragma('busy_timeout = 5000');    // wait up to 5s on locked DB
  db.pragma('foreign_keys = ON');

  // Fast integrity probe (cheap); if it fails, throw early and loudly.
  try {
    const res = db.prepare('PRAGMA quick_check').pluck().get();
    if (String(res).toLowerCase() !== 'ok') {
      // Escalate to full check for a clear log message
      const full = db.prepare('PRAGMA integrity_check').pluck().get();
      throw new Error(`SQLite integrity check failed: ${full}`);
    }
  } catch (e) {
    // Close and rethrow so callers can handle rebuild/abort cleanly
    try { db.close(); } catch {}
    const msg = e && e.message ? e.message : String(e);
    const err = new Error(`DB integrity error: ${msg}`);
    err.code = 'SQLITE_INTEGRITY';
    throw err;
  }

  return db;
}

module.exports = { openDB, DB_PATH };
