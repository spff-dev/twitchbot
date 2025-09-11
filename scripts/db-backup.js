#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { DB_PATH } = require('../src/core/db');

const ROOT = process.cwd();
const BACKUP_DIR = path.join(ROOT, 'backups');
const KEEP = Number(process.env.DB_BACKUP_KEEP || 14); // keep last N backups
const ts = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.log('[BK] skip: db not found at', DB_PATH);
    return;
  }
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const base = `bot.db.${ts()}.gz`;
  const out = path.join(BACKUP_DIR, base);
  const hash = crypto.createHash('sha256');

  await new Promise((resolve, reject) => {
    const inp = fs.createReadStream(DB_PATH);
    const gz = zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION });
    const outp = fs.createWriteStream(out);
    inp.on('error', reject);
    gz.on('error', reject);
    outp.on('error', reject);
    inp.on('data', chunk => hash.update(chunk));
    outp.on('finish', resolve);
    inp.pipe(gz).pipe(outp);
  });

  const digest = hash.digest('hex');
  fs.writeFileSync(out + '.sha256', `${digest}  ${path.basename(out)}\n`);
  console.log('[BK] wrote', path.basename(out), 'sha256=', digest.slice(0, 12));

  // Rotate
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^bot\.db\.\d{8}T\d{6}Z\.gz$/.test(f))
    .sort(); // timestamp format sorts chronologically
  const excess = Math.max(0, files.length - KEEP);
  for (let i = 0; i < excess; i++) {
    const f = files[i];
    try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
    try { fs.unlinkSync(path.join(BACKUP_DIR, f + '.sha256')); } catch {}
    console.log('[BK] rotated out', f);
  }
}

main().catch(e => {
  console.error('[BK] error', e && e.message ? e.message : e);
  process.exit(1);
});
