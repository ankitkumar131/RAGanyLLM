'use strict';
// Minimal structured logger (ROADMAP §6 "Logging & crash-proofing").
// JSONL records are appended to <data-dir>/logs/raganyllm.log, rotated at
// ~1 MB (keep the newest 5 rotated files), and mirrored into an in-memory
// ring buffer served by GET /api/logs. Logging is best-effort and never
// throws — it must never take the app down.
const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./paths');

const MAX_FILE_BYTES = 1024 * 1024; // rotate at ~1 MB
const KEEP_FILES = 5;
const RING_SIZE = 500;

const ring = [];

function currentFile() {
  const dir = path.join(getDataDir(), 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  return path.join(dir, 'raganyllm.log');
}

function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_FILE_BYTES) return;
    const dir = path.dirname(file);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, path.join(dir, `raganyllm-${stamp}.log`));
    const rotated = fs.readdirSync(dir)
      .filter((f) => /^raganyllm-\d{4}-\d{2}-\d{2}T/.test(f))
      .sort()
      .reverse();
    for (const f of rotated.slice(KEEP_FILES)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

function emit(level, event, msg, meta) {
  const rec = { ts: new Date().toISOString(), level, event, msg: msg || '', ...(meta || {}) };
  ring.push(rec);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  try {
    const file = currentFile();
    rotateIfNeeded(file);
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf-8');
  } catch (e) { /* best-effort */ }
  // Mirror severe records to stderr (tests / consoles still see real errors).
  if (level === 'error' && process.env.RAGANYLLM_QUIET !== '1') {
    console.error(`[${event}] ${msg}`);
  }
  return rec;
}

function dir() {
  const d = path.join(getDataDir(), 'logs');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ignore */ }
  return d;
}

module.exports = {
  dir,
  info: (event, msg, meta) => emit('info', event, msg, meta),
  warn: (event, msg, meta) => emit('warn', event, msg, meta),
  error: (event, msg, meta) => emit('error', event, msg, meta),
  ring: () => ring.slice()
};
