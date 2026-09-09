'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point user-data resolution at a temp dir BEFORE requiring lib modules
// (paths.js caches the resolved dir on first use).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'raganyllm-cfg-'));
process.env.RAGANYLLM_HOME = HOME;
const { getConfig, saveConfig, CONFIG_FILE, clampInt, clampFloat } = require('../lib/config');
const { getDataDir } = require('../lib/paths');

test('config lives under RAGANYLLM_HOME with defaults', () => {
  assert.ok(CONFIG_FILE.startsWith(HOME));
  assert.strictEqual(getDataDir(), HOME);
  const cfg = getConfig();
  assert.strictEqual(cfg.top_k, 4);
  assert.strictEqual(cfg.similarity_threshold, 0.4);
  assert.strictEqual(cfg.search_mode, 'vector');
});

test('saveConfig clamps numerics and rejects unknown search_mode', () => {
  let cfg = saveConfig({ top_k: 999, similarity_threshold: 5, search_mode: 'quantum' });
  assert.strictEqual(cfg.top_k, 20);
  assert.strictEqual(cfg.similarity_threshold, 0.99);
  assert.strictEqual(cfg.search_mode, 'vector', 'invalid search_mode falls back to a valid value');
});

test('saveConfig partial updates preserve other settings (regression)', () => {
  saveConfig({ ollama_url: 'http://10.1.2.3:11434', top_k: 6, search_mode: 'hybrid' });
  const cfg = saveConfig({ similarity_threshold: 0.55 });
  assert.strictEqual(cfg.ollama_url, 'http://10.1.2.3:11434', 'url must survive partial update');
  assert.strictEqual(cfg.top_k, 6);
  assert.strictEqual(cfg.search_mode, 'hybrid');
  assert.strictEqual(cfg.similarity_threshold, 0.55);
});

test('saveConfig ignores an invalid search_mode without wiping the saved one', () => {
  saveConfig({ search_mode: 'hybrid' });
  const cfg = saveConfig({ search_mode: 'quantum', top_k: 9 });
  assert.strictEqual(cfg.search_mode, 'hybrid', 'invalid input must not clobber a saved hybrid mode');
  assert.strictEqual(cfg.top_k, 9);
});

test('empty string is a valid explicit value (clears models dir)', () => {
  saveConfig({ ollama_models_dir: '/some/path' });
  const cfg = saveConfig({ ollama_models_dir: '' });
  assert.strictEqual(cfg.ollama_models_dir, '');
});

test('clamp helpers', () => {
  assert.strictEqual(clampInt('abc', 1, 20, 4), 4);
  assert.strictEqual(clampInt(7, 1, 20, 4), 7);
  assert.strictEqual(clampFloat(-1, 0, 0.99, 0.4), 0);
  assert.strictEqual(clampFloat(0.5, 0, 0.99, 0.4), 0.5);
});
