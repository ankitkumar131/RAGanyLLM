'use strict';
// ROADMAP §2.4 — grounded-citation verification unit tests (pure, no server).

const { test } = require('node:test');
const assert = require('node:assert');

const { annotateCitations, splitSentences, contentTokens } = require('../lib/grounding');

const COFFEE = { content: 'The V60 brewer uses a paper filter to remove coffee oils. The grind size changes the brew time.' };
const STEEL = { content: 'Carbon steel holds heat evenly and reacts with acidic food. It needs seasoning before first use.' };

test('annotateCitations: verbatim-grounded sentence keeps its citation', () => {
  const r = annotateCitations('The V60 brewer uses a paper filter. [1]', [COFFEE]);
  assert.strictEqual(r.citations.length, 1);
  assert.deepStrictEqual(r.citations[0].sources, [1]);
  assert.strictEqual(r.citations[0].support, 1);
  const mk = r.markers[0];
  assert.strictEqual(mk.kind, 'cite');
  assert.strictEqual(mk.supported, true);
  assert.strictEqual(mk.source, 1);
  assert.strictEqual(r.cleanText, 'The V60 brewer uses a paper filter. ');
});

test('annotateCitations: fabricated citation is dropped, sentence text kept', () => {
  const r = annotateCitations('The moon is made of cheese. [1]', [COFFEE]);
  assert.strictEqual(r.citations.length, 0);
  assert.strictEqual(r.markers.length, 1);
  assert.strictEqual(r.markers[0].supported, false);
  // The unsupported claim marker is removed so the UI never shows a fake cite…
  assert.ok(!r.cleanText.includes('[1]'));
  // …but the claim text itself stays (that is the model's answer, honest but uncited).
  assert.ok(r.cleanText.includes('The moon is made of cheese.'));
});

test('annotateCitations: out-of-range markers are dropped', () => {
  const r = annotateCitations('Brew with hot water. [9]', [COFFEE]);
  assert.strictEqual(r.citations.length, 0);
  assert.strictEqual(r.markers[0].supported, false);
  assert.ok(!r.cleanText.includes('[9]'));
});

test('annotateCitations: two sources on one sentence -> both cited', () => {
  const r = annotateCitations('The V60 paper filter removes oils while carbon steel heats evenly. [1][2]', [COFFEE, STEEL]);
  assert.strictEqual(r.citations.length, 1);
  assert.deepStrictEqual(r.citations[0].sources, [1, 2]);
  assert.strictEqual(r.markers.length, 2);
  assert.ok(r.markers.every((m) => m.supported));
});

test('annotateCitations: multiple grounded sentences -> one citation each', () => {
  const ans = 'The V60 brewer uses a paper filter. [1]\nCarbon steel holds heat evenly. [2]';
  const r = annotateCitations(ans, [COFFEE, STEEL]);
  assert.strictEqual(r.citations.length, 2);
  assert.deepStrictEqual(r.citations.map((c) => c.sources), [[1], [2]]);
  assert.strictEqual(r.cleanText, 'The V60 brewer uses a paper filter. \nCarbon steel holds heat evenly. ');
});

test('annotateCitations: casing/word-boundaries are normalized', () => {
  const r = annotateCitations('CARBON STEEL HOLDS HEAT EVENLY. [2]', [COFFEE, STEEL]);
  assert.strictEqual(r.citations.length, 1);
  assert.deepStrictEqual(r.citations[0].sources, [2]);
});

test('annotateCitations: ordinary bracketed prose is left untouched', () => {
  // "[1]" mid-sentence with a following digit or glued to a word is NOT a
  // citation claim — it stays in the text and in cleanText.
  const ans = 'See points [1] and [2] of the manual for details.';
  const r = annotateCitations(ans, [COFFEE, STEEL]);
  assert.strictEqual(r.markers.length, 0); // no candidate citations at all
  assert.strictEqual(r.citations.length, 0);
  assert.strictEqual(r.cleanText, ans);
});

test('annotateCitations: no markers / no sources -> passthrough', () => {
  const r1 = annotateCitations('Plain answer with no markers.', [COFFEE]);
  assert.deepStrictEqual(r1, { citations: [], markers: [], cleanText: 'Plain answer with no markers.' });
  const r2 = annotateCitations('Even a marker [1] here, but no sources.', []);
  assert.deepStrictEqual(r2, { citations: [], markers: [], cleanText: 'Even a marker [1] here, but no sources.' });
});

test('annotateCitations: marker after "sentence. [n]" stays attached for support', () => {
  // The space between the period and the marker must not detach the marker
  // from the sentence it evidences (otherwise support would compute 0).
  const ans = 'Carbon steel reacts with acidic food. [2] Definitely worth seasoning it.';
  const r = annotateCitations(ans, [COFFEE, STEEL]);
  assert.strictEqual(r.citations.length, 1);
  assert.deepStrictEqual(r.citations[0].sources, [2]);
});

test('splitSentences: units with offsets cover the whole string', () => {
  const text = 'One sentence here. [1] Next one!\nA bullet line.\n\nFinal paragraph? Yes.';
  const units = splitSentences(text);
  assert.ok(units.length >= 4);
  let prev = 0;
  for (const u of units) {
    assert.strictEqual(u.start, prev);
    assert.ok(u.end > u.start);
    assert.strictEqual(text.slice(u.start, u.end), u.text);
    prev = u.end;
  }
  assert.strictEqual(prev, text.length);
  // marker stays glued to its sentence across the ". " boundary
  assert.ok(units[0].text.includes('[1]'));
  assert.ok(units[0].text.startsWith('One sentence here. [1]'));
});

test('contentTokens: stopwords dropped, unicode + digits kept, lowercased', () => {
  const t = contentTokens('The V60 filter & COFFEE oils — 100%!');
  assert.deepStrictEqual(t, ['v60', 'filter', 'coffee', 'oils', '100']);
});
