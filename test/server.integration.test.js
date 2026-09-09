'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Fresh user-data dir for this whole file (paths caches on first use).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'raganyllm-int-'));
process.env.RAGANYLLM_HOME = HOME;
process.env.RAGANYLLM_QUIET = '1';

const { createServer } = require('../lib/server');


// ---------------------------------------------------------------- fake Ollama
const ollamaState = { lastChatMessages: null, createCalls: [], tags: [] };
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
        return res.end(JSON.stringify({ models: ollamaState.tags.map((n) => ({ name: n })) }));
      }
      if (req.url === '/api/embeddings') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }));
      }
      if (req.url === '/api/chat') {
        const body = await readBody(req);
        ollamaState.lastChatMessages = body.messages;
        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          const words = 'A streamed answer from the fake model.'.split(' ');
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
        } else {
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'plain answer' }, done: true }));
        }
        return undefined;
      }
      if (req.url === '/api/show') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ model_info: { 'llama.context_length': 4096 } }));
      }
      if (req.url === '/api/create') {
        const body = await readBody(req);
        ollamaState.createCalls.push(body);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        return res.end(JSON.stringify({ status: 'success' }));
      }
      if (req.url === '/api/delete') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({}));
      }
      res.writeHead(404);
      return res.end('nf');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

let fake;
let baseUrl; // fake ollama url

function seedKb(docsWithEmbs) {
  // docsWithEmbs: [[doc, emb], ...] -> default path in HOME
  const docs = docsWithEmbs.map(([d]) => d);
  const embeddings = docsWithEmbs.map(([, e]) => e);
  fs.writeFileSync(path.join(HOME, 'raganyllm-kb.json'), JSON.stringify({ documents: docs, embeddings }));
}

function seedEmpty() {
  fs.writeFileSync(path.join(HOME, 'raganyllm-kb.json'), JSON.stringify({ documents: [], embeddings: [] }));
}

const EMB = (axis) => { const v = new Array(8).fill(0); v[axis] = 1; return v; };
const DOC = (id, title, content, source = `File: ${title}.md`, idx = 0) => ({ id, doc_title: title, content, source, chunk_index: idx });

async function startApp() {
  const { port, server } = await createServer(0, '127.0.0.1');
  return { port, server };
}
async function stopApp(app) {
  // Force-close keep-alive connections (undici pools sockets; lingering ones
  // hitting a closed server caused worker crashes in the test runner).
  try {
    if (app.server.closeAllConnections) app.server.closeAllConnections();
  } catch (e) { /* ignore */ }
  await new Promise((r) => app.server.close(r));
}

async function reqJson(port, method, url, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-json */ }
  return { status: res.status, data };
}

before(async () => {
  ollamaState.tags = ['fake-llm:latest', 'nomic-embed-text:latest'];
  fake = await startFakeOllama();
  baseUrl = `http://127.0.0.1:${fake.port}`;
  process.env.OLLAMA_URL = baseUrl;
});

after(async () => {
  if (fake) {
    try { if (fake.closeAllConnections) fake.closeAllConnections(); } catch (e) { /* ignore */ }
    await fake.close();
  }
});

test('GET /api/models reports defaults and empty KB', async () => {
  seedEmpty();
  const app = await startApp();
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/models`);
    const d = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(d.connected, true);
    assert.deepStrictEqual(d.retrieval, { top_k: 4, similarity_threshold: 0.4, search_mode: 'vector' });
    assert.strictEqual(d.knowledge_base.total_chunks, 0);
  } finally { await stopApp(app); }
});

test('config partial update preserves custom ollama_url (regression)', async () => {
  seedEmpty();
  const app = await startApp();
  try {
    let r = await reqJson(app.port, 'POST', '/api/config', { ollama_url: 'http://10.0.0.9:11434', search_mode: 'hybrid', top_k: 6 });
    assert.strictEqual(r.status, 200);
    r = await reqJson(app.port, 'POST', '/api/config', { similarity_threshold: 0.55 });
    const c = r.data.config;
    assert.strictEqual(c.ollama_url, 'http://10.0.0.9:11434');
    assert.strictEqual(c.search_mode, 'hybrid');
    assert.strictEqual(c.top_k, 6);
    assert.strictEqual(c.similarity_threshold, 0.55);
    // Reported in /api/models retrieval.
    const m = await (await fetch(`http://127.0.0.1:${app.port}/api/models`)).json();
    assert.strictEqual(m.retrieval.search_mode, 'hybrid');
    // Clean up for later tests.
    await reqJson(app.port, 'POST', '/api/config', { ollama_url: baseUrl, search_mode: 'vector', top_k: 4, similarity_threshold: 0.4 });
  } finally { await stopApp(app); }
});

