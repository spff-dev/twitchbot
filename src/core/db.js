const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DB_PATH = path.resolve(process.cwd(), "data", "bot.db");

function openDB() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  return db;
}

function withDB(fn) {
  const db = openDB();
  try { return fn(db); } finally { db.close(); }
}

module.exports = { openDB, withDB, DB_PATH };
