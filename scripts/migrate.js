#!/usr/bin/env node
const { openDB } = require("../src/core/db");

const MIGRATIONS_V1 = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);`,
  `CREATE TABLE IF NOT EXISTS streams (
     id INTEGER PRIMARY KEY,
     started_at TEXT NOT NULL,
     ended_at   TEXT
   );`,
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,           -- twitch user id
     login TEXT NOT NULL,
     first_seen_at TEXT NOT NULL,
     last_seen_stream_id INTEGER
   );`,
  `CREATE TABLE IF NOT EXISTS command_usage (
     ts TEXT NOT NULL,
     stream_id INTEGER,
     user_id TEXT,
     login TEXT,
     command TEXT NOT NULL,
     ok INTEGER NOT NULL,           -- 1=success, 0=blocked/error
     reason TEXT,
     message_id TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS idx_command_usage_stream ON command_usage(stream_id);`,
  `CREATE INDEX IF NOT EXISTS idx_command_usage_user   ON command_usage(user_id);`,
  `CREATE TABLE IF NOT EXISTS permits (
     user_id TEXT PRIMARY KEY,
     expires_at TEXT NOT NULL
   );`
];

const MIGRATIONS_V2 = [
  // counts-only, no message text; stream_id can be NULL until we wire stream sessions
  `CREATE TABLE IF NOT EXISTS message_counts (
     user_id   TEXT NOT NULL,
     login     TEXT NOT NULL,
     stream_id INTEGER,             -- nullable until stream tracking is in place
     count     INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, stream_id)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_msg_counts_stream ON message_counts(stream_id);`
];

function getSchema(db) {
  const row = db.prepare(`SELECT value FROM meta WHERE key='schema'`).get();
  return row ? Number(row.value) : 0;
}
function setSchema(db, v) {
  db.prepare(`INSERT OR REPLACE INTO meta (key,value) VALUES ('schema', ?)`).run(String(v));
}

(function run() {
  const db = openDB();
  db.exec("BEGIN");
  try {
    // v1 base
    for (const sql of MIGRATIONS_V1) db.exec(sql);
    const current = getSchema(db);
    if (current < 2) {
      for (const sql of MIGRATIONS_V2) db.exec(sql);
      setSchema(db, 2);
      db.exec("COMMIT");
      console.log("[migrate] schema=2 ok");
    } else {
      db.exec("COMMIT");
      console.log("[migrate] schema up-to-date (", current, ")");
    }
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("[migrate] failed:", e.message);
    process.exit(1);
  } finally {
    db.close();
  }
})();
