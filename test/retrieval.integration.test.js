'use strict';
// §2.2 advanced-retrieval integration tests: metadata filters, query
// expansion, LLM rerank, HyDE. Own worker + HOME + marker-aware fake Ollama:
// the fake embedding maps known keywords to distinct axes and the fake chat
// recognizes the pipeline prompts (HYPOTHETICAL_DOCUMENT / EXPAND_SEARCH_QUERIES
// / RERANK_CANDIDATES) so each stage's behavior is deterministic.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'raganyllm-r2-'));
process.env.RAGANYLLM_HOME = HOME;
process.env.RAGANYLLM_QUIET = '1';

const { createServer } = require('../lib/server');

const ollamaState = { embeddingsCalls: 0, featureCalls: [] };

const EMB = (axis) => { const v = new Array(8).fill(0); v[axis] = 1; return v; };
// Keyword -> embedding axis (order matters: porcelain wins over vintage/tea).
function embFor(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('porcelain')) return EMB(2);
  if (t.includes('vintage')) return EMB(1);
  if (t.includes('tea')) return EMB(0);
  return EMB(3);
}

function startFakeOllama() {
  return new Promise((resolve) => {
    const readBody = (req) => new Promise((r) => {
      let d = '';
      req.on('data', (c) => { d += c; });
      req.on('end', () => { try { r(JSON.parse(d)); } catch (e) { r({}); } });
    });
    const srv = http.createServer(async (req, res) => {
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ models: [{ name: 'fake-llm:latest' }, { name: 'nomic-embed-text:latest' }] }));
      }
      if (req.url === '/api/embeddings') {
        const body = await readBody(req);
        ollamaState.embeddingsCalls++;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ embedding: embFor(body.prompt) }));
      }
      if (req.url === '/api/chat') {
        const body = await readBody(req);
        const system = (body.messages || []).map((m) => m.content || '').join(' ');
        if (!body.stream) {
          res.setHeader('Content-Type', 'application/json');
          if (system.includes('HYPOTHETICAL_DOCUMENT')) {
            ollamaState.featureCalls.push('hyde');
            return res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'A collector guide to vintage porcelain teapots and tea brewing.' }, done: true }));
          }
          if (system.includes('EXPAND_SEARCH_QUERIES')) {
            ollamaState.featureCalls.push('expand');
            return res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: '["vintage teaware handles","porcelain collection guide"]' }, done: true }));
          }
          if (system.includes('RERANK_CANDIDATES')) {
            ollamaState.featureCalls.push('rerank');
            const user = (body.messages || []).map((m) => m.content || '').join('\n');
            const n = (user.match(/\[(\d+)\]/g) || []).length;
            const idx = [];
            for (let i = n - 1; i >= 0; i--) idx.push(i);
            return res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: JSON.stringify({ indices: idx }) }, done: true }));
          }
          return res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'plain answer' }, done: true }));
        }
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        const words = 'streamed answer.'.split(' ');
        let i = 0;
        const timer = setInterval(() => {
          if (i < words.length) {
            res.write(JSON.stringify({ model: body.model, message: { role: 'assistant', content: words[i] + ' ' }, done: false }) + '\n');
            i++;
          } else {
            clearInterval(timer);
            res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true }));
          }
        }, 4);
        return undefined;
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

let fake;
before(async () => {
  fake = await startFakeOllama();
  process.env.OLLAMA_URL = `http://127.0.0.1:${fake.port}`;
});
after(async () => { if (fake) await fake.close(); });

const DOC = (id, title, content, source = `File: ${title}.md`, idx = 0) => ({ id, doc_title: title, content, source, chunk_index: idx });

function seedKb(docsWithEmbs) {
  fs.writeFileSync(path.join(HOME, 'raganyllm-kb.json'), JSON.stringify({
    documents: docsWithEmbs.map(([d]) => d),
    embeddings: docsWithEmbs.map(([, e]) => e)
  }));
}
function seedThreeDocs() {
  seedKb([
    [DOC('a', 'Tea guide', 'Green tea steeps at seventy degrees.', 'File: Tea guide.md'), EMB(0)],
    [DOC('b', 'Vintage teaware', 'Vintage teapots and vintage porcelain handles.', 'Web: https://example.test/vintage'), EMB(1)],
    [DOC('c', 'Porcelain', 'Fine porcelain collection notes and care.', 'Web: https://example.test/porcelain'), EMB(2)]
  ]);
}

async function startApp() {
  const { port, server } = await createServer(0, '127.0.0.1');
  return { port, server };
}
async function stopApp(app) {
  try { if (app.server.closeAllConnections) app.server.closeAllConnections(); } catch (e) { /* ignore */ }
  await new Promise((r) => app.server.close(r));
}
async function ask(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'fake-llm:latest', stream: false, use_rag: true, ...body })
  });
  const data = await res.json();
  return {
    status: res.status,
    meta: data, // non-stream body carries the meta fields at top level
    sources: data.retrieved_sources || [],
    data
  };
}
async function saveConfig(port, obj) {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  });
  return res.json();
}

