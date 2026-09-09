'use strict';
// LAN share tests (ROADMAP §5.4): single-use, auto-expiring transfer links.
// Covers minting, the browser page + meta, single-use download consumption,
// expiry, and the receiving app importing through the link (server-to-server,
// sender KB untouched, wrong-password retry via the recipient's short cache).
// Own worker + own RAGANYLLM_HOME, mirroring server.integration.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'raganyllm-share-'));
process.env.RAGANYLLM_HOME = HOME;
process.env.RAGANYLLM_QUIET = '1';

const { createServer } = require('../lib/server');
const packLib = require('../lib/pack');
const { AI_FILE } = require('../lib/ai-registry');

const EMB = (axis) => { const v = new Array(8).fill(0); v[axis] = 1; return v; };
const DOC = (id, title, content, source = `File: ${title}.md`, idx = 0) => ({ id, doc_title: title, content, source, chunk_index: idx });

function seedKb(docsWithEmbs) {
  fs.writeFileSync(path.join(HOME, 'raganyllm-kb.json'), JSON.stringify({
    documents: docsWithEmbs.map(([d]) => d),
    embeddings: docsWithEmbs.map(([, e]) => e)
  }));
}
function seedEmpty() {
  fs.writeFileSync(path.join(HOME, 'raganyllm-kb.json'), JSON.stringify({ documents: [], embeddings: [] }));
}
function seedAis(models) {
  fs.writeFileSync(AI_FILE, JSON.stringify({ ais: models }, null, 2));
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
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
async function kbChunks(port) {
  const r = await reqJson(port, 'GET', '/api/models');
  return r.data && r.data.knowledge_base ? r.data.knowledge_base.total_chunks : null;
}

test('share mint: page, meta, QR and single-use download consumption', async () => {
  seedKb([
    [DOC('1', 'V60', 'The V60 blooms for thirty seconds with a gentle spiral pour.', 'File: v60.md'), EMB(0)],
    [DOC('2', 'AeroPress', 'The AeroPress uses pressure and a short steep time.', 'File: aeropress.md'), EMB(1)]
  ]);
  const appA = await startApp();
  try {
    const base = `http://127.0.0.1:${appA.port}`;
    const share = await reqJson(appA.port, 'POST', '/api/kb/share', { base_url: base });
    assert.strictEqual(share.status, 200);
    assert.strictEqual(share.data.ok, true);
    assert.ok(share.data.token && share.data.token.length >= 10);
    assert.strictEqual(share.data.path, `/packs/share/${share.data.token}`);
    assert.strictEqual(share.data.url, `${base}${share.data.path}`);
    assert.ok(share.data.qr_svg && share.data.qr_svg.includes('<svg'), 'QR code is generated from the base_url');
    assert.strictEqual(share.data.single_use, true);
    assert.strictEqual(share.data.ttl_minutes, 60);
    assert.strictEqual(share.data.summary.kind, 'knowledge');
    assert.strictEqual(share.data.summary.chunk_count, 2);
    assert.ok(share.data.warning, 'loopback binding yields a helpful warning');

    const meta = await reqJson(appA.port, 'GET', share.data.path + '/meta');
    assert.strictEqual(meta.status, 200);
    assert.strictEqual(meta.data.chunk_count, 2);

    const page = await fetch(`${base}${share.data.path}`);
    assert.strictEqual(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(share.data.token));
    assert.ok(html.includes('Download the .raganyllm pack'));

    // Single-use download: first fetch delivers the ZIP; then it is gone.
    const dl = await fetch(`${base}${share.data.path}/download`);
    assert.strictEqual(dl.status, 200);
    const bytes = Buffer.from(await dl.arrayBuffer());
    assert.ok(bytes.slice(0, 2).toString() === 'PK', 'download is the v2 ZIP container');
    const decoded = packLib.decodePack(bytes, '');
    assert.strictEqual(decoded.ok, true);
    assert.strictEqual(decoded.pack.knowledge.chunks.length, 2);

    const gone = await reqJson(appA.port, 'GET', share.data.path + '/meta');
    assert.strictEqual(gone.status, 410, 'link is consumed after the single download');
    const page2 = await fetch(`${base}${share.data.path}`);
    assert.strictEqual(page2.status, 410);
  } finally { await stopApp(appA); }
});

test('recipient imports through the sender link; sender KB untouched; retry does not need a re-share', async () => {
  seedKb([
    [DOC('1', 'Espresso', 'Espresso extracts at nine bars around ninety-three degrees.', 'File: espresso.md'), EMB(0)],
    [DOC('2', 'Grind', 'Finer grinds extract faster, so the shot runs slower.', 'File: grind.md'), EMB(1)],
    [DOC('3', 'Water', 'Water around ninety-two to ninety-six degrees suits light roasts.', 'File: water.md'), EMB(2)]
  ]);
  const appA = await startApp(); // sender (device A)
  try {
    const baseA = `http://127.0.0.1:${appA.port}`;
    const share = await reqJson(appA.port, 'POST', '/api/kb/share', { base_url: baseA, password: 's3cret' });
    assert.strictEqual(share.status, 200);
    assert.strictEqual(share.data.summary.protected, true);

    // Garbage URLs are rejected with a readable error before any network I/O.
    const bad = await streamLines(appA.port, '/api/kb/import-link', { url: 'http://example.com/not-a-share' });
    assert.strictEqual(bad[bad.length - 1].status, 'error');
    assert.match(bad[bad.length - 1].detail, /share link/);

    // Device B (fresh KB) imports from the sender's link.
    seedEmpty();
    const appB = await startApp();
    try {
      // Wrong password: B already took the single-use download (A's token is
      // consumed), but B cached the bytes so a retry still works.
      const wrong = await streamLines(appB.port, '/api/kb/import-link', {
        url: share.data.url, mode: 'merge', password: 'nope'
      });
      assert.strictEqual(wrong[wrong.length - 1].status, 'error');
      assert.match(wrong[wrong.length - 1].detail, /password|decrypt/i);
      assert.strictEqual(await kbChunks(appB.port), 0, 'failed import changes nothing');

      const consumed = await reqJson(appA.port, 'GET', share.data.path + '/meta');
      assert.strictEqual(consumed.status, 410, 'the remote link was consumed by the download');

      // Retry with the right password succeeds from B's cache.
      const good = await streamLines(appB.port, '/api/kb/import-link', {
        url: share.data.url, mode: 'merge', password: 's3cret'
      });
      assert.strictEqual(good[good.length - 1].status, 'complete');
      assert.match(good[good.length - 1].message, /3 new chunk\(s\) imported/);
      assert.strictEqual(await kbChunks(appB.port), 3);

      // Sender KB is untouched (import never ran on device A).
      assert.strictEqual(await kbChunks(appA.port), 3);

      // Duplicate re-import of the same pack merges to zero new chunks.
      const dup = await streamLines(appB.port, '/api/kb/import-link', {
        url: share.data.url, mode: 'merge', password: 's3cret'
      });
      assert.strictEqual(dup[dup.length - 1].status, 'complete');
      assert.match(dup[dup.length - 1].message, /0 new chunk\(s\) imported/);
      assert.match(dup[dup.length - 1].message, /duplicate\(s\) skipped/);
    } finally { await stopApp(appB); }
  } finally { await stopApp(appA); }
});

test('share links auto-expire', async () => {
  process.env.RAGANYLLM_SHARE_TTL_MINUTES = '0.05'; // 3 seconds
  try {
    seedKb([[DOC('1', 'Temp', 'Temperature and time matter in brewing.', 'File: temp.md'), EMB(0)]]);
    const appA = await startApp();
    try {
      const base = `http://127.0.0.1:${appA.port}`;
      const share = await reqJson(appA.port, 'POST', '/api/kb/share', { base_url: base });
      assert.strictEqual(share.status, 200);
      assert.strictEqual(share.data.ttl_minutes, 0, 'sub-minute TTL is reported as 0 minutes');

      const fresh = await reqJson(appA.port, 'GET', share.data.path + '/meta');
      assert.strictEqual(fresh.status, 200);

      await new Promise((r) => setTimeout(r, 3400));
      const expired = await reqJson(appA.port, 'GET', share.data.path + '/meta');
      assert.strictEqual(expired.status, 410, 'expired links refuse access');
      const page = await fetch(`${base}${share.data.path}`);
      assert.strictEqual(page.status, 410);
    } finally { await stopApp(appA); }
  } finally { delete process.env.RAGANYLLM_SHARE_TTL_MINUTES; }
});

test('AI packs can be shared too (meta + page advertise the custom AIs)', async () => {
  seedKb([
    [DOC('1', 'Coffee manual', 'The V60 blooms for thirty seconds with a gentle spiral pour.', 'File: coffee.md'), EMB(0)],
    [DOC('2', 'Espresso', 'Espresso extracts at nine bars around ninety-three degrees.', 'File: espresso.md'), EMB(1)]
  ]);
  seedAis([{
    name: 'barista-master:latest', base_model: 'fake-llm:latest',
    custom_instructions: 'Answer only about coffee.', created_at: '2026-09-09T00:00:00.000Z', updated_at: '2026-09-09T00:00:00.000Z'
  }]);
  const appA = await startApp();
  try {
    const base = `http://127.0.0.1:${appA.port}`;
    const share = await reqJson(appA.port, 'POST', '/api/kb/share', { base_url: base, kind: 'ai' });
    assert.strictEqual(share.status, 200);
    assert.strictEqual(share.data.summary.kind, 'ai');
    assert.deepStrictEqual(share.data.summary.ai_models, ['barista-master:latest']);

    const meta = await reqJson(appA.port, 'GET', share.data.path + '/meta');
    assert.deepStrictEqual(meta.data.ai_models, ['barista-master:latest']);

    const page = await fetch(`${base}${share.data.path}`);
    const html = await page.text();
    assert.ok(html.includes('AI knowledge pack'));
    assert.ok(html.includes('custom AI'));

    // The shared bytes are a genuine AI-kind ZIP pack.
    const dl = await fetch(`${base}${share.data.path}/download`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    const decoded = packLib.decodePack(bytes, '');
    assert.strictEqual(decoded.pack.kind, 'ai');
    assert.strictEqual(decoded.pack.ai.models.length, 1);
  } finally { await stopApp(appA); }
});