test('query: vector vs hybrid retrieval over the same KB', async () => {
  seedKb([
    [DOC('a', 'Tea guide', 'Green tea should be brewed at seventy degrees Celsius for three minutes.'), EMB(0)],
    [DOC('b', 'Vintage teaware', 'The vintage vintage vintage teapot collection covers rare vintage porcelain and vintage handles. Vintage spouts and vintage lids are prized. Only vintage teapots are discussed in this guide.'), EMB(1)]
  ]);
  const app = await startApp();
  try {
    const q = { query: 'vintage tea brewing temperature', model: 'fake-llm:latest', stream: false };
    const vec = await reqJson(app.port, 'POST', '/api/query', { ...q, search_mode: 'vector' });
    assert.deepStrictEqual(vec.data.retrieved_sources.map((s) => s.id), ['a']);
    assert.strictEqual(vec.data.retrieval_settings.search_mode, 'vector');
    assert.strictEqual(vec.data.rag_status, 'context_found');

    const hy = await reqJson(app.port, 'POST', '/api/query', { ...q, search_mode: 'hybrid' });
    const ids = hy.data.retrieved_sources.map((s) => s.id);
    assert.ok(ids.includes('a') && ids.includes('b'), `hybrid should return both, got ${ids}`);
  } finally { await stopApp(app); }
});

