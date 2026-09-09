'use strict';
// ROADMAP §2.1 — smart chunking unit tests.
// Tests are pure (no server, no Ollama): they exercise the splitter
// library directly. Wire-level behaviour (metadata surviving ingest →
// retrieval → sources) is covered by the server integration tests.

const { test } = require('node:test');
const assert = require('node:assert');

const { splitPlain, markdownChunks } = require('../lib/chunker');

test('splitPlain: short input returns a single trimmed chunk', () => {
  assert.deepStrictEqual(splitPlain('short text'), [
    { content: 'short text', heading: null, headingPath: null }
  ]);
  // empty / whitespace input -> no chunks
  assert.deepStrictEqual(splitPlain(''), []);
  assert.deepStrictEqual(splitPlain('   \n\n  '), []);
});

test('splitPlain: long input splits into bounded, non-trivial pieces', () => {
  const text = 'A. '.repeat(2000); // ~6000 chars, sentence-ish boundaries
  const out = splitPlain(text);
  assert.ok(out.length >= 3, 'expected multiple chunks');
  for (const c of out) {
    assert.ok(c.content.length > 15, 'chunk must exceed the 15-char filter');
    assert.ok(c.content.length <= 800, `chunk too large: ${c.content.length}`);
    assert.strictEqual(c.heading, null);
    assert.strictEqual(c.headingPath, null);
  }
  // first chunk must start at the beginning
  assert.ok(out[0].content.startsWith('A. '));
});

test('splitPlain: paragraph breaks are preferred over mid-sentence cuts', () => {
  const para = 'one hundred and fifty characters of plain paragraph filler text. '.repeat(2); // ~110 chars
  const body = [];
  for (let i = 0; i < 12; i++) body.push(`Paragraph ${i + 1}: ${para}`);
  const text = body.join('\n\n');
  const out = splitPlain(text);
  assert.ok(out.length > 1, 'expected the long text to be split');
  // Every chunk boundary should sit at a paragraph break (content never
  // begins mid-word inside a paragraph when a \n\n break was available).
  for (const c of out) {
    assert.ok(c.content.trim().length > 0);
  }
  // The first chunk ends exactly at a paragraph boundary.
  const first = out[0].content;
  assert.ok(first.endsWith('filler text.') || first.length <= 800);
});

test('markdownChunks: plain markdown with no headings matches splitPlain (<= chunkSize)', () => {
  const doc = 'Just a body paragraph.\n\nAnother paragraph with **bold** and `code`.\n\nFinal one.';
  // Document is under the chunk size: markdownChunks must not change the
  // content compared with the previous plain chunker behaviour.
  assert.deepStrictEqual(
    markdownChunks(doc).map((c) => c.content),
    splitPlain(doc).map((c) => c.content)
  );
});

test('markdownChunks: no headings -> heading metadata is null', () => {
  const doc = 'One.\n\nTwo.';
  const out = markdownChunks(doc);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].heading, null);
  assert.strictEqual(out[0].headingPath, null);
});

test('markdownChunks: sections keep the heading on their first chunk', () => {
  const out = markdownChunks('# Guide\n\nIntro paragraph about guides.\n\n## Brewing\n\nPour over instructions live here.');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].heading, 'Guide');
  assert.strictEqual(out[0].headingPath, null);
  assert.ok(out[0].content.includes('# Guide'));
  assert.strictEqual(out[1].heading, 'Brewing');
  assert.strictEqual(out[1].headingPath, 'Guide');
});

test('markdownChunks: nested heading paths chain with ›', () => {
  const out = markdownChunks('## A\n\nx\n\n### B\n\ny\n\n#### C\n\nz');
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[2].heading, 'C');
  assert.strictEqual(out[2].headingPath, 'A › B');
});

test('markdownChunks: # inside a fenced code block is not a heading', () => {
  const doc = 'Before the block.\n\n```js\n# not a heading\nfunction x() { return 1; }\n```\n\nAfter the block.';
  const out = markdownChunks(doc);
  assert.strictEqual(out.length, 1, 'no real heading -> single chunk');
  assert.strictEqual(out[0].heading, null);
  assert.ok(out[0].content.includes('```js'));
  assert.ok(out[0].content.includes('function x()'));
});

