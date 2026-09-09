const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const v4 = crypto.randomUUID || (() => Math.random().toString(36).substr(2, 9));

// Optional password protection for knowledge packs (ROADMAP §5.1).
// Wrapper format: { format:'raganyllm-pack-enc', version:1, kdf, cipher,
// ciphertext } where ciphertext holds the encrypted inner pack JSON.
function encryptPackJson(innerJson, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(password), salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(innerJson), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    format: 'raganyllm-pack-enc',
    version: 1,
    kdf: { name: 'scrypt', salt: salt.toString('base64') },
    cipher: { algo: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64') },
    ciphertext: ciphertext.toString('base64')
  });
}

function decryptPackJson(outer, password) {
  const salt = Buffer.from(outer.kdf.salt, 'base64');
  const iv = Buffer.from(outer.cipher.iv, 'base64');
  const tag = Buffer.from(outer.cipher.tag, 'base64');
  const key = crypto.scryptSync(String(password), salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // Throws on wrong password / tampered file (GCM authentication failure).
  const plain = Buffer.concat([decipher.update(Buffer.from(outer.ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

const VectorStore = require('./vector-store');
const { checkOllamaConnection } = require('./checker');
const { getDataDir } = require('./paths');
const { getConfig, saveConfig, clampInt, clampFloat } = require('./config');

// Small factual starter documents — the optional one-click "try it" on-ramp.
const SAMPLE_DOCS = [
  {
    title: 'What is RAG (Retrieval-Augmented Generation)?',
    source: 'Sample: RAG explainer',
    content: `Retrieval-Augmented Generation (RAG) is a technique that gives an AI model access to your own documents.
It works in three steps.
First, your documents are cut into small pieces called chunks, and each chunk is converted into a list of numbers called an embedding.
Second, when you ask a question, the question is converted into an embedding too, and the system finds the chunks whose embeddings are most similar to your question.
Third, those matching chunks are attached to your question and handed to the model, which writes an answer using only that context.
The result is an assistant that answers from YOUR documents instead of guessing, and it can point to the source snippets it used.`
  },
  {
    title: 'Getting started with Ollama models',
    source: 'Sample: Ollama guide',
    content: `Ollama lets you run large language models entirely on your own computer, so your documents never leave your machine.
To use a model, it must first be downloaded by running a command in your terminal, for example: ollama pull llama3.2.
Once downloaded, you can chat with it directly by typing: ollama run llama3.2.
Different models have different strengths: small models are fast and run on modest hardware, while larger models give higher quality answers but need more memory.
Every model has a context window: the amount of text it can look at at once. If you feed it more than that, it forgets the oldest part.`
  },
  {
    title: 'Angular 20 quick facts',
    source: 'Sample: Angular 20 guide',
    content: `Angular 20 focuses on simpler, faster applications.
It builds on the modern signals-based reactivity model that arrived in Angular 17, making change detection more efficient.
New Angular applications use standalone components by default, which means less boilerplate and smaller bundles.
The CLI remains the recommended way to scaffold, build and test applications, and it supports zoneless change detection for even better runtime performance.
For production, Angular includes server-side rendering and hydration out of the box.`
  }
];

// Origins we trust for state-changing requests when a browser sends an Origin
// header. A random website the user has open — or another device on the LAN —
// is rejected with 403. Same-origin fetches from the built-in UI always pass
// (their Origin is one of these, or the browser reports Sec-Fetch-Site:
// same-origin, which is also how the UI works behind a reverse proxy).
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

function isTrustedRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl, CLI, server-to-server, proxied requests
  if (LOCAL_ORIGIN_RE.test(origin)) return true;
  const extra = (process.env.RAGANYLLM_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (extra.includes('*') || extra.includes(origin.toLowerCase())) return true;
  const sfs = req.headers['sec-fetch-site'];
  if (sfs === 'same-origin' || sfs === 'none') return true;
  return false;
}

function createServer(preferredPort = 8000, host = process.env.HOST || '127.0.0.1') {
  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024, files: 10 } // 25 MB/file, 10 files max
  });
  // Knowledge packs may include embeddings (can exceed the ingest cap).
  const packUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024, files: 1 }
  });
  // Knowledge base lives in the user data dir (~/.raganyllm by default),
  // NOT process.cwd() — see lib/paths.js.
  const vectorStore = new VectorStore();
  const backupsDir = path.join(getDataDir(), 'backups');

  // ---- KB auto-backups (ROADMAP §5.6) ----
  // Snapshot before destructive ops (clear / replace import) and on demand.
  // Keeps the newest BACKUP_KEEP snapshots.
  const BACKUP_KEEP = 10;

  function ensureBackupsDir() {
    try { fs.mkdirSync(backupsDir, { recursive: true }); } catch (e) { /* ignore */ }
  }

  function makeBackup() {
    ensureBackupsDir();
    if (!fs.existsSync(vectorStore.storagePath)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(backupsDir, `raganyllm-kb-${stamp}.json`);
    try {
      fs.copyFileSync(vectorStore.storagePath, dest);
    } catch (e) {
      console.error('Backup failed:', e);
      return null;
    }
    // Prune to the newest BACKUP_KEEP snapshots.
    try {
      const files = fs.readdirSync(backupsDir)
        .filter((f) => /^raganyllm-kb-.*\.json$/.test(f))
        .map((f) => ({ f, t: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      for (const extra of files.slice(BACKUP_KEEP)) {
        fs.unlinkSync(path.join(backupsDir, extra.f));
      }
    } catch (e) { /* ignore */ }
    return dest;
  }

  function listBackups() {
    ensureBackupsDir();
    try {
      return fs.readdirSync(backupsDir)
        .filter((f) => /^raganyllm-kb-.*\.json$/.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(backupsDir, f));
          return { name: f, size: st.size, created_at: st.mtime.toISOString() };
        })
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    } catch (e) {
      return [];
    }
  }

  function restoreBackup(name) {
    // Validate strictly: only snapshot filenames we created (blocks traversal).
    if (!/^raganyllm-kb-[0-9T:-]{19}\.json$/.test(name)) return { ok: false, detail: 'Invalid backup name.' };
    const src = path.join(backupsDir, name);
    if (!fs.existsSync(src)) return { ok: false, detail: 'Backup not found.' };
    try {
      const raw = JSON.parse(fs.readFileSync(src, 'utf-8'));
      if (!raw || !Array.isArray(raw.documents) || !Array.isArray(raw.embeddings)) {
        return { ok: false, detail: 'Backup file is corrupted.' };
      }
      // Swap contents in memory and persist (VectorStore has no bulk setter, so
      // reuse the storage file + a fresh load through clear/add semantics is
      // avoided; we write directly through the same path VectorStore reads).
      fs.writeFileSync(vectorStore.storagePath, JSON.stringify(raw), 'utf-8');
      vectorStore.documents = raw.documents;
      vectorStore.embeddings = raw.embeddings;
      vectorStore._contentIndex = new Set(raw.documents.map((d) => VectorStore.contentKey(d)));
      vectorStore._keywordDirty = true;
      vectorStore._kw = null;
      return { ok: true, name, stats: vectorStore.getStats() };
    } catch (e) {
      return { ok: false, detail: `Could not restore backup: ${e.message}` };
    }
  }

  // Reject state-changing requests from untrusted web pages (cross-site CSRF).
  // CORS headers are intentionally NOT emitted: the UI is same-origin, and the
  // previous blanket Access-Control-Allow-Origin:* let any website on the
  // internet drive this local server (delete models, wipe the KB, …).
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (isTrustedRequest(req)) return next();
    return res.status(403).json({ detail: 'Request blocked: untrusted origin. This local server only accepts requests from localhost.' });
  });

  app.use(express.json({ limit: '25mb' }));
  app.use(express.static(path.join(__dirname, '../public')));

  // Helper: Get current Ollama settings
  function getOllamaSettings() {
    const config = getConfig();
    const ollamaUrl = process.env.OLLAMA_URL || config.ollama_url || 'http://localhost:11434';
    const embeddingModel = process.env.EMBEDDING_MODEL || config.embedding_model || 'nomic-embed-text';
    const modelsDir = process.env.OLLAMA_MODELS || config.ollama_models_dir || '';
    const topK = clampInt(config.top_k, 1, 20, 4);
    const threshold = clampFloat(config.similarity_threshold, 0, 0.99, 0.4);
    const searchMode = config.search_mode === 'hybrid' ? 'hybrid' : 'vector';
    return { ollamaUrl, embeddingModel, modelsDir, topK, threshold, searchMode };
  }

  // Helper: best-effort context length (tokens) of a model via `ollama show`.
  // Returns null when unknown — callers fall back to a conservative default.
  async function getModelContextLength(modelName, ollamaUrl) {
    try {
      const res = await fetch(`${ollamaUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName }),
        timeout: 4000
      });
      if (!res.ok) return null;
      const data = await res.json();
      const info = data.model_info || {};
      let best = null;
      for (const [key, val] of Object.entries(info)) {
        if (typeof val === 'number' && val >= 1024 && val <= 2000000 && /context/i.test(key)) {
          if (best === null || val > best) best = val;
        }
      }
      return best;
    } catch (e) {
      return null;
    }
  }

  // Helper: rough estimate of how well a model's context window fits the KB
  // (used by the "Create Your Own AI" flow to warn before a build).
  async function analyzeKbFit(modelName, customInstructions = '') {
    const { ollamaUrl } = getOllamaSettings();
    const docs = vectorStore.documents || [];
    let kbChars = 0;
    if (docs.length > 0) {
      kbChars = docs.reduce((sum, d) => sum + (d.content ? d.content.length : 0), 0);
    }
    const instructionChars = (typeof customInstructions === 'string' ? customInstructions : '').length || 0;
    // System prompt ≈ instructions + KB text + wrappers (~400 chars) — same
    // construction as the export route below.
    const promptChars = 400 + instructionChars + kbChars + (docs.length > 0 ? 0 : 25);
    const estTokens = Math.ceil(promptChars / 4);
    const contextTokens = await getModelContextLength(modelName, ollamaUrl);
    const usableTokens = contextTokens ? Math.max(2048, Math.floor(contextTokens * 0.9)) : null; // slight headroom for the chat turns
    let verdict = 'unknown'; // cannot measure context (e.g. Ollama unreachable)
    if (usableTokens !== null) {
      verdict = estTokens <= usableTokens ? 'fits' : 'too_large';
    }
    return {
      chunk_count: docs.length,
      kb_chars: kbChars,
      system_prompt_chars: promptChars,
      estimated_tokens: estTokens,
      model_context_tokens: contextTokens,
      usable_tokens: usableTokens,
      verdict
    };
  }

  // Helper: Get Embedding from Ollama
  async function getEmbedding(text) {
    const { ollamaUrl, embeddingModel } = getOllamaSettings();
    try {
      const res = await fetch(`${ollamaUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embeddingModel, prompt: text })
      });
      if (res.ok) {
        const data = await res.json();
        return data.embedding || [];
      }
      throw new Error(`Embedding API error: ${res.statusText}`);
    } catch (e) {
      throw new Error(`Ollama Embedding failed: ${e.message}`);
    }
  }

  // Helper: Clean HTML
  function cleanHtml(html) {
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 1. Status & Models API
  app.get('/api/models', async (req, res) => {
    try {
      const status = await checkOllamaConnection();
      const { embeddingModel, modelsDir, topK, threshold } = getOllamaSettings();
      const dbStats = vectorStore.getStats();

      return res.json({
        connected: status.connected,
        models: status.models,
        embedding_model: embeddingModel,
        ollama_models_dir: modelsDir,
        knowledge_base: dbStats,
        retrieval: { top_k: topK, similarity_threshold: threshold, search_mode: getOllamaSettings().searchMode }
      });
    } catch (e) {
      console.error('Error fetching models:', e);
      return res.json({
        connected: false,
        models: [],
        embedding_model: 'nomic-embed-text',
        ollama_models_dir: '',
        knowledge_base: vectorStore.getStats()
      });
    }
  });

  // DELETE Ollama Model API
  app.delete('/api/models/:model', async (req, res) => {
    const modelName = req.params.model;
    if (!modelName) return res.status(400).json({ detail: 'Model name is required.' });

    try {
      const { ollamaUrl } = getOllamaSettings();

      // Safety: only allow deleting models that Ollama itself reports as
      // installed (never arbitrary names forwarded from a web page).
      let tags = [];
      try {
        const tagsRes = await fetch(`${ollamaUrl}/api/tags`, { timeout: 4000 });
        if (tagsRes.ok) {
          const tagsData = await tagsRes.json();
          tags = (tagsData.models || []).map(m => m.name);
        }
      } catch (tagsErr) {
        return res.status(500).json({ detail: `Cannot verify models with Ollama (${tagsErr.message}). Delete aborted for safety.` });
      }
      if (!tags.includes(modelName)) {
        return res.status(404).json({ detail: `Model '${modelName}' is not an installed Ollama model. Delete aborted.` });
      }

      const deleteRes = await fetch(`${ollamaUrl}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName })
      });

      if (deleteRes.ok) {
        return res.json({ message: `Successfully deleted Ollama model '${modelName}'.` });
      } else {
        const errText = await deleteRes.text();
        return res.status(500).json({ detail: `Failed to delete model: ${errText}` });
      }
    } catch (e) {
      return res.status(500).json({ detail: `Error deleting model: ${e.message}` });
    }
  });

  // Config GET/POST API
  app.get('/api/config', (req, res) => {
    return res.json(getConfig());
  });

  app.post('/api/config', async (req, res) => {
    try {
      const { ollama_models_dir, ollama_url, embedding_model, top_k, similarity_threshold, search_mode } = req.body;
      const updated = saveConfig({
        ollama_models_dir: ollama_models_dir !== undefined ? String(ollama_models_dir).trim() : undefined,
        ollama_url: ollama_url !== undefined ? String(ollama_url).trim() : undefined,
        embedding_model: embedding_model !== undefined ? String(embedding_model).trim() : undefined,
        top_k: top_k !== undefined ? clampInt(top_k, 1, 20, 4) : undefined,
        similarity_threshold: similarity_threshold !== undefined ? clampFloat(similarity_threshold, 0, 0.99, 0.4) : undefined,
        search_mode: (search_mode === 'vector' || search_mode === 'hybrid') ? search_mode : undefined
      });

      const status = await checkOllamaConnection();
      return res.json({
        message: 'Configuration saved successfully.',
        config: updated,
        models: status.models,
        connected: status.connected
      });
    } catch (e) {
      return res.status(500).json({ detail: `Failed to save config: ${e.message}` });
    }
  });

  // 2. Ingest Multiple Files (.md, .txt, .pdf) WITH NDJSON STREAMING PERCENTAGE PROGRESS
  app.post('/api/ingest-files', upload.array('files'), async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    const sendProgress = (obj) => res.write(JSON.stringify(obj) + '\n');

    try {
      const files = req.files || [];
      if (files.length === 0) {
        sendProgress({ status: 'error', detail: 'No files uploaded.' });
        return res.end();
      }

      sendProgress({ status: 'progress', percent: 2, stage: 'Parsing uploaded file(s)...', totalChunks: 0, currentChunk: 0 });
      
      const fileDataList = [];
      let grandTotalChunks = 0;

      for (const file of files) {
        let textContent = '';
        const filename = file.originalname;

        if (filename.toLowerCase().endsWith('.pdf')) {
          try {
            const pdfData = await pdfParse(file.buffer);
            textContent = pdfData.text || '';
          } catch (e) {
            console.error(`Failed to parse PDF ${filename}:`, e);
            continue;
          }
        } else {
          textContent = file.buffer.toString('utf-8');
        }

        if (!textContent.trim()) continue;

        const chunks = VectorStore.chunkText(textContent);
        if (chunks.length > 0) {
          fileDataList.push({ filename, chunks });
          grandTotalChunks += chunks.length;
        }
      }

      if (grandTotalChunks === 0) {
        sendProgress({ status: 'error', detail: 'No readable text content found in uploaded files.' });
        return res.end();
      }

      sendProgress({
        status: 'progress',
        percent: 5,
        stage: `Prepared ${grandTotalChunks} total chunk(s) from ${fileDataList.length} file(s). Generating embeddings...`,
        totalChunks: grandTotalChunks,
        currentChunk: 0
      });

      let processedChunks = 0;
      let totalAddedChunks = 0;
      const fileNames = [];

      for (const item of fileDataList) {
        const chunkObjs = [];
        const chunkEmbs = [];

        for (let i = 0; i < item.chunks.length; i++) {
          const emb = await getEmbedding(item.chunks[i]);
          chunkObjs.push({
            id: v4(),
            doc_title: item.filename,
            content: item.chunks[i],
            source: `File: ${item.filename}`,
            chunk_index: i
          });
          chunkEmbs.push(emb);

          processedChunks++;
          const percent = Math.min(99, Math.round(5 + (processedChunks / grandTotalChunks) * 94));
          sendProgress({
            status: 'progress',
            percent,
            stage: `Embedding chunk ${processedChunks} of ${grandTotalChunks} (${percent}%) - ${item.filename}`,
            totalChunks: grandTotalChunks,
            currentChunk: processedChunks
          });
        }

        const { added, skipped } = vectorStore.addChunks(chunkObjs, chunkEmbs);
        totalAddedChunks += added;
        if (added > 0) fileNames.push(item.filename);
        if (skipped > 0) {
          sendProgress({ status: 'info', detail: `${item.filename}: skipped ${skipped} duplicate chunk(s) already in the knowledge base.` });
        }
      }

      sendProgress({
        status: 'complete',
        percent: 100,
        message: fileNames.length === 0
          ? `No new content added — all chunks were already in the knowledge base.`
          : `Successfully ingested ${fileNames.length} file(s) into ${totalAddedChunks} new vector chunks.`,
        files: fileNames
      });
      return res.end();

    } catch (e) {
      console.error('Ingest files error:', e);
      sendProgress({ status: 'error', detail: e.message });
      return res.end();
    }
  });

  // 3. Ingest URL WITH NDJSON STREAMING PERCENTAGE PROGRESS
  app.post('/api/ingest-url', async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    const sendProgress = (obj) => res.write(JSON.stringify(obj) + '\n');
    const { url } = req.body;

    if (!url) {
      sendProgress({ status: 'error', detail: 'URL is required.' });
      return res.end();
    }

    try {
      sendProgress({ status: 'progress', percent: 5, stage: `Fetching web page content from ${url}...`, totalChunks: 0, currentChunk: 0 });

      const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
      if (!resp.ok) {
        sendProgress({ status: 'error', detail: `HTTP ${resp.status} fetching URL` });
        return res.end();
      }

      const rawHtml = await resp.text();
      const cleanText = cleanHtml(rawHtml);
      const title = url.split('/').pop() || url;

      const chunks = VectorStore.chunkText(cleanText);
      if (chunks.length === 0) {
        sendProgress({ status: 'error', detail: 'No text content extracted from URL.' });
        return res.end();
      }

      sendProgress({
        status: 'progress',
        percent: 10,
        stage: `Extracted text & split into ${chunks.length} chunks. Generating embeddings...`,
        totalChunks: chunks.length,
        currentChunk: 0
      });

      const chunkObjs = [];
      const chunkEmbs = [];

      for (let i = 0; i < chunks.length; i++) {
        const emb = await getEmbedding(chunks[i]);
        chunkObjs.push({
          id: v4(),
          doc_title: `URL: ${title}`,
          content: chunks[i],
          source: url,
          chunk_index: i
        });
        chunkEmbs.push(emb);

        const percent = Math.min(99, Math.round(10 + ((i + 1) / chunks.length) * 89));
        sendProgress({
          status: 'progress',
          percent,
          stage: `Embedding chunk ${i + 1} of ${chunks.length} (${percent}%)`,
          totalChunks: chunks.length,
          currentChunk: i + 1
        });
      }

      const { added, skipped } = vectorStore.addChunks(chunkObjs, chunkEmbs);

      sendProgress({
        status: 'complete',
        percent: 100,
        message: added > 0
          ? `Successfully scraped & ingested URL '${url}' (${added} new vector chunk(s)).`
          : `URL '${url}' was already in the knowledge base (${skipped} duplicate chunk(s) skipped).`
      });
      return res.end();

    } catch (e) {
      sendProgress({ status: 'error', detail: `URL Ingest failed: ${e.message}` });
      return res.end();
    }
  });

  // 4. Ingest Plain Text WITH NDJSON STREAMING PERCENTAGE PROGRESS
  app.post('/api/ingest-text', async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    const sendProgress = (obj) => res.write(JSON.stringify(obj) + '\n');
    const { title, content } = req.body;

    if (!content || !content.trim()) {
      sendProgress({ status: 'error', detail: 'Content cannot be empty.' });
      return res.end();
    }

    try {
      const chunks = VectorStore.chunkText(content);
      if (chunks.length === 0) {
        sendProgress({ status: 'error', detail: 'Text is too short to chunk.' });
        return res.end();
      }

      sendProgress({
        status: 'progress',
        percent: 10,
        stage: `Split text into ${chunks.length} chunk(s). Generating embeddings...`,
        totalChunks: chunks.length,
        currentChunk: 0
      });

      const chunkObjs = [];
      const chunkEmbs = [];

      for (let i = 0; i < chunks.length; i++) {
        const emb = await getEmbedding(chunks[i]);
        chunkObjs.push({
          id: v4(),
          doc_title: title || 'Untitled Note',
          content: chunks[i],
          source: 'Manual Text Entry',
          chunk_index: i
        });
        chunkEmbs.push(emb);

        const percent = Math.min(99, Math.round(10 + ((i + 1) / chunks.length) * 89));
        sendProgress({
          status: 'progress',
          percent,
          stage: `Embedding chunk ${i + 1} of ${chunks.length} (${percent}%)`,
          totalChunks: chunks.length,
          currentChunk: i + 1
        });
      }

      const { added, skipped } = vectorStore.addChunks(chunkObjs, chunkEmbs);

      sendProgress({
        status: 'complete',
        percent: 100,
        message: added > 0
          ? `Successfully ingested '${title || 'Text'}' into ${added} new vector chunk(s).`
          : `This text is already in the knowledge base (${skipped} duplicate chunk(s) skipped).`
      });
      return res.end();

    } catch (e) {
      sendProgress({ status: 'error', detail: e.message });
      return res.end();
    }
  });

  // 5. Create Standalone Ollama Model from Knowledge Base
  // Pre-flight fit analysis for the "Create Your Own AI" wizard (ROADMAP §4).
  app.post('/api/kb/analyze-fit', async (req, res) => {
    try {
      const base_model = req.body && typeof req.body.base_model === 'string' ? req.body.base_model.trim() : '';
      const custom_instructions = req.body && typeof req.body.custom_instructions === 'string' ? req.body.custom_instructions : '';
      if (!base_model) return res.status(400).json({ detail: 'A base model is required.' });
      const fit = await analyzeKbFit(base_model, custom_instructions);
      return res.json(fit);
    } catch (e) {
      console.error('Fit analysis error:', e);
      return res.status(500).json({ detail: e.message });
    }
  });

  app.post('/api/export-ollama-model', async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    const sendProgress = (obj) => res.write(JSON.stringify(obj) + '\n');
    const { base_model, new_model_name, custom_instructions } = req.body;

    if (!base_model || !base_model.trim()) {
      sendProgress({ status: 'error', detail: 'Please select a base Ollama model from the dropdown.' });
      return res.end();
    }

    if (!new_model_name || !new_model_name.trim()) {
      sendProgress({ status: 'error', detail: 'Please enter a target model name (e.g. test-ai:new or angular29-lfm:latest).' });
      return res.end();
    }

    const instructions = (typeof custom_instructions === 'string' ? custom_instructions : '').slice(0, 4000);
    let sanitizedModelName = new_model_name.trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, '');
    if (!sanitizedModelName.includes(':')) {
      sanitizedModelName += ':latest';
    }

    try {
      sendProgress({ status: 'progress', percent: 8, stage: 'Reading your knowledge base...' });

      const docs = vectorStore.documents || [];
      if (docs.length === 0) {
        sendProgress({ status: 'error', detail: 'Your knowledge base is empty — add documents first, then create your AI model.' });
        return res.end();
      }

      let kbContentStr = '';
      if (docs.length > 0) {
        kbContentStr = docs.map((d, idx) => `--- DOCUMENT ${idx + 1}: ${d.doc_title} ---\n${d.content}`).join('\n\n');
      } else {
        kbContentStr = 'No custom documents provided.';
      }

      sendProgress({
        status: 'progress',
        percent: 18,
        stage: `Found ${vectorStore.getStats().total_documents} document(s) (${docs.length} chunk(s)) to bake in. Checking model fit...`
      });

      // Honest fit warning (never silently bake a KB too big to be remembered).
      const fit = await analyzeKbFit(base_model.trim(), instructions);
      if (fit.verdict === 'too_large') {
        sendProgress({
          status: 'warning',
          detail: `⚠️ Your knowledge base (≈${fit.estimated_tokens} tokens) is larger than what '${base_model.trim()}' can remember in one go (≈${fit.usable_tokens} tokens). The model will only retain part of it. For best results use a model with a larger context window or trim your knowledge base first.`
        });
      }

      sendProgress({ status: 'progress', percent: 28, stage: 'Constructing the AI system prompt...' });

      const systemPrompt = `${instructions || 'You are a specialized expert AI assistant.'}\n\nVERIFIED EMBEDDED KNOWLEDGE BASE:\n${kbContentStr}\n\nINSTRUCTIONS:\nUse the above context and your knowledge base to answer user questions accurately.`;

      const { ollamaUrl } = getOllamaSettings();

      sendProgress({ status: 'progress', percent: 40, stage: `Building your AI model '${sanitizedModelName}' from '${base_model.trim()}'...` });

      const ollamaRes = await fetch(`${ollamaUrl}/api/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: sanitizedModelName,
          from: base_model.trim(),
          system: systemPrompt,
          stream: true
        })
      });

      if (!ollamaRes.ok) {
        const errText = await ollamaRes.text();
        sendProgress({ status: 'error', detail: `Ollama API error: ${errText}` });
        return res.end();
      }

      let progressStep = 45;

      ollamaRes.body.on('data', (chunk) => {
        const text = chunk.toString('utf-8');
        const lines = text.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.status) {
              progressStep = Math.min(98, progressStep + 9);
              sendProgress({
                status: 'progress',
                percent: progressStep,
                stage: `Ollama Build: ${data.status}`
              });
            } else if (data.error) {
              sendProgress({ status: 'error', detail: `Ollama build error: ${data.error}` });
            }
          } catch (err) {
            // ignore JSON parse chunk error
          }
        }
      });

      ollamaRes.body.on('end', () => {
        sendProgress({
          status: 'complete',
          percent: 100,
          message: `✔ Your AI model '${sanitizedModelName}' is ready! Built from '${base_model.trim()}' with ${vectorStore.getStats().total_documents} document(s) (${docs.length} chunk(s)) baked in. Run it in your terminal with: ollama run ${sanitizedModelName}`,
          model: sanitizedModelName
        });
        res.end();
      });

      ollamaRes.body.on('error', (err) => {
        sendProgress({ status: 'error', detail: err.message });
        res.end();
      });

    } catch (e) {
      console.error('Export model error:', e);
      sendProgress({ status: 'error', detail: e.message });
      return res.end();
    }
  });

  // 6. Clear KB (with auto-backup of the previous state)
  app.post('/api/clear-kb', (req, res) => {
    const backup = vectorStore.documents.length > 0 ? makeBackup() : null;
    vectorStore.clear();
    return res.json({
      message: 'Knowledge Base cleared successfully.',
      backup: backup ? path.basename(backup) : null
    });
  });

  // 6a. KB backup endpoints (ROADMAP §5.6)
  app.post('/api/kb/backup', (req, res) => {
    if (vectorStore.documents.length === 0) {
      return res.status(400).json({ detail: 'Nothing to back up — the knowledge base is empty.' });
    }
    const dest = makeBackup();
    if (!dest) return res.status(500).json({ detail: 'Backup failed — could not write to the backups folder.' });
    return res.json({ message: 'Backup created.', backup: path.basename(dest) });
  });

  app.get('/api/kb/backups', (req, res) => {
    return res.json({ backups: listBackups() });
  });

  app.post('/api/kb/restore', (req, res) => {
    const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ detail: 'A backup name is required.' });
    const result = restoreBackup(name);
    if (!result.ok) return res.status(400).json({ detail: result.detail });
    return res.json({ message: `Restored knowledge base from '${name}'.`, knowledge_base: result.stats });
  });

  // 7. Export Knowledge Base as a portable .raganyllm pack (cross-device transfer)
  // Pack format v1: single JSON file { format: 'raganyllm-pack', version: 1, ... }.
  // By default embeddings are embedded so imports are instant and offline; pass
  // ?embeddings=0 for a compact text-only pack that re-learns on import.
  function exportPackHandler(req, res) {
    try {
      const docs = vectorStore.documents || [];
      if (docs.length === 0) {
        return res.status(400).json({ detail: 'Your knowledge base is empty — add documents first, then export.' });
      }
      const includeEmbeddings = !(req.query.embeddings === '0' || req.query.embeddings === 'false' || req.body?.embeddings === false);
      const password = (req.method === 'POST' && typeof req.body?.password === 'string' && req.body.password)
        ? req.body.password
        : (req.method === 'GET' ? (typeof req.query.password === 'string' ? req.query.password : '') : '');
      const pack = {
        format: 'raganyllm-pack',
        version: 1,
        kind: 'knowledge',
        created_at: new Date().toISOString(),
        stats: vectorStore.getStats(),
        settings: { embedding_model: getOllamaSettings().embeddingModel },
        knowledge: {
          chunks: docs.map(d => ({
            id: typeof d.id === 'string' && d.id ? d.id : v4(),
            doc_title: d.doc_title || 'Untitled',
            content: d.content || '',
            source: d.source || '',
            chunk_index: Number.isInteger(d.chunk_index) ? d.chunk_index : 0
          })),
          embeddings: includeEmbeddings ? (vectorStore.embeddings || []) : undefined
        }
      };
      const body = password ? encryptPackJson(pack, password) : JSON.stringify(pack);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="raganyllm-kb-${new Date().toISOString().slice(0, 10)}.raganyllm"`);
      return res.send(body);
    } catch (e) {
      console.error('Export KB error:', e);
      return res.status(500).json({ detail: `Export failed: ${e.message}` });
    }
  }

  app.get('/api/kb/export', exportPackHandler);
  app.post('/api/kb/export', exportPackHandler);

  // 8. Import a .raganyllm knowledge pack (merge or replace), NDJSON progress.
  app.post('/api/kb/import', packUpload.single('pack'), async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    const sendProgress = (obj) => res.write(JSON.stringify(obj) + '\n');

    try {
      if (!req.file) {
        sendProgress({ status: 'error', detail: 'No .raganyllm pack file was uploaded.' });
        return res.end();
      }

      sendProgress({ status: 'progress', percent: 5, stage: 'Reading knowledge pack...', totalChunks: 0, currentChunk: 0 });

      let pack;
      try {
        pack = JSON.parse(req.file.buffer.toString('utf-8'));
      } catch (e) {
        sendProgress({ status: 'error', detail: 'This file is not a valid .raganyllm knowledge pack (could not be read as JSON).' });
        return res.end();
      }

      // Password-protected pack? Decrypt before validating the inner format.
      if (pack && pack.format === 'raganyllm-pack-enc') {
        const password = (typeof req.body.password === 'string' && req.body.password) ? req.body.password : '';
        if (!password) {
          sendProgress({ status: 'error', detail: 'This knowledge pack is password-protected. Enter its password and try importing again.' });
          return res.end();
        }
        try {
          pack = decryptPackJson(pack, password);
        } catch (e) {
          sendProgress({ status: 'error', detail: 'Could not open this pack — the password is incorrect or the file was modified. Please try again.' });
          return res.end();
        }
      }

      if (!pack || pack.format !== 'raganyllm-pack' || !pack.knowledge || !Array.isArray(pack.knowledge.chunks)) {
        sendProgress({ status: 'error', detail: 'This file is not a valid .raganyllm knowledge pack (wrong format).' });
        return res.end();
      }
      if (pack.version !== 1) {
        sendProgress({ status: 'error', detail: `Unsupported knowledge pack version (${pack.version}). Please update raganyllm and try again.` });
        return res.end();
      }

      const mode = req.body.mode === 'replace' ? 'replace' : 'merge';
      const rawChunks = pack.knowledge.chunks;
      if (rawChunks.length === 0) {
        sendProgress({ status: 'error', detail: 'This pack contains no knowledge chunks.' });
        return res.end();
      }

      // Validate & normalize every chunk before touching the KB (all-or-nothing).
      const docs = [];
      for (let i = 0; i < rawChunks.length; i++) {
        const c = rawChunks[i];
        if (!c || typeof c.content !== 'string' || !c.content.trim() || c.content.length > 1000000) {
          sendProgress({ status: 'error', detail: `Pack chunk #${i + 1} is invalid (missing or oversized content). Import aborted — nothing was changed.` });
          return res.end();
        }
        docs.push({
          id: typeof c.id === 'string' && c.id ? c.id : v4(),
          doc_title: typeof c.doc_title === 'string' && c.doc_title ? c.doc_title : 'Imported Document',
          content: c.content,
          source: typeof c.source === 'string' && c.source ? c.source : 'Knowledge Pack Import',
          chunk_index: Number.isInteger(c.chunk_index) ? c.chunk_index : i
        });
      }

      // Embeddings may travel with the pack (fast, offline import). If absent,
      // re-learn them through Ollama so imports work from compact exports too.
      const embArr = pack.knowledge.embeddings;
      let embeddings;
      if (Array.isArray(embArr) && embArr.length === docs.length && embArr.every(e => Array.isArray(e) && e.length > 0)) {
        embeddings = embArr;
      } else {
        embeddings = [];
        const { embeddingModel } = getOllamaSettings();
        for (let i = 0; i < docs.length; i++) {
          let emb;
          try {
            emb = await getEmbedding(docs[i].content);
          } catch (e) {
            sendProgress({
              status: 'error',
              detail: `This pack was exported without embeddings and they could not be generated (embedding model '${embeddingModel}' unreachable: ${e.message}). Start Ollama and try again, or re-export the pack with embeddings included.`
            });
            return res.end();
          }
          embeddings.push(emb);
          sendProgress({
            status: 'progress',
            percent: Math.min(90, Math.round(10 + ((i + 1) / docs.length) * 80)),
            stage: `Teaching the AI this pack — chunk ${i + 1} of ${docs.length}...`,
            totalChunks: docs.length,
            currentChunk: i + 1
          });
        }
      }

      if (mode === 'replace') {
        if (vectorStore.documents.length > 0) makeBackup(); // rollback point (ROADMAP §5.6)
        vectorStore.clear();
        sendProgress({ status: 'progress', percent: 92, stage: 'Replacing current knowledge base...', totalChunks: docs.length, currentChunk: docs.length });
      }

      const { added, skipped } = vectorStore.addChunks(docs, embeddings);
      const stats = vectorStore.getStats();
      const modeNote = mode === 'replace' ? 'Replaced knowledge base' : 'Merged into knowledge base';
      sendProgress({
        status: 'complete',
        percent: 100,
        message: `✔ ${modeNote}: ${added} new chunk(s) imported` + (skipped > 0 ? ` (${skipped} duplicate(s) skipped)` : '') + `. Now ${stats.total_documents} document(s) / ${stats.total_chunks} chunk(s).`
      });
      return res.end();
    } catch (e) {
      console.error('Import KB error:', e);
      sendProgress({ status: 'error', detail: `Import failed: ${e.message}` });
      return res.end();
    }
  });

  // 8b. One-click sample documents (a noob-friendly way to try RAG immediately).
  // POST /api/kb/samples  -> loads samples (NDJSON progress; safe to re-run —
  // duplicates are skipped). GET /api/kb/samples lists them.
  app.get('/api/kb/samples', (req, res) => {
    return res.json({ samples: SAMPLE_DOCS.map(d => ({ title: d.title, source: d.source })) });
  });

  app.post('/api/kb/samples', async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    const sendProgress = (obj) => res.write(JSON.stringify(obj) + '\n');

    try {
      let totalChunks = 0;
      for (const sample of SAMPLE_DOCS) {
        totalChunks += VectorStore.chunkText(sample.content).length;
      }
      sendProgress({
        status: 'progress', percent: 5,
        stage: `Adding ${SAMPLE_DOCS.length} sample document(s) (~${totalChunks} chunks)...`,
        totalChunks, currentChunk: 0
      });

      let done = 0;
      let totalAdded = 0;
      let totalSkipped = 0;
      for (const sample of SAMPLE_DOCS) {
        const chunks = VectorStore.chunkText(sample.content);
        const chunkObjs = [];
        const chunkEmbs = [];
        for (let i = 0; i < chunks.length; i++) {
          const emb = await getEmbedding(chunks[i]);
          chunkObjs.push({
            id: v4(),
            doc_title: sample.title,
            content: chunks[i],
            source: sample.source,
            chunk_index: i
          });
          chunkEmbs.push(emb);
          done++;
          sendProgress({
            status: 'progress',
            percent: Math.min(94, Math.round(5 + (done / totalChunks) * 89)),
            stage: `Teaching the AI about '${sample.title}' — chunk ${done} of ${totalChunks}...`,
            totalChunks, currentChunk: done
          });
        }
        const { added, skipped } = vectorStore.addChunks(chunkObjs, chunkEmbs);
        totalAdded += added;
        totalSkipped += skipped;
      }
      sendProgress({
        status: 'complete', percent: 100,
        message: totalAdded > 0
          ? `✔ Loaded ${totalAdded} sample chunk(s). Try asking something like 'What is Retrieval Augmented Generation?'`
          : `Sample documents are already in your knowledge base (${totalSkipped} duplicate chunk(s) skipped).`
      });
      return res.end();
    } catch (e) {
      sendProgress({ status: 'error', detail: `Could not load samples: ${e.message}` });
      return res.end();
    }
  });

  // 8b. Delete one document (and all its chunks) from the knowledge base.
  app.post('/api/kb/delete-doc', (req, res) => {
    try {
      const doc_title = req.body && typeof req.body.doc_title === 'string' ? req.body.doc_title.trim() : '';
      if (!doc_title) return res.status(400).json({ detail: 'Document title is required.' });
      const removed = vectorStore.removeByDocTitle(doc_title);
      if (removed === 0) return res.status(404).json({ detail: `No document titled '${doc_title}' found in the knowledge base.` });
      return res.json({ message: `Deleted '${doc_title}' (${removed} chunk(s) removed).`, removed, knowledge_base: vectorStore.getStats() });
    } catch (e) {
      console.error('Delete doc error:', e);
      return res.status(500).json({ detail: `Delete failed: ${e.message}` });
    }
  });

  // 8c. Human-readable plain-text exports of the knowledge base.
  app.get('/api/kb/export/markdown', (req, res) => {
    try {
      const docs = vectorStore.documents || [];
      if (docs.length === 0) return res.status(400).json({ detail: 'Your knowledge base is empty — add documents first, then export.' });
      const lines = ['# raganyllm Knowledge Base Export', '', `_Exported ${new Date().toISOString()}_`, ''];
      let lastTitle = null;
      for (const d of docs) {
        const t = d.doc_title || 'Untitled';
        const src = d.source || '';
        if (t !== lastTitle) {
          lines.push(`## ${t}${src ? ` — ${src}` : ''}`, '');
          lastTitle = t;
        }
        lines.push(d.content || '', '');
      }
      const body = lines.join('\n');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="raganyllm-kb-${new Date().toISOString().slice(0, 10)}.md"`);
      return res.send(body);
    } catch (e) {
      console.error('Markdown export error:', e);
      return res.status(500).json({ detail: `Export failed: ${e.message}` });
    }
  });

  app.get('/api/kb/export/jsonl', (req, res) => {
    try {
      const docs = vectorStore.documents || [];
      if (docs.length === 0) return res.status(400).json({ detail: 'Your knowledge base is empty — add documents first, then export.' });
      const lines = docs.map(d => JSON.stringify({
        doc_title: d.doc_title || 'Untitled',
        source: d.source || '',
        chunk_index: Number.isInteger(d.chunk_index) ? d.chunk_index : 0,
        content: d.content || ''
      }));
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="raganyllm-kb-${new Date().toISOString().slice(0, 10)}.jsonl"`);
      return res.send(lines.join('\n'));
    } catch (e) {
      console.error('JSONL export error:', e);
      return res.status(500).json({ detail: `Export failed: ${e.message}` });
    }
  });

  // 9. RAG Query API (DO NOT override default Modelfile system prompt when use_rag is false)
  // Supports both JSON (stream: false/omitted) and SSE token streaming (stream: true).
  // Optional `history`: [{role:'user'|'assistant', content}] — previous turns of a
  // conversation, appended after any RAG system prompt so follow-up questions like
  // "and what about price?" stay in context (see ROADMAP §2.4).
  app.post('/api/query', async (req, res) => {
    const { query, model, use_rag = true, stream = false } = req.body;
    if (!query || !query.trim()) return res.status(400).json({ detail: 'Query is required.' });

    const selectedModel = model || 'llama3:latest';

    // ---- Conversation memory: validate & clamp client-sent history ----
    const HISTORY_LIMIT = 12; // messages kept (user+assistant), oldest dropped
    const HISTORY_MSG_CAP = 4000; // chars per history message
    const rawHistory = Array.isArray(req.body.history) ? req.body.history : [];
    const history = [];
    // Walk from the most recent message backwards so we keep the LAST
    // HISTORY_LIMIT valid messages (the newest turns).
    for (let i = rawHistory.length - 1; i >= 0 && history.length < HISTORY_LIMIT; i--) {
      const h = rawHistory[i] || {};
      const role = h.role === 'assistant' ? 'assistant' : (h.role === 'user' ? 'user' : null);
      if (!role) continue; // never let a client inject system/system-prompt content via history
      const content = typeof h.content === 'string' ? h.content.trim().slice(0, HISTORY_MSG_CAP) : '';
      if (!content) continue;
      history.unshift({ role, content });
    }

    try {
      const { ollamaUrl, topK, threshold, searchMode: savedSearchMode } = getOllamaSettings();
      // Per-request overrides, defaulting to the saved config values.
      const top_k = clampInt(req.body.top_k, 1, 20, topK);
      const simThreshold = clampFloat(req.body.similarity_threshold, 0, 0.99, threshold);
      const searchMode = req.body.search_mode === 'hybrid' ? 'hybrid' : (req.body.search_mode === 'vector' ? 'vector' : savedSearchMode);

      let retrievedChunks = [];
      let ragStatus = 'disabled';
      let budgetDropped = 0; // sources dropped because of the model context window
      let detectedCtx = null; // tokens reported by `ollama show` for the model
      const messages = [];

      if (use_rag) {
        // Perform RAG Vector Search & Inject System Prompt
        try {
          const queryEmb = await getEmbedding(query);
          if (searchMode === 'hybrid') {
            retrievedChunks = vectorStore.hybridSearch(query, queryEmb, top_k, simThreshold);
          } else {
            retrievedChunks = vectorStore.search(queryEmb, top_k, simThreshold);
          }

          if (retrievedChunks.length > 0) {
            ragStatus = 'context_found';

            // ---- Context-window budget (ROADMAP §2.3) ----
            // Keep the full request (retrieved context + conversation history +
            // query + prompt overhead) inside the model's context window:
            // estimate tokens from `ollama show`, reserve ~70%, subtract
            // history/query overhead, then include top matches greedily
            // (they arrive sorted by similarity). Truncate the top match only
            // if even it cannot fit.
            detectedCtx = await getModelContextLength(selectedModel, ollamaUrl);
            const ctxTokens = detectedCtx ? Math.max(2048, Math.floor(detectedCtx * 0.7)) : 4096;
            const overheadChars = 1200 + query.length +
              history.reduce((sum, h) => sum + h.content.length + 60, 0);
            const availableChars = Math.max(600, ctxTokens * 4 - overheadChars);
            if (retrievedChunks.length > 0) {
              const included = [];
              let usedChars = 0;
              for (const c of retrievedChunks) {
                const need = c.content.length + 200; // source header + spacing
                if (usedChars + need <= availableChars) {
                  included.push(c);
                  usedChars += need;
                } else {
                  break;
                }
              }
              if (included.length === 0) {
                const room = Math.max(200, availableChars - 200);
                included.push({ ...retrievedChunks[0], content: retrievedChunks[0].content.slice(0, room) + '\n[…truncated to fit the model context window…]' });
              }
              budgetDropped = retrievedChunks.length - included.length;
              retrievedChunks = included;
            }

            const contextStr = retrievedChunks
              .map((c, idx) => `--- [SOURCE ${idx + 1}: ${c.doc_title}] (Similarity Match: ${c.similarity_score}) ---\n${c.content}`)
              .join('\n\n');

            const systemPrompt = `You are an expert AI assistant. Below is verified documentation retrieved from the user's Knowledge Base:\n\n${contextStr}\n\nINSTRUCTIONS:\n1. Answer the user's question directly using the provided context snippets.\n2. Include code examples where appropriate.\n3. Be concise, accurate, and structured.`;

            messages.push({ role: 'system', content: systemPrompt });
          } else {
            ragStatus = 'no_context';
            // Honest fallback: no relevant context above threshold — the model
            // must say so instead of quietly answering without knowledge.
            messages.push({
              role: 'system',
              content: 'You are an expert AI assistant. You searched the user\'s knowledge base but found NO relevant context (best similarity was below the configured threshold). Reply honestly: tell the user you could not find this in their knowledge base, and invite them to add the information. Do NOT invent facts, URLs, code, or documentation details.'
            });
          }
        } catch (embErr) {
          console.warn('Embedding warning:', embErr.message);
          ragStatus = 'embedding_error';
          messages.push({
            role: 'system',
            content: 'You are an expert AI assistant. The knowledge base search failed due to an error. Reply honestly: tell the user their knowledge base could not be searched right now, and answer only if you are confident from general knowledge.'
          });
        }
      }

      // DO NOT push system message when use_rag is false!
      // This allows the model's internal Modelfile system prompt (e.g. in angular20-lfm:latest) to be used!

      // Conversation memory (validated above): previous turns go after any RAG
      // system prompt and before the current question.
      for (const h of history) {
        messages.push({ role: h.role, content: h.content });
      }

      messages.push({ role: 'user', content: query });

      // Call Ollama Chat API
      const ollamaResp = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: messages,
          stream: !!stream
        })
      });

      const metaPayload = {
        type: 'meta',
        query,
        model_used: selectedModel,
        rag_enabled: use_rag,
        rag_status: ragStatus,
        retrieval_settings: { top_k, similarity_threshold: simThreshold, search_mode: searchMode },
        context_budget: { model_context_tokens: detectedCtx, dropped_sources: budgetDropped },
        retrieved_sources: retrievedChunks
      };

      if (!ollamaResp.ok) {
        const errText = await ollamaResp.text();
        const detail = `Ollama error: ${errText}`;
        if (stream) {
          // Client already committed to an SSE stream — send the error in-band.
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.write(`data: ${JSON.stringify({ type: 'error', detail })}\n\n`);
          return res.end();
        }
        return res.status(500).json({ detail });
      }

      if (stream) {
        // ---- SSE token streaming ----
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // Emit retrieval/meta first so the UI can show sources + status immediately.
        res.write(`data: ${JSON.stringify(metaPayload)}\n\n`);

        let buffer = '';
        let aborted = false;
        try {
          for await (const chunk of ollamaResp.body) {
            if (res.writableEnded) { aborted = true; break; }
            buffer += chunk.toString('utf-8');
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              if (!line.trim()) continue;
              let data;
              try {
                data = JSON.parse(line);
              } catch (e) {
                continue; // partial JSON line — wait for more
              }
              if (data.error) {
                res.write(`data: ${JSON.stringify({ type: 'error', detail: `Ollama error: ${data.error}` })}\n\n`);
                aborted = true;
                break;
              }
              if (data.message && typeof data.message.content === 'string' && data.message.content) {
                res.write(`data: ${JSON.stringify({ type: 'token', content: data.message.content })}\n\n`);
              }
              if (data.done) {
                break;
              }
            }
            if (aborted) break;
          }
        } catch (e) {
          // Client disconnected mid-stream (e.g. user pressed Stop) — that is OK.
          console.warn('Stream aborted (client disconnect or upstream error):', e.message);
        }
        // Guard against writing to an already-closed/destroyed socket.
        if (!res.writableEnded && !res.destroyed) {
          try {
            res.write(`data: ${JSON.stringify({ type: 'end', reason: aborted ? 'error' : 'done' })}\n\n`);
            res.end();
          } catch (writeErr) {
            console.warn('Could not finalize stream response:', writeErr.message);
          }
        }
        return;
      }

      const resData = await ollamaResp.json();
      const answer = resData.message ? resData.message.content : 'No answer generated.';

      return res.json({
        query,
        answer,
        model_used: selectedModel,
        rag_enabled: use_rag,
        rag_status: ragStatus,
        retrieval_settings: { top_k, similarity_threshold: simThreshold, search_mode: searchMode },
        context_budget: { model_context_tokens: detectedCtx, dropped_sources: budgetDropped },
        retrieved_sources: retrievedChunks
      });
    } catch (e) {
      console.error('RAG Query Error:', e);
      return res.status(500).json({ detail: e.message });
    }
  });

  // Return Promise with automatic EADDRINUSE port fallback.
  // preferredPort === 0 requests an OS-assigned ephemeral port (tests/embedding).
  return new Promise((resolve, reject) => {
    const ephemeral = preferredPort === 0;
    let port = ephemeral ? 0 : (parseInt(preferredPort, 10) || 8000);

    function tryListen() {
      const server = app.listen(port, host, () => {
        const actual = (server.address() && server.address().port) || port;
        if (!process.env.RAGANYLLM_QUIET) {
          console.log(`🚀 raganyllm server running on http://${host}:${actual}`);
          console.log('🔒 Bound to localhost only. Set HOST=0.0.0.0 to allow LAN access (unauthenticated — do not expose publicly).');
        }
        resolve({ app, server, port: actual });
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && !ephemeral) {
          console.log(`⚠️ Port ${port} is currently in use. Automatically trying port ${port + 1}...`);
          port++;
          tryListen();
        } else {
          reject(err);
        }
      });
    }

    tryListen();
  });
}

module.exports = { createServer };
