'use strict';
// Unit tests for the §2.2 pure retrieval helpers (lib/retrieval.js) and the
// store-level metadata filters.
const { test } = require('node:test');
const assert = require('node:assert');

const ragAdv = require('../lib/retrieval');
const VectorStore = require('../lib/vector-store');

const EMB = (axis) => { const v = new Array(8).fill(0); v[axis] = 1; return v; };
const DOC = (id, title, content, source = `File: ${title}.md`, idx = 0) => ({ id, doc_title: title, content, source, chunk_index: idx });

test('selectQueries keeps original first, caps extras (2), dedupes and filters empties', () => {
  assert.deepStrictEqual(ragAdv.selectQueries('q'), ['q']);
  assert.deepStrictEqual(ragAdv.selectQueries('q', ['a', 'b', 'c', 'd']), ['q', 'a', 'b']); // max 2 extra
  assert.deepStrictEqual(ragAdv.selectQueries('q', ['', '  ', 'a', 'a', 42, 'b']), ['q', 'a', 'b']);
  const long = 'x'.repeat(501);
  assert.deepStrictEqual(ragAdv.selectQueries('q', [long, 'ok']), ['q', 'ok']);
});

test('mergePools dedupes by chunk, keeps best score, sorts and slices', () => {
  const a1 = DOC('1', 'A', 'alpha', 'File: A.md', 0); a1.similarity_score = 0.5;
  const a2 = DOC('1', 'A', 'alpha', 'File: A.md', 0); a2.similarity_score = 0.9;
  const b1 = DOC('2', 'B', 'beta', 'File: B.md', 0); b1.similarity_score = 0.7;
  const pools = [[a1], [a2, b1]];
  const merged = ragAdv.mergePools(pools, 5);
  assert.strictEqual(merged.length, 2);
  assert.strictEqual(merged[0].doc_title, 'A');
  assert.strictEqual(merged[0].similarity_score, 0.9); // best kept
  const sliced = ragAdv.mergePools(pools, 1);
  assert.strictEqual(sliced.length, 1);
  assert.strictEqual(sliced[0].doc_title, 'A');
});

test('extractJson tolerates fences, prose and object/array payloads', () => {
  assert.deepStrictEqual(ragAdv.extractJson('```json\n["a","b"]\n```'), ['a', 'b']);
  assert.deepStrictEqual(ragAdv.extractJson('sure! { "indices": [2,0] } thanks'), { indices: [2, 0] });
  assert.deepStrictEqual(ragAdv.extractJson('just [1, 0, 2] please'), [1, 0, 2]);
  assert.strictEqual(ragAdv.extractJson('no json here'), null);
  assert.strictEqual(ragAdv.extractJson(''), null);
  assert.strictEqual(ragAdv.extractJson('['), null);
});

test('reorderByIndices permutes without losing candidates; garbage falls back', () => {
  const chunks = [DOC('0', 'A', 'a'), DOC('1', 'B', 'b'), DOC('2', 'C', 'c')];
  const reordered = ragAdv.reorderByIndices(chunks, [2, 1, 0]);
  assert.deepStrictEqual(reordered.map((c) => c.doc_title), ['C', 'B', 'A']);
  // duplicates and out-of-range indices are skipped, others appended.
  const weird = ragAdv.reorderByIndices(chunks, [1, 1, 99, -1]);
  assert.deepStrictEqual(weird.map((c) => c.doc_title), ['B', 'A', 'C']);
  // fallback = original order
  assert.strictEqual(ragAdv.reorderByIndices(chunks, 'garbage'), chunks);
  assert.strictEqual(ragAdv.reorderByIndices(chunks, null), chunks);
});

test('rerankPoolSize widens small top-k but caps at 20', () => {
  assert.strictEqual(ragAdv.rerankPoolSize(4), 12);
  assert.strictEqual(ragAdv.rerankPoolSize(1), 3);
  assert.strictEqual(ragAdv.rerankPoolSize(20), 20);
  assert.ok(ragAdv.rerankPoolSize(4) <= 20);
});

test('vector search honors doc-title and source filters (unit)', () => {
  const vs = new VectorStore();
  vs.documents = [
    DOC('1', 'Alpha', 'alpha', 'File: alpha.md'),
    DOC('2', 'Beta', 'beta', 'File: beta.md'),
    DOC('3', 'Gamma', 'gamma', 'Web: https://x.test/gamma')
  ];
  vs.embeddings = [EMB(0), EMB(1), EMB(2)];

  const all = vs.search(EMB(0), 5, 0.05);
  assert.deepStrictEqual(all.map((d) => d.doc_title), ['Alpha']);

  const byTitle = vs.search(EMB(0), 5, 0.05, { docTitles: ['Beta', 'Gamma'] });
  assert.deepStrictEqual(byTitle, []); // Alpha filtered out even though it is the top hit

  const keepBeta = vs.search(EMB(1), 5, 0.05, { docTitles: ['Beta'] });
  assert.deepStrictEqual(keepBeta.map((d) => d.doc_title), ['Beta']);

  const localOnly = vs.search(EMB(2), 5, 0.05, { sourceText: 'File:' });
  assert.deepStrictEqual(localOnly, []); // Gamma is a Web source
  const webOnly = vs.search(EMB(2), 5, 0.05, { sourceText: 'Web:' });
  assert.deepStrictEqual(webOnly.map((d) => d.doc_title), ['Gamma']);
});

test('hybrid search applies the same filters (unit)', () => {
  const vs = new VectorStore();
  vs.documents = [
    DOC('1', 'Alpha', 'alpha dragons', 'File: alpha.md'),
    DOC('2', 'Beta', 'beta dragons', 'File: beta.md')
  ];
  vs.embeddings = [EMB(0), EMB(1)];
  const all = vs.hybridSearch('dragons', EMB(0), 5, 0);
  assert.strictEqual(all.length, 2); // keyword hit surfaces Beta too
  const onlyAlpha = vs.hybridSearch('dragons', EMB(0), 5, 0, { docTitles: ['Alpha'] });
  assert.deepStrictEqual(onlyAlpha.map((d) => d.doc_title), ['Alpha']);
  const webOnly = vs.hybridSearch('dragons', EMB(0), 5, 0, { sourceText: 'Web:' });
  assert.deepStrictEqual(webOnly, []);
});
