'use strict';
// §1.1 First-Run Wizard endpoints: setup status (first-run detection, health),
// persona presets applied to config, completion persistence, and KB-derived
// suggestion questions. Own worker + own HOME + minimal fake Ollama (/api/tags).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'raganyllm-setup-'));
process.env.RAGANYLLM_HOME = HOME;
process.env.RAGANYLLM_QUIET = '1';

const { createServer } = require('../lib/server');

function startFakeOllama(tags) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ models: tags.map((n) => ({ name: n })) }));
      }
      res.writeHead(404);
      return res.end('nf');
    });
    srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

let fake;
before(async () => {
  fake = await startFakeOllama(['llama3.2:3b', 'nomic-embed-text:latest']);
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

test('fresh install reports first_run with a healthy checklist; presets documented', async () => {
  seedKb([]);
  const app = await startApp();
  try {
    const st = await reqJson(app.port, 'GET', '/api/setup/status');
    assert.strictEqual(st.status, 200);
    assert.strictEqual(st.data.first_run, true, 'brand-new config is a first run');
    assert.strictEqual(st.data.persona, null);
    assert.strictEqual(st.data.ollama.connected, true);
    assert.strictEqual(st.data.embedding.installed, true);
    assert.strictEqual(st.data.kb.chunks, 0);
    assert.ok(st.data.presets && st.data.presets.qa && st.data.presets.notes, 'persona presets exposed for the picker');
  } finally { await stopApp(app); }
});

test('persona applies retrieval presets; unknown persona is rejected', async () => {
  seedKb([]);
  const app = await startApp();
  try {
    const bad = await reqJson(app.port, 'POST', '/api/setup/persona', { persona: 'alien' });
    assert.strictEqual(bad.status, 400);

    const res = await reqJson(app.port, 'POST', '/api/setup/persona', { persona: 'qa' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.ok, true);
    assert.strictEqual(res.data.recommended_chat, 'llama3.2:3b');

    const cfg = await reqJson(app.port, 'GET', '/api/config');
    assert.strictEqual(cfg.data.search_mode, 'hybrid');
    assert.strictEqual(cfg.data.top_k, 6);
    assert.strictEqual(cfg.data.similarity_threshold, 0.45);

    const st = await reqJson(app.port, 'GET', '/api/setup/status');
    assert.strictEqual(st.data.persona, 'qa');
    assert.strictEqual(st.data.first_run, true, 'persona alone does not complete setup');
  } finally { await stopApp(app); }
});

test('setup completion persists across restarts', async () => {
  seedKb([]);
  const app = await startApp();
  try {
    const done = await reqJson(app.port, 'POST', '/api/setup/complete', { persona: 'notes' });
    assert.strictEqual(done.status, 200);
    assert.strictEqual(done.data.status.first_run, false);
    assert.strictEqual(done.data.status.persona, 'notes');
    assert.strictEqual(done.data.status.recommended_chat, 'qwen2.5:3b');
  } finally { await stopApp(app); }

  // A fresh server on the same HOME remembers completion.
  const app2 = await startApp();
  try {
    const st = await reqJson(app2.port, 'GET', '/api/setup/status');
    assert.strictEqual(st.data.first_run, false);
    assert.strictEqual(st.data.persona, 'notes');
  } finally { await stopApp(app2); }
});

test('suggestion questions come from KB titles; generic when the KB is empty', async () => {
  seedKb([
    [{ id: '1', doc_title: 'Coffee Manual', content: 'The V60 blooms for thirty seconds.', source: 'File: coffee.md', chunk_index: 0 }, EMB(0)],
    [{ id: '2', doc_title: 'Espresso', content: 'Espresso extracts at nine bars.', source: 'File: espresso.md', chunk_index: 0 }, EMB(1)]
  ]);
  const app = await startApp();
  try {
    const q = await reqJson(app.port, 'GET', '/api/setup/questions');
    assert.strictEqual(q.status, 200);
    assert.strictEqual(q.data.has_kb, true);
    assert.ok(Array.isArray(q.data.questions) && q.data.questions.length === 3);
    assert.ok(q.data.questions.every((x) => typeof x === 'string' && x.length > 5));
    assert.ok(q.data.questions.some((x) => x.includes('Coffee Manual')));
  } finally { await stopApp(app); }

  seedKb([]);
  const app2 = await startApp();
  try {
    const q2 = await reqJson(app2.port, 'GET', '/api/setup/questions');
    assert.strictEqual(q2.data.has_kb, false);
    assert.strictEqual(q2.data.questions.length, 3);
  } finally { await stopApp(app2); }
});