test('metadata filters scope retrieval to chosen documents/sources', async () => {
  seedThreeDocs();
  const app = await startApp();
  try {
    // No filter: 'vintage' (EMB1) retrieves only the vintage doc.
    const plain = await ask(app.port, { query: 'vintage teapot handles' });
    assert.strictEqual(plain.meta.retrieval_settings.filter_docs, null);
    assert.deepStrictEqual(plain.sources.map((s) => s.doc_title), ['Vintage teaware']);

    // filter_docs = Tea guide while asking about vintage -> excluded -> no context.
    const blocked = await ask(app.port, { query: 'vintage teapot handles', filter_docs: ['Tea guide'] });
    assert.deepStrictEqual(blocked.meta.retrieval_settings.filter_docs, ['Tea guide']);
    assert.strictEqual(blocked.meta.rag_status, 'no_context');
    assert.deepStrictEqual(blocked.sources, []);

    // filter_docs keeps exactly the allowed doc.
    const kept = await ask(app.port, { query: 'vintage teapot handles', filter_docs: ['Vintage teaware'] });
    assert.deepStrictEqual(kept.sources.map((s) => s.doc_title), ['Vintage teaware']);

    // filter_source restricts to local files.
    const files = await ask(app.port, { query: 'tea steeping temperature', filter_source: 'File:' });
    assert.strictEqual(files.meta.retrieval_settings.filter_source, 'File:');
    assert.deepStrictEqual(files.sources.map((s) => s.doc_title), ['Tea guide']);
    const web = await ask(app.port, { query: 'porcelain care notes', filter_source: 'File:' });
    assert.deepStrictEqual(web.sources, []); // porcelain doc is a Web source

    // Unknown doc title -> empty.
    const none = await ask(app.port, { query: 'tea steeping temperature', filter_docs: ['Not a doc'] });
    assert.deepStrictEqual(none.sources, []);
  } finally { await stopApp(app); }
});

test('query expansion runs extra searches and merges their hits', async () => {
  seedThreeDocs();
  ollamaState.featureCalls = [];
  const app = await startApp();
  try {
    // Baseline without expansion: tea query (EMB0) only hits the tea doc.
    const before = ollamaState.embeddingsCalls;
    const base = await ask(app.port, { query: 'tea steeping temperature', top_k: 3 });
    const baseEmbCalls = ollamaState.embeddingsCalls - before;
    assert.strictEqual(base.meta.retrieval_settings.query_expansion, false);
    assert.deepStrictEqual(base.sources.map((s) => s.doc_title), ['Tea guide']);

    // With expansion: two extra paraphrases add vintage + porcelain hits.
    const before2 = ollamaState.embeddingsCalls;
    const exp = await ask(app.port, { query: 'tea steeping temperature', top_k: 3, query_expansion: true });
    assert.strictEqual(exp.meta.retrieval_settings.query_expansion, true);
    const delta = ollamaState.embeddingsCalls - before2;
    assert.strictEqual(delta, baseEmbCalls + 2, 'one embed per extra paraphrase');
    assert.ok(ollamaState.featureCalls.includes('expand'));
    const titles = exp.sources.map((s) => s.doc_title).sort();
    assert.deepStrictEqual(titles, ['Porcelain', 'Tea guide', 'Vintage teaware']);
  } finally { await stopApp(app); }
});

test('LLM rerank reorders the candidate pool', async () => {
  seedThreeDocs();
  ollamaState.featureCalls = [];
  const app = await startApp();
  try {
    // Threshold 0 admits all three docs (orthogonal vectors score 0), giving
    // the reranker three candidates.
    const res = await ask(app.port, {
      query: 'kettle brewing methods',
      top_k: 3,
      similarity_threshold: 0,
      rerank: true
    });
    assert.strictEqual(res.meta.retrieval_settings.rerank, true);
    assert.ok(ollamaState.featureCalls.includes('rerank'));
    // Fake reranker reverses the list -> porcelain first.
    const titles = res.sources.map((s) => s.doc_title);
    assert.deepStrictEqual(titles, ['Porcelain', 'Vintage teaware', 'Tea guide']);
  } finally { await stopApp(app); }
});

test('HyDE retrieves with a hypothetical-passage embedding', async () => {
  seedThreeDocs();
  ollamaState.featureCalls = [];
  const app = await startApp();
  try {
    // Direct 'vintage' query hits the vintage doc (EMB1). The fake HyDE
    // passage mentions porcelain (EMB2) so HyDE should surface the porcelain
    // doc instead — proving the hypothetical embedding was used.
    const direct = await ask(app.port, { query: 'vintage teapot collecting' });
    assert.deepStrictEqual(direct.sources.map((s) => s.doc_title), ['Vintage teaware']);

    const hyde = await ask(app.port, { query: 'vintage teapot collecting', hyde: true });
    assert.strictEqual(hyde.meta.retrieval_settings.hyde, true);
    assert.ok(hyde.meta.hyde_passage && hyde.meta.hyde_passage.length > 0);
    assert.ok(ollamaState.featureCalls.includes('hyde'));
    assert.deepStrictEqual(hyde.sources.map((s) => s.doc_title), ['Porcelain']);
  } finally { await stopApp(app); }
});

test('config toggles enable the enhancements without per-request flags', async () => {
  seedThreeDocs();
  ollamaState.featureCalls = [];
  const app = await startApp();
  try {
    const saved = await saveConfig(app.port, { rerank_enabled: true, query_expansion_enabled: true, hyde_enabled: true });
    assert.strictEqual(saved.config.rerank_enabled, true);
    assert.strictEqual(saved.config.query_expansion_enabled, true);
    assert.strictEqual(saved.config.hyde_enabled, true);
    const res = await ask(app.port, { query: 'kettle brewing methods', top_k: 3, similarity_threshold: 0 });
    assert.strictEqual(res.meta.retrieval_settings.rerank, true);
    assert.strictEqual(res.meta.retrieval_settings.query_expansion, true);
    assert.strictEqual(res.meta.retrieval_settings.hyde, true);
    for (const f of ['rerank', 'expand', 'hyde']) assert.ok(ollamaState.featureCalls.includes(f), f);
    // Turn everything back off for the remaining tests.
    await saveConfig(app.port, { rerank_enabled: false, query_expansion_enabled: false, hyde_enabled: false });
  } finally { await stopApp(app); }
});