test('query: JSON non-stream + RAG-off roles + history ordering', async () => {
  seedKb([[DOC('a', 'Doc', 'Some factual knowledge about dragons for retrieval.'), EMB(0)]]);
  const app = await startApp();
  try {
    const r = await reqJson(app.port, 'POST', '/api/query', {
      query: 'tell me about dragons', model: 'fake-llm:latest', stream: false, use_rag: true,
      history: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi there' }]
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.answer, 'plain answer');
    assert.strictEqual(r.data.rag_status, 'context_found');
    const roles = ollamaState.lastChatMessages.map((m) => m.role);
    assert.deepStrictEqual(roles, ['system', 'user', 'assistant', 'user']);

    // RAG off -> no system message at all (model's own Modelfile prompt used).
    await reqJson(app.port, 'POST', '/api/query', {
      query: 'hello', model: 'fake-llm:latest', use_rag: false, history: []
    });
    assert.deepStrictEqual(ollamaState.lastChatMessages.map((m) => m.role), ['user']);

    // System-role entries in history must be filtered out (no prompt injection).
    await reqJson(app.port, 'POST', '/api/query', {
      query: 'x', model: 'fake-llm:latest', use_rag: false,
      history: [{ role: 'system', content: 'EVIL' }, { role: 'user', content: 'u' }]
    });
    assert.deepStrictEqual(ollamaState.lastChatMessages.map((m) => m.role), ['user', 'user']);
    assert.ok(!JSON.stringify(ollamaState.lastChatMessages).includes('EVIL'));
  } finally { await stopApp(app); }
});

test('origin guard rejects state-changing requests from untrusted pages', async () => {
  seedEmpty();
  const app = await startApp();
  try {
    const bad = await reqJson(app.port, 'POST', '/api/clear-kb', {}, { Origin: 'http://evil.example.com' });
    assert.strictEqual(bad.status, 403);
    const badDelete = await fetch(`http://127.0.0.1:${app.port}/api/models/whatever`, {
      method: 'DELETE', headers: { Origin: 'http://evil.example.com' }
    });
    assert.strictEqual(badDelete.status, 403);
    // Trusted (no Origin / localhost) works.
    const ok = await reqJson(app.port, 'POST', '/api/clear-kb', {});
    assert.strictEqual(ok.status, 200);
  } finally { await stopApp(app); }
});

test('delete model verifies against /api/tags before deleting', async () => {
  seedEmpty();
  const app = await startApp();
  try {
    const missing = await reqJson(app.port, 'DELETE', '/api/models/not-installed:latest');
    assert.strictEqual(missing.status, 404);
    const present = await reqJson(app.port, 'DELETE', '/api/models/fake-llm:latest');
    assert.strictEqual(present.status, 200);
  } finally { await stopApp(app); }
});

test('pack export -> clear -> import merge restores KB; duplicate re-import skipped', async () => {
  seedKb([
    [DOC('a1', 'Dragon Care', 'Dragons need warm dry lairs and volcanic ore pellets.', 'File: Dragon Care.md', 0), EMB(0)],
    [DOC('a2', 'Dragon Care', 'Never feed dragons dairy products.', 'File: Dragon Care.md', 1), EMB(1)],
    [DOC('p', 'Potions', 'A calming potion needs moonwater and lavender.', 'File: Potions.md', 0), EMB(2)]
  ]);
  const app = await startApp();
  try {
    const exp = await fetch(`http://127.0.0.1:${app.port}/api/kb/export`);
    const pack = await exp.json();
    assert.strictEqual(pack.format, 'raganyllm-pack');
    assert.strictEqual(pack.knowledge.chunks.length, 3);
    assert.ok(pack.knowledge.embeddings.length === 3);

    await reqJson(app.port, 'POST', '/api/clear-kb', {});
    let m = await (await fetch(`http://127.0.0.1:${app.port}/api/models`)).json();
    assert.strictEqual(m.knowledge_base.total_chunks, 0);

    // Import merge (NDJSON stream).
    const fd = new FormData();
    fd.append('pack', new Blob([JSON.stringify(pack)], { type: 'application/json' }), 'kb.raganyllm');
    fd.append('mode', 'merge');
    const imp = await fetch(`http://127.0.0.1:${app.port}/api/kb/import`, { method: 'POST', body: fd });
    const lines = (await imp.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(lines[lines.length - 1].status, 'complete');
    assert.match(lines[lines.length - 1].message, /3 new chunk/);

    m = await (await fetch(`http://127.0.0.1:${app.port}/api/models`)).json();
    assert.strictEqual(m.knowledge_base.total_chunks, 3);

    // Duplicate re-import merge -> 0 added.
    const fd2 = new FormData();
    fd2.append('pack', new Blob([JSON.stringify(pack)], { type: 'application/json' }), 'kb.raganyllm');
    fd2.append('mode', 'merge');
    const imp2 = await fetch(`http://127.0.0.1:${app.port}/api/kb/import`, { method: 'POST', body: fd2 });
    const lines2 = (await imp2.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.match(lines2[lines2.length - 1].message, /duplicate/);

    // Invalid pack rejected with a friendly error.
    const bad = new FormData();
    bad.append('pack', new Blob([JSON.stringify({ nope: 1 })], { type: 'application/json' }), 'bad.raganyllm');
    bad.append('mode', 'merge');
    const impBad = await fetch(`http://127.0.0.1:${app.port}/api/kb/import`, { method: 'POST', body: bad });
    const linesBad = (await impBad.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(linesBad[linesBad.length - 1].status, 'error');
  } finally { await stopApp(app); }
});

test('encrypted pack: export with password, import with right/wrong password', async () => {
  seedKb([[DOC('a', 'Secret Notes', 'My private vault combination is 7-3-9-1.', 'File: Secret Notes.md'), EMB(0)]]);
  const app = await startApp();
  try {
    // Export with password via POST.
    const exp = await fetch(`http://127.0.0.1:${app.port}/api/kb/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2' })
    });
    const enc = await exp.json();
    assert.strictEqual(enc.format, 'raganyllm-pack-enc');
    assert.ok(enc.ciphertext.length > 100);
    assert.ok(!JSON.stringify(enc).includes('vault'), 'plaintext must not leak into the wrapper');

    // Clear, then import with the WRONG password -> friendly error, KB stays empty.
    await reqJson(app.port, 'POST', '/api/clear-kb', {});
    const fdBad = new FormData();
    fdBad.append('pack', new Blob([JSON.stringify(enc)], { type: 'application/json' }), 'secret.raganyllm');
    fdBad.append('mode', 'merge');
    fdBad.append('password', 'wrong');
    const impBad = await fetch(`http://127.0.0.1:${app.port}/api/kb/import`, { method: 'POST', body: fdBad });
    const linesBad = (await impBad.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(linesBad[linesBad.length - 1].status, 'error');
    assert.match(linesBad[linesBad.length - 1].detail, /password is incorrect|Could not open/);

    // Import with the CORRECT password -> success.
    const fdGood = new FormData();
    fdGood.append('pack', new Blob([JSON.stringify(enc)], { type: 'application/json' }), 'secret.raganyllm');
    fdGood.append('mode', 'merge');
    fdGood.append('password', 'hunter2');
    const impGood = await fetch(`http://127.0.0.1:${app.port}/api/kb/import`, { method: 'POST', body: fdGood });
    const linesGood = (await impGood.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(linesGood[linesGood.length - 1].status, 'complete');
    const m = await (await fetch(`http://127.0.0.1:${app.port}/api/models`)).json();
    assert.strictEqual(m.knowledge_base.total_chunks, 1);

    // Import encrypted pack WITHOUT password -> clear message asking for it.
    await reqJson(app.port, 'POST', '/api/clear-kb', {});
    const fdNone = new FormData();
    fdNone.append('pack', new Blob([JSON.stringify(enc)], { type: 'application/json' }), 'secret.raganyllm');
    fdNone.append('mode', 'merge');
    const impNone = await fetch(`http://127.0.0.1:${app.port}/api/kb/import`, { method: 'POST', body: fdNone });
    const linesNone = (await impNone.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.match(linesNone[linesNone.length - 1].detail, /password-protected/);
  } finally { await stopApp(app); }
});

test('delete-doc, plain exports and samples endpoints', async () => {
  seedKb([[DOC('a', 'Doc A', 'Some content for doc a.'), EMB(0)]]);
  const app = await startApp();
  try {
    const del = await reqJson(app.port, 'POST', '/api/kb/delete-doc', { doc_title: 'Doc A' });
    assert.strictEqual(del.data.removed, 1);
    const del2 = await reqJson(app.port, 'POST', '/api/kb/delete-doc', { doc_title: 'Doc A' });
    assert.strictEqual(del2.status, 404);

    const md = await fetch(`http://127.0.0.1:${app.port}/api/kb/export/markdown`);
    assert.strictEqual(md.status, 400, 'empty KB export is guarded');

    const samples = await (await fetch(`http://127.0.0.1:${app.port}/api/kb/samples`)).json();
    assert.strictEqual(samples.samples.length, 3);
    const load = await fetch(`http://127.0.0.1:${app.port}/api/kb/samples`, { method: 'POST' });
    const loadLines = (await load.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(loadLines[loadLines.length - 1].status, 'complete');
    const m = await (await fetch(`http://127.0.0.1:${app.port}/api/models`)).json();
    assert.ok(m.knowledge_base.total_chunks >= 3);
    // Delete all sample docs to keep state tidy for later tests.
    for (const title of m.knowledge_base.document_titles) {
      await reqJson(app.port, 'POST', '/api/kb/delete-doc', { doc_title: title });
    }
  } finally { await stopApp(app); }
});

test('create-own-AI: analyze-fit + export warns when KB exceeds the model context', async () => {
  const filler = 'Custom knowledge about vintage tea brewing equipment and technique. '.repeat(120);
  seedKb(Array.from({ length: 4 }, (_, i) => [
    DOC('c' + i, `Tea Doc ${i}`, filler + ` section ${i}`), EMB(i % 8)
  ]));
  const app = await startApp();
  try {
    const fit = await reqJson(app.port, 'POST', '/api/kb/analyze-fit', { base_model: 'fake-llm:latest' });
    assert.strictEqual(fit.status, 200);
    assert.strictEqual(fit.data.verdict, 'too_large'); // 4096 ctx vs large KB
    assert.ok(fit.data.estimated_tokens > fit.data.usable_tokens);

    const res = await fetch(`http://127.0.0.1:${app.port}/api/export-ollama-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_model: 'fake-llm:latest', new_model_name: 'tea-bot:latest', custom_instructions: 'Be a tea expert.' })
    });
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    const types = lines.map((l) => l.status);
    assert.ok(types.includes('warning'), 'large-KB build should warn');
    assert.strictEqual(types[types.length - 1], 'complete');
    assert.match(lines[lines.length - 1].message, /tea-bot:latest/);
    assert.strictEqual(ollamaState.createCalls[ollamaState.createCalls.length - 1].name, 'tea-bot:latest');

    // Empty-KB guard.
    await reqJson(app.port, 'POST', '/api/clear-kb', {});
    const empty = await fetch(`http://127.0.0.1:${app.port}/api/export-ollama-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_model: 'fake-llm:latest', new_model_name: 'x:latest' })
    });
    const emptyLines = (await empty.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.strictEqual(emptyLines[emptyLines.length - 1].status, 'error');
  } finally { await stopApp(app); }
});
