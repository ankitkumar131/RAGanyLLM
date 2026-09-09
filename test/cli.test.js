'use strict';
// CLI parity tests (ROADMAP §5.3): spawn bin/cli.js export/import against
// isolated RAGANYLLM_HOME dirs. Each test file runs in its own worker, and
// this one only touches child processes + files, so it stays independent.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readPackFile } = require('./pack-helper');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const homes = [];

function freshHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raganyllm-cli-'));
  homes.push(dir);
  return dir;
}

function runCli(args, home, extraEnv = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, RAGANYLLM_HOME: home, OLLAMA_URL: 'http://127.0.0.1:1', ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function seedKb(home, docsWithEmbs) {
  const kb = path.join(home, 'raganyllm-kb.json');
  fs.writeFileSync(kb, JSON.stringify({
    documents: docsWithEmbs.map(([d]) => d),
    embeddings: docsWithEmbs.map(([, e]) => e)
  }));
}

const EMB = (axis) => { const v = new Array(8).fill(0); v[axis] = 1; return v; };
const DOC = (id, title, content, source = `File: ${title}.md`) => ({ id, doc_title: title, content, source, chunk_index: 0 });

function readKb(home) {
  const file = path.join(home, 'raganyllm-kb.json');
  if (!fs.existsSync(file)) return { documents: [], embeddings: [] };
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

after(() => { for (const h of homes) { try { fs.rmSync(h, { recursive: true, force: true }); } catch (e) { /* ignore */ } } });

test('cli export writes a portable pack with stats and embeddings', () => {
  const home = freshHome();
  seedKb(home, [
    [DOC('1', 'Dragon lore', 'Dragons hoard gold and breathe fire.', 'File: lore.md'), EMB(0)],
    [DOC('2', 'Tea notes', 'Green tea steeps at seventy degrees.', 'File: tea.md'), EMB(1)]
  ]);
  const out = path.join(home, 'pack.raganyllm');
  const stdout = runCli(['export', out], home);
  assert.match(stdout, /Exported 2 document\(s\) \/ 2 chunk\(s\) with embeddings/);
  const pack = readPackFile(out);
  assert.strictEqual(pack.format, 'raganyllm-pack');
  assert.strictEqual(pack.container, 'zip-v2', 'CLI export uses the v2 ZIP container');
  assert.strictEqual(pack.knowledge.chunks.length, 2);
  assert.strictEqual(pack.knowledge.embeddings.length, 2);
  assert.strictEqual(pack.stats.total_chunks, 2);
  assert.ok(pack.settings.embedding_model);
});

test('cli export refuses an empty knowledge base', () => {
  const home = freshHome();
  const out = path.join(home, 'empty.raganyllm');
  assert.throws(
    () => runCli(['export', out], home),
    (err) => /knowledge base is empty/.test(err.stderr)
  );
  assert.ok(!fs.existsSync(out));
});

test('cli export --no-embeddings makes a compact pack; import merges and dedupes', () => {
  const homeA = freshHome();
  seedKb(homeA, [[DOC('1', 'Vintage teaware', 'Vintage teapots and porcelain handles.', 'File: v.md'), EMB(0)]]);
  const out = path.join(homeA, 'compact.raganyllm');
  runCli(['export', out, '--no-embeddings'], homeA);
  const pack = readPackFile(out);
  assert.ok(pack.knowledge.embeddings === undefined);

  // Merge into an empty home re-learns via the fake Ollama URL? No — OLLAMA_URL
  // points at a dead port in runCli, so the compact-import must fail cleanly
  // when embeddings cannot be generated.
  const homeB = freshHome();
  assert.throws(
    () => runCli(['import', out], homeB),
    (err) => /Embedding|embedding|Ollama/.test(err.stderr)
  );
  assert.strictEqual(readKb(homeB).documents.length, 0); // all-or-nothing

  // Re-export WITH embeddings, import into fresh home, then re-import (dedupe).
  const out2 = path.join(homeA, 'full.raganyllm');
  runCli(['export', out2], homeA);
  runCli(['import', out2], homeB);
  assert.strictEqual(readKb(homeB).documents.length, 1);
  const again = runCli(['import', out2], homeB);
  assert.match(again, /Nothing new to import/);
  assert.strictEqual(readKb(homeB).documents.length, 1);
});

test('cli import --mode replace wipes first and keeps an auto-backup', () => {
  const src = freshHome();
  seedKb(src, [[DOC('1', 'Only doc', 'Content that should land in the destination.', 'File: o.md'), EMB(0)]]);
  const out = path.join(src, 'p.raganyllm');
  runCli(['export', out], src);

  const dst = freshHome();
  seedKb(dst, [[DOC('x', 'Old doc', 'Old content that gets replaced.', 'File: old.md'), EMB(3)]]);
  runCli(['import', out, '--mode', 'replace'], dst);

  const kb = readKb(dst);
  assert.deepStrictEqual(kb.documents.map((d) => d.doc_title), ['Only doc']);
  // Auto-backup of the pre-replace KB exists in <data-dir>/backups.
  const backupsDir = path.join(dst, 'backups');
  assert.ok(fs.existsSync(backupsDir));
  const snaps = fs.readdirSync(backupsDir).filter((f) => f.startsWith('raganyllm-kb-'));
  assert.ok(snaps.length >= 1);
});

test('cli password-protected pack round-trip (wrong password rejected)', () => {
  const homeA = freshHome();
  seedKb(homeA, [[DOC('1', 'Secret notes', 'My vault combination is 7-3-9-1.', 'File: s.md'), EMB(0)]]);
  const out = path.join(homeA, 'secret.raganyllm');
  const stdout = runCli(['export', out, '--password', 'hunter2'], homeA);
  assert.match(stdout, /password-protected/);
  const enc = JSON.parse(fs.readFileSync(out, 'utf-8'));
  assert.strictEqual(enc.format, 'raganyllm-pack-enc');
  assert.ok(!JSON.stringify(enc).includes('vault'), 'no plaintext leak in the wrapper');

  // Wrong password: clear error, exit non-zero.
  assert.throws(
    () => runCli(['import', out, '--password', 'wrong'], freshHome()),
    (err) => /password is incorrect|Could not open/.test(err.stderr)
  );
  // Needs-password message when none supplied.
  assert.throws(
    () => runCli(['import', out], freshHome()),
    (err) => /password-protected/.test(err.stderr)
  );
  // Correct password round-trips.
  const homeB = freshHome();
  runCli(['import', out, '--password', 'hunter2'], homeB);
  const kb = readKb(homeB);
  assert.strictEqual(kb.documents.length, 1);
  assert.match(kb.documents[0].content, /vault combination/);
});

test('cli rejects a bogus pack and an unknown subcommand', () => {
  const home = freshHome();
  const junk = path.join(home, 'junk.raganyllm');
  fs.writeFileSync(junk, 'this is not json');
  assert.throws(
    () => runCli(['import', junk], home),
    (err) => /not a valid/.test(err.stderr)
  );
  assert.throws(
    () => runCli(['frobnicate'], home),
    (err) => /Unknown command/.test(err.stderr)
  );
});
