#!/usr/bin/env node
'use strict';

const { openDB } = require('../src/core/db');

try {
  const db = openDB();
  const mode = db.pragma('journal_mode', { simple: true });
  const busy = db.pragma('busy_timeout', { simple: true });
  console.log(JSON.stringify({ journal_mode: mode, busy_timeout: busy }, null, 2));
  db.close();
} catch (e) {
  console.error('probe error:', e.message || e);
  process.exit(1);
}
