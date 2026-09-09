'use strict';
// AI-pack tests (ROADMAP §5.1): Model Forge registry, kind:'ai' export,
// fresh-device import (KB + AI definitions), duplicate-import skip, rebuild.
// Own worker + own RAGANYLLM_HOME + in-process fake Ollama, mirroring
// server.integration.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'raganyllm-ai-'));
process.env.RAGANYLLM_HOME = HOME;
process.env.RAGANYLLM_QUIET = '1';

const { createServer } = require('../lib/server');
const { AI_FILE } = require('../lib/ai-registry');
const { decodeExportBody } = require('./pack-helper');

const ollamaState = { createCalls: [] };

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
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ embedding: [1, 0, 0, 0, 0, 0, 0, 0] }));
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

const EMB = (axis) => { const v = new Array(8).fill(0); v[axis] = 1; return v; };
const DOC = (id, title, content, source = `File: ${title}.md`, idx = 0) => ({ id, doc_title: title, content, source, chunk_index: idx });

function seedKb(docsWithEmbs) {
  fs.writeFileSync(path.join(HOME, 'raganyllm-kb.json'), JSON.stringify({
    documents: docsWithEmbs.map(([d]) => d),
    embeddings: docsWithEmbs.map(([, e]) => e)
  }));
}

async function startApp() {
  const { port, server } = await createServer(0, '127.0.0.1');
  return { port, server };
}
async function stopApp(app) {
  try { if (app.server.closeAllConnections) app.server.closeAllConnections(); } catch (e) { /* ignore */ }
  await new Promise((r) => app.server.close(r));
}
async function reqJson(port, method, url, body) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-json */ }
  return { status: res.status, data };
}
async function streamLines(port, url, body) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('AI pack round trip: build -> registry -> export kind=ai -> fresh-device import -> rebuild', async () => {
  seedKb([
    [DOC('1', 'Coffee manual', 'The V60 blooms for thirty seconds with a gentle spiral pour.', 'File: coffee.md'), EMB(0)],
    [DOC('2', 'Espresso', 'Espresso extracts at nine bars and around ninety-three degrees.', 'File: espresso.md'), EMB(1)]
  ]);
  ollamaState.createCalls.length = 0;

  // Build a custom AI (Model Forge) on device A.
  const appA = await startApp();
  try {
    const build = await streamLines(appA.port, '/api/export-ollama-model', {
      base_model: 'fake-llm:latest',
      new_model_name: 'barista-master',
      custom_instructions: 'Answer only about coffee.'
    });
    assert.strictEqual(build[build.length - 1].status, 'complete');
    assert.match(build[build.length - 1].message, /barista-master:latest/);
    assert.strictEqual(ollamaState.createCalls[ollamaState.createCalls.length - 1].name, 'barista-master:latest');
    assert.match(ollamaState.createCalls[ollamaState.createCalls.length - 1].system, /Answer only about coffee\./);

    // Registry now lists it.
    const ais = await reqJson(appA.port, 'GET', '/api/ais');
    assert.strictEqual(ais.status, 200);
    const rec = ais.data.ais.find((a) => a.name === 'barista-master:latest');
    assert.ok(rec, 'built AI is registered');
    assert.strictEqual(rec.base_model, 'fake-llm:latest');
    assert.strictEqual(rec.custom_instructions, 'Answer only about coffee.');
    assert.strictEqual(rec.kb.documents, 2);

    // Export an AI pack (v2 ZIP container).
    const exp = await fetch(`http://127.0.0.1:${appA.port}/api/kb/export?kind=ai`, { method: 'POST' });
    const { pack, bytes } = await decodeExportBody(exp);
    assert.strictEqual(pack.format, 'raganyllm-pack');
    assert.strictEqual(pack.container, 'zip-v2');
    assert.strictEqual(pack.kind, 'ai');
    assert.strictEqual(pack.knowledge.chunks.length, 2);
    assert.ok(Array.isArray(pack.ai.models) && pack.ai.models.length >= 1);
    assert.strictEqual(pack.ai.models.find((m) => m.name === 'barista-master:latest').custom_instructions, 'Answer only about coffee.');
    // Knowledge-kind exports stay AI-free (backward compatible).
    const expK = await fetch(`http://127.0.0.1:${appA.port}/api/kb/export`, { method: 'POST' });
    const { pack: packK } = await decodeExportBody(expK);
    assert.strictEqual(packK.kind, 'knowledge');
    assert.ok(packK.ai === undefined, 'knowledge packs carry no AI section');

    // Wipe the device: KB + registry gone -> fresh device B.
    fs.rmSync(path.join(HOME, 'raganyllm-kb.json'), { force: true });
    fs.rmSync(AI_FILE, { force: true });
    await reqJson(appA.port, 'POST', '/api/clear-kb', {}); // clear in-memory store too
    const fresh = await (await fetch(`http://127.0.0.1:${appA.port}/api/models`)).json();
    assert.strictEqual(fresh.knowledge_base.total_chunks, 0);

    // Import the AI pack on device B (same store, now empty): KB + AI defs land.
    const fd = new FormData();
    fd.append('pack', new Blob([bytes], { type: 'application/octet-stream' }), 'barista.raganyllm');
    fd.append('mode', 'merge');
    const imp = await fetch(`http://127.0.0.1:${appA.port}/api/kb/import`, { method: 'POST', body: fd });
    const lines = (await imp.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(lines[lines.length - 1].status, 'complete');
    assert.match(lines[lines.length - 1].message, /1 AI definition\(s\) registered/);

    const m = await (await fetch(`http://127.0.0.1:${appA.port}/api/models`)).json();
    assert.strictEqual(m.knowledge_base.total_chunks, 2);
    const ais2 = await reqJson(appA.port, 'GET', '/api/ais');
    assert.strictEqual(ais2.data.ais.length, 1);
    assert.strictEqual(ais2.data.ais[0].name, 'barista-master:latest');

    // Importing the same pack again: chunks AND AI defs are deduped.
    const fd2 = new FormData();
    fd2.append('pack', new Blob([bytes], { type: 'application/octet-stream' }), 'barista.raganyllm');
    fd2.append('mode', 'merge');
    const imp2 = await fetch(`http://127.0.0.1:${appA.port}/api/kb/import`, { method: 'POST', body: fd2 });
    const lines2 = (await imp2.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.match(lines2[lines2.length - 1].message, /all 1 AI definition\(s\) already on this device/);

    // Rebuild the imported AI from the current KB.
    const rb = await streamLines(appA.port, '/api/ai/rebuild', { name: 'barista-master:latest' });
    assert.strictEqual(rb[rb.length - 1].status, 'complete');
    assert.match(rb[rb.length - 1].message, /barista-master:latest/);
    assert.strictEqual(ollamaState.createCalls[ollamaState.createCalls.length - 1].name, 'barista-master:latest');

    // Unknown AI / missing body are rejected cleanly.
    const rbBad = await streamLines(appA.port, '/api/ai/rebuild', { name: 'ghost:latest' });
    assert.strictEqual(rbBad[0].status, 'error');
    assert.match(rbBad[0].detail, /No registered AI/);
  } finally {
    await stopApp(appA);
  }
});
