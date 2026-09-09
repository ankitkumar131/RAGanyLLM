'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const VectorStore = require('../lib/vector-store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raganyllm-test-'));
  const store = new VectorStore(path.join(dir, 'kb.json'));
  return { store, dir };
}

const E8 = (axis) => {
  const v = new Array(8).fill(0);
  v[axis] = 1;
  return v;
};
const DOC = (id, title, content, source = `File: ${title}.md`, idx = 0) => ({
  id, doc_title: title, content, source, chunk_index: idx
});

test('chunkText splits long text and keeps boundaries', () => {
  const long = 'Sentence about dragons. '.repeat(200);
  const chunks = VectorStore.chunkText(long);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.length > 15));
  assert.deepStrictEqual(VectorStore.chunkText('short text'), ['short text']);
});

test('addChunks dedupes identical content and reports added/skipped', () => {
  const { store } = tempStore();
  const a = DOC('a', 'Dragon Care', 'alpha beta gamma delta epsilon');
  const emb = E8(0);
  assert.deepStrictEqual(store.addChunks([a], [emb]), { added: 1, skipped: 0 });
  // Same content, different id -> duplicate.
  const b = { ...a, id: 'b' };
  assert.deepStrictEqual(store.addChunks([b], [emb]), { added: 0, skipped: 1 });
  assert.strictEqual(store.documents.length, 1);
});

test('load() heals legacy duplicates written by older versions', () => {
  const { store, dir } = tempStore();
  const a = DOC('a', 'Doc', 'same content here for healing');
  const emb = E8(0);
  fs.writeFileSync(path.join(dir, 'kb.json'), JSON.stringify({ documents: [a, { ...a, id: 'b' }], embeddings: [emb, emb] }));
  const reloaded = new VectorStore(path.join(dir, 'kb.json'));
  assert.strictEqual(reloaded.documents.length, 1);
});

test('search threshold gates low-similarity results', () => {
  const { store } = tempStore();
  store.addChunks([DOC('a', 'Doc', 'alpha beta gamma')], [E8(0)]);
  assert.strictEqual(store.search(E8(1), 5, 0.4).length, 0); // orthogonal
  assert.strictEqual(store.search(E8(0), 5, 0.4).length, 1); // identical
});

test('removeByDocTitle removes all chunks of a doc and syncs dedupe index', () => {
  const { store } = tempStore();
  store.addChunks([
    DOC('a1', 'Doc A', 'first chunk of doc a'), 
    DOC('a2', 'Doc A', 'second chunk of doc a'),
    DOC('b', 'Doc B', 'chunk of doc b')
  ], [E8(0), E8(1), E8(2)]);
  assert.strictEqual(store.removeByDocTitle('Doc A'), 2);
  assert.strictEqual(store.documents.length, 1);
  assert.strictEqual(store.documents[0].doc_title, 'Doc B');
  // Re-adding a previously removed chunk works (index cleared).
  const r = store.addChunks([DOC('a1', 'Doc A', 'first chunk of doc a')], [E8(0)]);
  assert.deepStrictEqual(r, { added: 1, skipped: 0 });
});

test('hybridSearch recovers keyword-only matches that vector search misses', () => {
  const { store } = tempStore();
  // Doc A is semantically close to the query embedding (axis 0); Doc B is
  // orthogonal but rich in the query keyword "vintage".
  store.addChunks([
    DOC('a', 'Tea guide', 'Green tea should be brewed at seventy degrees for three minutes.'),
    DOC('b', 'Vintage teaware', 'The vintage vintage vintage teapot collection covers rare vintage porcelain and vintage handles. Vintage spouts and vintage lids are prized. Only vintage teapots are discussed here.')
  ], [E8(0), E8(1)]);

  const queryEmbedding = E8(0);
  const queryText = 'vintage tea brewing temperature';

  const vec = store.search(queryEmbedding, 4, 0.4);
  assert.deepStrictEqual(vec.map((r) => r.id), ['a']); // B is vector-invisible

  const hy = store.hybridSearch(queryText, queryEmbedding, 4, 0.4);
  const ids = hy.map((r) => r.id);
  assert.ok(ids.includes('a'));
  assert.ok(ids.includes('b'), 'BM25 should surface the keyword-only doc');
  assert.ok(hy.every((r) => typeof r.similarity_score === 'number'));
  assert.ok(hy.every((r) => 'cosine_similarity' in r && 'keyword_score' in r));

  // Index must stay in sync after deletion.
  store.removeByDocTitle('Vintage teaware');
  assert.ok(!store.hybridSearch(queryText, queryEmbedding, 4, 0.4).some((r) => r.id === 'b'));
});

test('hybridSearch handles empty store and empty query text', () => {
  const { store } = tempStore();
  assert.deepStrictEqual(store.hybridSearch('anything', E8(0), 4, 0.4), []);
  store.addChunks([DOC('a', 'Doc', 'alpha beta gamma delta')], [E8(0)]);
  assert.strictEqual(store.hybridSearch('', E8(0), 4, 0.4).length, 1); // vector-only path still works
});
