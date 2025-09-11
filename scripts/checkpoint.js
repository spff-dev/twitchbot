#!/usr/bin/env node
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const { openDB } = require('../src/core/db');

const GREEN = s => `\x1b[32m${s}\x1b[0m`;
const RED   = s => `\x1b[31m${s}\x1b[0m`;
const YEL   = s => `\x1b[33m${s}\x1b[0m`;
const GRAY  = s => `\x1b[90m${s}\x1b[0m`;

const ROOT = process.cwd();
const CFG_CMDS = path.join(ROOT, 'config', 'bot-commands-config.json');
const CFG_GEN  = path.join(ROOT, 'config', 'bot-general-config.json');
const CMD_DIR  = path.join(ROOT, 'commands');

function line(ok, msg) {
  console.log(`${ok ? GREEN('✔') : RED('✖')} ${msg}`);
}

(async function main() {
  console.log(GRAY('== twitchbot checkpoint =='));

  // 1) Node/env sanity
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  line(nodeMajor >= 18, `node >= 18 (found ${process.versions.node})`);

  const reqEnv = ['TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET','BROADCASTER_USER_ID','BOT_USER_ID','WEBHOOK_SECRET'];
  let envOk = true;
  for (const k of reqEnv) {
    const v = process.env[k];
    const ok = !!v && (k === 'WEBHOOK_SECRET' ? v.length >= 16 : true);
    envOk = envOk && ok;
    line(ok, `env ${k}${k==='WEBHOOK_SECRET'?' (>=16 chars)':''}`);
  }

  // 2) Config files exist and parse
  let cfgCmds = null, cfgGen = null;
  try { cfgCmds = JSON.parse(fs.readFileSync(CFG_CMDS, 'utf8')); line(true, `parse ${path.basename(CFG_CMDS)}`); }
  catch (e) { line(false, `parse ${path.basename(CFG_CMDS)}: ${e.message}`); }
  try { cfgGen  = JSON.parse(fs.readFileSync(CFG_GEN , 'utf8')); line(true, `parse ${path.basename(CFG_GEN)}`); }
  catch (e) { line(false, `parse ${path.basename(CFG_GEN)}: ${e.message}`); }

  // 3) Commands ↔ config sync
  let syncOk = true;
  try {
    const mods = fs.existsSync(CMD_DIR) ? fs.readdirSync(CMD_DIR).filter(f => f.endsWith('.js')) : [];
    const names = mods.map(f => {
      const m = require(path.join(CMD_DIR, f));
      return (m.name || path.basename(f, '.js')).toLowerCase();
    });
    const have = new Set(Object.keys((cfgCmds && cfgCmds.commands) || {}));
    const missing = names.filter(n => !have.has(n));
    syncOk = missing.length === 0;
    line(syncOk, `commands present in config (${names.length} modules, ${have.size} config blocks)`);
    if (missing.length) console.log(YEL(`  → missing blocks: ${missing.join(', ')}`));
  } catch (e) {
    syncOk = false;
    line(false, `failed to load commands: ${e.message}`);
  }

  // 4) DB schema & tables
  let dbOk = true;
  try {
    const db = openDB();
    const schemaRow = db.prepare(`SELECT value FROM meta WHERE key='schema'`).get();
    const schema = schemaRow ? Number(schemaRow.value) : 0;
    const wantTables = ['command_usage','message_counts','permits','streams','users','meta'];
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
    const haveTables = new Set(rows.map(r => r.name));
    const missing = wantTables.filter(t => !haveTables.has(t));
    db.close();
    line(schema >= 2, `db schema >= 2 (found ${schema})`);
    const tablesOk = missing.length === 0;
    dbOk = (schema >= 2) && tablesOk;
    line(tablesOk, `db tables present (${wantTables.length} required)`);
    if (missing.length) console.log(YEL(`  → missing tables: ${missing.join(', ')}`));
  } catch (e) {
    dbOk = false;
    line(false, `db open/query failed: ${e.message}`);
  }

  // 5) /healthz probe (twitch-webhook)
  await new Promise(res => {
    const req = http.get({ host: '127.0.0.1', port: 18081, path: '/healthz', timeout: 1500 }, r => {
      let buf=''; r.setEncoding('utf8'); r.on('data', d => buf+=d);
      r.on('end', () => {
        try {
          const j = JSON.parse(buf);
          const ok = r.statusCode === 200 && j && j.status === 'ok';
          line(ok, `/healthz 200 ok (pid=${j.pid}, events=${j.eventsReceived}, db=${j.db})`);
        } catch (e) {
          line(false, `/healthz bad json/status (${r.statusCode})`);
        }
        res();
      });
    });
    req.on('error', () => { line(false, `/healthz not reachable on 127.0.0.1:18081`); res(); });
    req.on('timeout', () => { req.destroy(); line(false, `/healthz timeout`); res(); });
  });

  // 6) EventSub subscriptions: channel.chat.message (webhook)
  let esOk = true;
  try {
    const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: {'content-type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials'
      })
    });
    const token = (await tokenRes.json()).access_token;
    const subsRes = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` }
    });
    const subs = await subsRes.json();
    const hasChat = (subs.data || []).some(s => s.type === 'channel.chat.message' && s.status === 'enabled' && s.transport?.method === 'webhook');
    esOk = hasChat;
    line(esOk, `EventSub: channel.chat.message enabled via webhook`);
  } catch (e) {
    esOk = false;
    line(false, `EventSub list failed: ${e.message}`);
  }

  // 7) Announcements config sanity
  let annOk = true;
  if (cfgGen && cfgGen.announcements) {
    const a = cfgGen.announcements;
    const msgs = Array.isArray(a.messages) ? a.messages.filter(Boolean) : [];
    const ok = (!a.enabled) || (Number(a.intervalSeconds) > 0 && msgs.length > 0);
    annOk = ok;
    line(ok, `announcements config (${a.enabled ? 'enabled' : 'disabled'})`);
    if (a.enabled && !ok) console.log(YEL('  → need intervalSeconds > 0 and at least one message'));
  } else {
    annOk = false;
    line(false, `announcements block missing in ${path.basename(CFG_GEN)}`);
  }

  // Result summary
  const allOk = envOk && !!cfgCmds && !!cfgGen && syncOk && dbOk && esOk;
  console.log(GRAY('────────────────────────'));
  if (allOk) {
    console.log(GREEN('Checkpoint: GOOD ✅  (safe to proceed)'));
  } else {
    console.log(RED('Checkpoint: NEEDS FIXES ❌'));
  }
})();