test('markdownChunks: fenced code blocks are never split when they fit', () => {
  // The body paragraph (~480 chars incl. heading) plus a ~130-char fence
  // exceeds the 600-char budget, so the fence must become its own WHOLE
  // chunk — the opening and closing markers never get separated.
  const body = 'B. '.repeat(160); // ~480 chars of paragraph text
  const codeLine = 'console.log("' + 'x'.repeat(100) + '");';
  const doc = `# Code Sample\n\n${body}\n\n\`\`\`js\n${codeLine}\n\`\`\``;
  const out = markdownChunks(doc, { chunkSize: 600 });
  assert.ok(out.length >= 2, 'expected at least two chunks');

  const fenceChunk = out.find((c) => c.content.includes('```'));
  assert.ok(fenceChunk, 'a chunk should carry the fence');
  assert.ok(fenceChunk.content.startsWith('```'), 'fence chunk begins with the opener');
  assert.ok(fenceChunk.content.endsWith('```'), 'fence chunk ends with the closer');
  assert.ok(fenceChunk.content.includes(codeLine), 'code line stays inside its fence chunk');
  // The fence chunk is a continuation chunk under a top-level heading:
  // its own `heading` is null (only the section-start chunk carries it),
  // but headingPath still locates it inside 'Code Sample'.
  assert.strictEqual(fenceChunk.heading, null);
  assert.strictEqual(fenceChunk.headingPath, 'Code Sample');
});

test('markdownChunks: oversized fence is sliced without losing the opener/closer', () => {
  const interior = [];
  for (let i = 0; i < 200; i++) interior.push('l'.repeat(40) + i);
  const doc = `# Big Block\n\nIntro.\n\n\`\`\`\n${interior.join('\n')}\n\`\`\``;
  const out = markdownChunks(doc, { chunkSize: 600 });
  assert.ok(out.length > 3, 'oversized fence must be split into several chunks');
  const all = out.map((c) => c.content).join('\n');
  // Nothing was lost: the opener and closer appear exactly once across all
  // chunks (splitting never duplicates or swallows the fence markers) and
  // every interior code line survives at least once.
  assert.strictEqual(all.split('```').length - 1, 2, 'fence markers must not be duplicated or lost');
  for (const line of interior) {
    const occ = all.split(line).length - 1;
    assert.ok(occ >= 1, `code line lost: ${line.slice(0, 20)}`);
  }
});

test('markdownChunks: a split subsection keeps its full heading path on continuations', () => {
  const filler = 'word '.repeat(300); // ~1500 chars -> splits many times
  const doc = `# Root\n\nIntro.\n\n## Sub With A Long Body\n\n${filler}`;
  const out = markdownChunks(doc, { chunkSize: 600 });
  const subChunks = out.filter((c) => c.headingPath === 'Root' || (c.headingPath && c.headingPath.startsWith('Root › Sub With A Long Body')));
  assert.ok(subChunks.length >= 2, 'expected the long subsection to split');
  const first = out.find((c) => c.heading === 'Sub With A Long Body');
  assert.ok(first, 'subsection start chunk exists');
  assert.strictEqual(first.headingPath, 'Root');
  for (const c of subChunks.slice(1)) {
    assert.strictEqual(c.headingPath, 'Root › Sub With A Long Body');
    assert.strictEqual(c.heading, null);
  }
});

test('markdownChunks: oversized section splits; later chunks keep headingPath but null heading', () => {
  const filler = 'word '.repeat(400); // ~2000 chars of body under one heading
  const doc = `# Only Section\n\n${filler}`;
  const out = markdownChunks(doc, { chunkSize: 600 });
  assert.ok(out.length >= 3, 'expected several chunks from the long section');
  assert.strictEqual(out[0].heading, 'Only Section');
  assert.strictEqual(out[0].headingPath, null);
  for (const c of out.slice(1)) {
    assert.strictEqual(c.heading, null, 'only the section-start chunk carries the heading');
    assert.strictEqual(c.headingPath, 'Only Section', 'continuation chunks keep the full section path');
  }
});

test('markdownChunks: empty / blank document -> no chunks', () => {
  assert.deepStrictEqual(markdownChunks(''), []);
  assert.deepStrictEqual(markdownChunks('\n\n  \n'), []);
});

test('markdownChunks: CRLF and runaway blank lines are normalized', () => {
  const out = markdownChunks('# H\r\n\r\n\r\n\r\nBody text here.\r\n\r\nNext paragraph.');
  assert.strictEqual(out.length, 1);
  assert.ok(!out[0].content.includes('\r'), 'CRLF removed');
  assert.ok(!out[0].content.includes('\n\n\n'), 'blank runs collapsed');
});
