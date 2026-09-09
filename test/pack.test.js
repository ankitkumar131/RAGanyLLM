'use strict';
// Codec-level tests for the .raganyllm pack containers (ROADMAP §5.1):
// v2 ZIP (manifest + sha-256 + safe entry set) vs legacy v1 JSON, encrypted
// variants, and corruption/tamper handling.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const packLib = require('../lib/pack');

function samplePack(overrides = {}) {
  return {
    format: 'raganyllm-pack',
    version: 1,
    kind: 'ai',
    created_at: '2026-09-09T00:00:00.000Z',
    stats: { total_chunks: 3, total_documents: 2 },
    settings: { embedding_model: 'nomic-embed-text' },
    knowledge: {
      chunks: [
        { id: '1', doc_title: 'A', content: 'alpha content', source: 'File: A.md', chunk_index: 0 },
        { id: '2', doc_title: 'B', content: 'beta content', source: 'File: B.md', chunk_index: 0 },
        { id: '3', doc_title: 'B', content: 'beta follow-up', source: 'File: B.md', chunk_index: 1 }
      ],
      embeddings: [[1, 0], [0, 1], [1, 1]]
    },
    ai: { models: [{ name: 'bot:latest', base_model: 'llama3', custom_instructions: 'hi' }] },
    ...overrides
  };
}

test('zip round trip preserves chunks, embeddings, settings and AI models in order', () => {
  const zip = packLib.encodePack(samplePack(), '');
  assert.ok(Buffer.isBuffer(zip));
  assert.strictEqual(zip.slice(0, 2).toString(), 'PK');
  const d = packLib.decodePack(zip, '');
  assert.strictEqual(d.ok, true);
  const p = d.pack;
  assert.strictEqual(p.container, 'zip-v2');
  assert.strictEqual(p.version, 1, 'knowledge schema stays v1');
  assert.strictEqual(p.kind, 'ai');
  assert.deepStrictEqual(p.knowledge.chunks.map((c) => c.content), ['alpha content', 'beta content', 'beta follow-up']);
  assert.deepStrictEqual(p.knowledge.embeddings, [[1, 0], [0, 1], [1, 1]]);
  assert.deepStrictEqual(p.settings, { embedding_model: 'nomic-embed-text' });
  assert.strictEqual(p.ai.models[0].name, 'bot:latest');
});

test('zip manifest carries per-entry sha-256 checksums', () => {
  const zip = packLib.encodePack(samplePack(), '');
  const adm = new AdmZip(zip);
  const manifest = JSON.parse(adm.readAsText('manifest.json'));
  assert.strictEqual(manifest.format, 'raganyllm-pack');
  assert.strictEqual(manifest.version, 2);
  assert.strictEqual(manifest.counts.chunks, 3);
  assert.strictEqual(manifest.counts.ais, 1);
  const chunksBuf = adm.readFile('knowledge/chunks.jsonl');
  const expected = crypto.createHash('sha256').update(chunksBuf).digest('hex');
  assert.strictEqual(manifest.entries['knowledge/chunks.jsonl'].sha256, expected);
});

test('tampered entry fails the sha-256 check with a friendly error', () => {
  const zip = packLib.encodePack(samplePack(), '');
  const adm = new AdmZip(zip);
  const orig = adm.readFile('knowledge/chunks.jsonl');
  const buf = Buffer.from(orig);
  buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff; // flip a byte
  adm.updateFile('knowledge/chunks.jsonl', buf);
  const tampered = adm.toBuffer();
  const d = packLib.decodePack(tampered, '');
  assert.strictEqual(d.ok, false);
  assert.strictEqual(d.reason, 'bad-zip');
  assert.match(d.detail, /Checksum mismatch|corrupted/);
});

test('unexpected zip entries are rejected (safe path allowlist)', () => {
  const zip = packLib.encodePack(samplePack(), '');
  const adm = new AdmZip(zip);
  adm.addFile('../../evil.sh', Buffer.from('rm -rf /'), '', 0o644);
  const evil = adm.toBuffer();
  const d = packLib.decodePack(evil, '');
  assert.strictEqual(d.ok, false);
  assert.match(d.detail, /Unexpected entry/);
});

test('compact pack (no embeddings) encodes and decodes', () => {
  const pack = samplePack();
  delete pack.knowledge.embeddings;
  const zip = packLib.encodePack(pack, '');
  const d = packLib.decodePack(zip, '');
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.pack.knowledge.embeddings, undefined);
});

test('password-protected zip round-trips; wrong password and missing password rejected', () => {
  const enc = packLib.encodePack(samplePack(), 's3cret');
  const wrapper = JSON.parse(enc.toString('utf8'));
  assert.strictEqual(wrapper.format, 'raganyllm-pack-enc');
  assert.strictEqual(wrapper.container, 'zip-v2');
  assert.ok(!JSON.stringify(wrapper).includes('alpha content'), 'no plaintext leak');

  const noPw = packLib.decodePack(enc, '');
  assert.strictEqual(noPw.reason, 'needs-password');
  const wrong = packLib.decodePack(enc, 'wrong');
  assert.strictEqual(wrong.reason, 'bad-password');
  const good = packLib.decodePack(enc, 's3cret');
  assert.strictEqual(good.ok, true);
  assert.strictEqual(good.pack.knowledge.chunks.length, 3);
});

test('legacy v1 JSON (plain and encrypted) still decodes', () => {
  const pack = samplePack({ kind: 'knowledge' });
  delete pack.ai;
  const v1 = packLib.encodePack(pack, '', { zip: false });
  assert.strictEqual(typeof v1, 'string');
  const d1 = packLib.decodePack(v1, '');
  assert.strictEqual(d1.ok, true);
  assert.strictEqual(d1.pack.knowledge.chunks.length, 3);

  const v1Enc = packLib.encodePack(pack, 'pw', { zip: false });
  assert.strictEqual(JSON.parse(v1Enc).container, 'json-v1');
  const d2 = packLib.decodePack(v1Enc, 'pw');
  assert.strictEqual(d2.ok, true);
  assert.strictEqual(d2.pack.container, undefined);
});

test('garbage input reports a readable reason', () => {
  assert.strictEqual(packLib.decodePack('this is not a pack', '').reason, 'not-json');
  assert.strictEqual(packLib.decodePack(JSON.stringify({ format: 'something-else' }), '').reason, 'wrong-format');
  assert.strictEqual(packLib.decodePack(JSON.stringify({ format: 'raganyllm-pack', version: 99, knowledge: { chunks: [] } }), '').reason, 'unsupported-version');
});
