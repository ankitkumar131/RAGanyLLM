'use strict';
// §2.3 prompt-family + §1.3 detail metadata, §5.5 CSV/pretty-HTML exports and
// §6 structured logs (/api/logs + file). Own worker + own HOME.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'raganyllm-ops-'));
process.env.RAGANYLLM_HOME = HOME;
process.env.RAGANYLLM_QUIET = '1';

const { createServer } = require('../lib/server');
const logLib = require('../lib/log');

const ollamaState = { lastChat: null };
function startFakeOllama() {
  return new Promise((resolve) => {
    const readBody = (req) => new Promise((r) => {
      let d = '';
      req.on('data', (c) => { d += c; });
      req.on('end', () => { try { r(JSON.parse(d)); } catch (e) { r({}); } });
    });
    const srv = http.createServer(async (req, res) => {
      const body = await readBody(req);
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ models: [{ name: 'fake-llm:latest' }, { name: 'nomic-embed-text:latest' }] }));
      }
      if (req.url === '/api/embeddings') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ embedding: [1, 0, 0, 0] }));
      }
      if (req.url === '/api/show') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ model_info: { 'llama.context_length': 8192 } }));
      }
      if (req.url === '/api/chat') {
        ollamaState.lastChat = body;
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'plain answer' }, done: true }));
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

function seedKb(rows) {
  fs.writeFileSync(path.join(HOME, 'raganyllm-kb.json'), JSON.stringify({
    documents: rows.map((r) => r[0]),
    embeddings: rows.map((r) => r[1])
  }));
}
const EMB = (axis) => { const v = new Array(8).fill(0); v[axis] = 1; return v; };
async function startApp() {
  const { port, server } = await createServer(0, '127.0.0.1');
  return { port, server };
}
async function stopApp(app) {
  try { if (app.server.closeAllConnections) app.server.closeAllConnections(); } catch (e) { /* ignore */ }
  await new Promise((r) => app.server.close(r));
}

test('query meta reports prompt family + detail; system prompt uses both', async () => {
  seedKb([
    [{ id: '1', doc_title: 'A & <B>', content: 'alpha', source: 'File: a.md', chunk_index: 0 }, EMB(0)],
    [{ id: '2', doc_title: 'C', content: 'beta', source: 'File: c.md', chunk_index: 0 }, EMB(1)]
  ]);
  const app = await startApp();
  try {
    ollamaState.lastChat = null;
    const res = await fetch(`http://127.0.0.1:${app.port}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'alpha?', model: 'qwen2.5:7b', detail: 'concise' })
    });
    assert.strictEqual(res.status, 200);
    const d = await res.json();
    assert.strictEqual(d.retrieval_settings.detail, 'concise');
    assert.strictEqual(d.prompt_family, 'qwen');
    const system = (ollamaState.lastChat.messages || []).map((m) => m.content || '').join('\n');
    assert.ok(system.includes('Qwen-family models'), 'family template applied');
    assert.ok(system.includes('Keep the answer short'), 'concise detail applied');
    assert.ok(system.includes('alpha'), 'context included');

    // Default (no detail) -> balanced + null echo + generic default family.
    ollamaState.lastChat = null;
    const res2 = await fetch(`http://127.0.0.1:${app.port}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'beta?', model: 'totally-unknown:latest' })
    });
    const d2 = await res2.json();
    assert.strictEqual(d2.retrieval_settings.detail, null);
    assert.strictEqual(d2.prompt_family, 'default');
    const system2 = (ollamaState.lastChat.messages || []).map((m) => m.content || '').join('\n');
    assert.ok(system2.includes('Be concise, accurate, and structured'));
    assert.ok(system2.includes('Answer clearly and accurately'), 'neutral family note');
  } finally { await stopApp(app); }
});

test('CSV + pretty-HTML report exports quote/escape safely and 400 on empty KB', async () => {
  seedKb([
    [{ id: '1', doc_title: 'Title, "quoted"', content: 'line one\n"double" quote', source: 'File: a.md', chunk_index: 0 }, EMB(0)],
    [{ id: '2', doc_title: '<Script & Co>', content: 'beta', source: 'File: c.md', chunk_index: 0 }, EMB(1)]
  ]);
  const app = await startApp();
  try {
    const csv = await fetch(`http://127.0.0.1:${app.port}/api/kb/export/csv`);
    assert.strictEqual(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    const csvText = await csv.text();
    assert.ok(csvText.includes('"Title, ""quoted"""'), 'RFC-4180 quoting of commas/quotes');
    assert.ok(csvText.includes('"line one\n""double"" quote"'), 'newlines quoted');

    const rep = await fetch(`http://127.0.0.1:${app.port}/api/kb/export/report`);
    assert.strictEqual(rep.status, 200);
    assert.match(rep.headers.get('content-type'), /text\/html/);
    const html = await rep.text();
    assert.ok(html.includes('&lt;Script &amp; Co&gt;'), 'HTML escaping');
    assert.ok(html.includes('>2<'), 'doc count rendered');

  } finally { await stopApp(app); }

  // Empty KB -> 400 for both (fresh instance so the store is really empty).
  seedKb([]);
  const empty = await startApp();
  try {
    const csv2 = await fetch(`http://127.0.0.1:${empty.port}/api/kb/export/csv`);
    assert.strictEqual(csv2.status, 400);
    const rep2 = await fetch(`http://127.0.0.1:${empty.port}/api/kb/export/report`);
    assert.strictEqual(rep2.status, 400);
  } finally { await stopApp(empty); }
});

test('structured logs: /api/logs serves the ring and a file is written on disk', async () => {
  const app = await startApp();
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/logs?lines=50`);
    assert.strictEqual(res.status, 200);
    const d = await res.json();
    assert.ok(Array.isArray(d.logs) && d.logs.length > 0, 'server-start is logged');
    assert.ok(d.logs.every((l) => l.ts && l.level && l.event), 'records are structured');
    assert.ok(d.logs.some((l) => l.event === 'server-start'));
    assert.ok(fs.existsSync(path.join(d.log_dir, 'raganyllm.log')), 'log file written');

    // Ring limit + library works standalone too.
    logLib.info('unit-test', 'a record', { n: 1 });
    assert.ok(logLib.ring().some((l) => l.event === 'unit-test'));
    const tail = await (await fetch(`http://127.0.0.1:${app.port}/api/logs?lines=1`)).json();
    assert.strictEqual(tail.logs[tail.logs.length - 1].event, 'unit-test');
  } finally { await stopApp(app); }
});
