'use strict';
// ROADMAP §2.4 — grounded citations across the /api/query wire protocol.
// Own file on purpose: the node test runner isolates each file in a worker,
// and mixing long-lived HTTP/SSE servers in one process has caused hangs.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'raganyllm-cit-'));
process.env.RAGANYLLM_HOME = HOME;
process.env.RAGANYLLM_QUIET = '1';

const { createServer } = require('../lib/server');

function startFakeOllama() {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ models: [{ name: 'fake-llm:latest' }, { name: 'nomic-embed-text:latest' }] }));
      }
      if (req.url === '/api/embeddings') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }));
      }
      if (req.url === '/api/chat') {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          let body = {};
          try { body = JSON.parse(raw); } catch (e) { /* ignore */ }
          const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
          let canned = 'A streamed answer from the fake model.';
          if (lastUser && /^cite-me grounded/i.test(lastUser.content)) {
            canned = 'The V60 brewer uses a paper filter to remove coffee oils. [1]';
          } else if (lastUser && /^cite-me fake/i.test(lastUser.content)) {
            canned = 'The moon is made of cheese. [1]';
          }
          if (body.stream === false) {
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: canned }, done: true }));
          }
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          const words = canned.split(' ');
          let i = 0;
          const timer = setInterval(() => {
            if (i < words.length) {
              res.write(JSON.stringify({ model: body.model, message: { role: 'assistant', content: words[i] + ' ' }, done: false }) + '\n');
              i++;
            } else {
              clearInterval(timer);
              res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true }));
            }
          }, 5);
        });
        return;
      }
      if (req.url === '/api/show') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ model_info: { 'llama.context_length': 4096 } }));
      }
      res.writeHead(404);
      return res.end('nf');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

function seedKb() {
  fs.writeFileSync(path.join(HOME, 'raganyllm-kb.json'), JSON.stringify({
    documents: [{ id: 'v60', doc_title: 'V60.md', content: 'The V60 brewer uses a paper filter to remove coffee oils.', source: 'File: V60.md', chunk_index: 0 }],
    embeddings: [[1, 0, 0, 0, 0, 0, 0, 0]]
  }));
}

function parseEvents(text) {
  const events = [];
  for (const raw of text.split('\n\n')) {
    if (!raw.startsWith('data:')) continue;
    events.push(JSON.parse(raw.replace(/^data:\s?/, '')));
  }
  return events;
}

let fake;
before(async () => {
  fake = await startFakeOllama();
  process.env.OLLAMA_URL = `http://127.0.0.1:${fake.port}`;
});
after(async () => { if (fake) await fake.close(); });

test('query: SSE citations event keeps a verified grounded marker', async () => {
  seedKb();
  const { port, server } = await createServer(0, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'cite-me grounded', model: 'fake-llm:latest', stream: true, use_rag: true })
    });
    const events = parseEvents(await res.text());
    const types = events.map((e) => e.type);
    assert.ok(types.includes('citations'), 'expected a citations event');
    assert.strictEqual(types[types.length - 1], 'end');
    const cit = events.find((e) => e.type === 'citations');
    assert.strictEqual(cit.markers.length, 1);
    assert.strictEqual(cit.markers[0].source, 1);
    assert.strictEqual(cit.markers[0].supported, true);
    assert.deepStrictEqual(cit.citations[0].sources, [1]);
    assert.ok(!cit.clean.includes('[1]'), 'clean answer carries no markers');
    assert.ok(cit.clean.includes('paper filter'));
  } finally {
    try { if (server.closeAllConnections) server.closeAllConnections(); } catch (e) { /* ignore */ }
    await new Promise((r) => server.close(r));
  }
});

test('query: non-stream response strips an unverified (fake) citation', async () => {
  seedKb();
  const { port, server } = await createServer(0, '127.0.0.1');
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'cite-me fake', model: 'fake-llm:latest', stream: false, use_rag: true })
    });
    const data = await res.json();
    assert.ok(data.answer.includes('The moon is made of cheese.'), 'claim text is kept');
    assert.ok(!data.answer.includes('[1]'), 'fake marker is removed from the answer');
    assert.deepStrictEqual(data.citations, []);
    assert.strictEqual(data.citation_markers.length, 1);
    assert.strictEqual(data.citation_markers[0].supported, false);
  } finally {
    try { if (server.closeAllConnections) server.closeAllConnections(); } catch (e) { /* ignore */ }
    await new Promise((r) => server.close(r));
  }
});
