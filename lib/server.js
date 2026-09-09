const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const v4 = crypto.randomUUID || (() => Math.random().toString(36).substr(2, 9));



const VectorStore = require('./vector-store');
const { checkOllamaConnection } = require('./checker');
const { getDataDir } = require('./paths');
const packLib = require('./pack');
const aiRegistry = require('./ai-registry');
const ragAdv = require('./retrieval');
const promptLib = require('./prompts');
const log = require('./log');
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


  // ---- §2.2 Advanced retrieval (filters, query expansion, rerank, HyDE) ----
  // One-shot model text reply (non-stream) used by the optional retrieval
  // enhancements. Errors degrade silently: an unavailable model turns each
  // enhancement off for that request instead of failing the query.
  async function ollamaChatOnce(model, messages) {
    const { ollamaUrl } = getOllamaSettings();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const res = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false }),
        signal: ctl.signal
      });
      if (!res.ok) return '';
      const data = await res.json();
      return (data && data.message && typeof data.message.content === 'string') ? data.message.content : '';
    } catch (e) {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  const HYDE_SYSTEM = 'You are helping search a local knowledge base. HYPOTHETICAL_DOCUMENT TASK: write one short hypothetical passage (2-4 sentences, encyclopedia style) that would contain the answer to the user\'s question. Reply with the passage only, no preamble.';
  const EXPAND_SYSTEM = 'You are a search-query expander for a local knowledge base. EXPAND_SEARCH_QUERIES TASK: given the user question, produce up to 2 short alternative search queries capturing other phrasings or key identifiers. Reply ONLY with a JSON array of strings.';
  const RERANK_SYSTEM = 'You are a search-relevance reranker. RERANK_CANDIDATES TASK: given the question and numbered candidate snippets from a knowledge base, reply ONLY with a JSON array of 0-based indices ordered from most to least relevant.';

  // Run the full optional pipeline: filters -> (HyDE) -> expansion runs ->
  // merge -> LLM rerank. Returns { chunks, info }; never throws.
  async function runRetrievalPipeline(opts) {
    const { query, topK, simThreshold, searchMode, filter, rerank, expand, hyde } = opts;
    const model = opts.model;
    const info = {
      filter: (filter && (filter.docTitles.length > 0 || filter.sourceText)) ? filter : null,
      rerank: !!rerank,
      query_expansion: false,
      hyde: false,
      hyde_passage: null
    };
    const candidateK = rerank ? ragAdv.rerankPoolSize(topK) : topK;
    const embed = (text) => getEmbedding(text);

    // HyDE: retrieve with an embedding of a model-written hypothetical answer.
    let hydeEmb = null;
    if (hyde && vectorStore.documents.length > 0) {
      const passage = await ollamaChatOnce(model, [
        { role: 'system', content: HYDE_SYSTEM },
        { role: 'user', content: query }
      ]);
      if (passage && passage.trim()) {
        info.hyde = true;
        info.hyde_passage = passage.trim().slice(0, 400);
        try {
          hydeEmb = await embed(passage);
        } catch (e) { /* fall back to the real query embedding */ }
      }
    }

    // Query expansion: ask the model for paraphrases, cap + dedupe.
    let extra = [];
    if (expand && vectorStore.documents.length > 0) {
      const raw = await ollamaChatOnce(model, [
        { role: 'system', content: EXPAND_SYSTEM },
        { role: 'user', content: query }
      ]);
      const parsed = ragAdv.extractJson(raw);
      if (Array.isArray(parsed)) extra = parsed.filter((s) => typeof s === 'string');
    }
    const queries = ragAdv.selectQueries(query, extra);
    if (queries.length > 1) info.query_expansion = true;

    const pools = [];
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      let embVec = null;
      try {
        embVec = (i === 0 && hydeEmb) ? hydeEmb : await embed(q);
      } catch (e) {
        if (i === 0) throw e; // primary embedding failure -> outer embedding_error
        continue; // an extra paraphrase failed to embed; skip it
      }
      const pool = searchMode === 'hybrid'
        ? vectorStore.hybridSearch(q, embVec, candidateK, simThreshold, filter)
        : vectorStore.search(embVec, candidateK, simThreshold, filter);
      if (pool.length > 0) pools.push(pool);
    }
    if (pools.length === 0) return { chunks: [], info };

    let chunks = pools.length === 1 ? pools[0] : ragAdv.mergePools(pools, candidateK);

    // LLM rerank over the (possibly widened) candidate pool.
    if (rerank && chunks.length > 1 && vectorStore.documents.length > 0) {
      const numbered = chunks
        .map((c, i) => `[${i}] ${c.doc_title || 'Untitled'}: ${String(c.content || '').slice(0, 240)}`)
        .join('\n');
      const raw = await ollamaChatOnce(model, [
        { role: 'system', content: RERANK_SYSTEM },
        { role: 'user', content: `QUESTION: ${query}\n\nCANDIDATES:\n${numbered}` }
      ]);
      const parsed = ragAdv.extractJson(raw);
      // Accept either a bare JSON array or an { indices: [...] } object.
      const indexList = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.indices) ? parsed.indices : null);
      if (indexList) chunks = ragAdv.reorderByIndices(chunks, indexList);
    }

    return { chunks: chunks.slice(0, topK), info };
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
        retrieval: (() => {
          const g = getOllamaSettings();
          const c = getConfig();
          return {
            top_k: g.topK, similarity_threshold: g.threshold, search_mode: g.searchMode,
            rerank_enabled: !!c.rerank_enabled,
            query_expansion_enabled: !!c.query_expansion_enabled,
            hyde_enabled: !!c.hyde_enabled
          };
        })()
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

  // 1b. First-Run Wizard endpoints (ROADMAP §1.1). The wizard is a guided,
  // re-runnable setup (Settings → "Setup Assistant"): check Ollama, pick a
  // persona (which pre-configures sensible retrieval defaults), add content,
  // then try the assistant. Persona + completion state live in the config's
  // `setup` object; the health data is derived live from Ollama.
  const PERSONA_PRESETS = {
    qa: { label: 'Document Q&A', description: 'Chat with your PDFs, notes & manuals.', search_mode: 'hybrid', top_k: 6, similarity_threshold: 0.45, recommended_chat: 'llama3.2:3b' },
    website: { label: 'Website docs assistant', description: 'Answers from documentation pages & web content you save.', search_mode: 'hybrid', top_k: 5, similarity_threshold: 0.4, recommended_chat: 'llama3.2:3b' },
    notes: { label: 'My knowledge notes', description: 'A personal assistant over your own notes and memos.', search_mode: 'vector', top_k: 5, similarity_threshold: 0.4, recommended_chat: 'qwen2.5:3b' },
    custom: { label: 'Custom / just exploring', description: 'No pre-configured defaults — keep everything manual.', recommended_chat: 'llama3.2:3b' }
  };
  const PERSONA_IDS = Object.keys(PERSONA_PRESETS);

  async function setupStatusData() {
    const cfg = getConfig();
    const status = await checkOllamaConnection();
    const models = (status && status.models) || [];
    const embName = cfg.embedding_model || 'nomic-embed-text';
    const embBase = String(embName).split(':')[0];
    const embInstalled = models.some((m) => String(m).split(':')[0] === embBase);
    const persona = (cfg.setup && cfg.setup.persona && PERSONA_PRESETS[cfg.setup.persona]) ? cfg.setup.persona : null;
    const preset = persona ? PERSONA_PRESETS[persona] : null;
    const kb = vectorStore.getStats();
    return {
      first_run: !(cfg.setup && cfg.setup.completed === true),
      persona,
      persona_label: preset ? preset.label : null,
      recommended_chat: (preset && preset.recommended_chat) || 'llama3.2:3b',
      presets: PERSONA_PRESETS,
      ollama: { connected: !!(status && status.connected), models },
      embedding: { name: embName, installed: !!status && status.connected && embInstalled },
      kb: { documents: kb.total_documents || 0, chunks: kb.total_chunks || 0 }
    };
  }

  app.get('/api/setup/status', async (req, res) => {
    try {
      return res.json(await setupStatusData());
    } catch (e) {
      console.error('Setup status error:', e);
      return res.status(500).json({ detail: `Could not read setup status: ${e.message}` });
    }
  });

  app.post('/api/setup/persona', async (req, res) => {
    try {
      const persona = typeof req.body === 'object' && req.body && typeof req.body.persona === 'string' ? req.body.persona : '';
      const preset = PERSONA_PRESETS[persona];
      if (!preset) {
        return res.status(400).json({ detail: `Unknown persona '${persona}'. Choose one of: ${PERSONA_IDS.join(', ')}.` });
      }
      const cfg = getConfig();
      const patch = {
        setup: { ...(cfg.setup || {}), persona }
      };
      if (preset.search_mode) patch.search_mode = preset.search_mode;
      if (preset.top_k) patch.top_k = preset.top_k;
      if (preset.similarity_threshold) patch.similarity_threshold = preset.similarity_threshold;
      saveConfig(patch);
      log.info('setup-persona', 'wizard persona applied', { persona, top_k: preset.top_k, search_mode: preset.search_mode || 'unchanged' });
      return res.json({ ok: true, recommended_chat: preset.recommended_chat, status: await setupStatusData() });
    } catch (e) {
      return res.status(500).json({ detail: `Could not apply persona: ${e.message}` });
    }
  });

  app.post('/api/setup/complete', async (req, res) => {
    try {
      const cfg = getConfig();
      const bodyPersona = req.body && typeof req.body.persona === 'string' ? req.body.persona : '';
      const persona = PERSONA_PRESETS[bodyPersona] ? bodyPersona : ((cfg.setup && cfg.setup.persona) || null);
      saveConfig({ setup: { ...(cfg.setup || {}), persona, completed: true } });
      log.info('setup-complete', 'first-run wizard finished', { persona });
      return res.json({ ok: true, status: await setupStatusData() });
    } catch (e) {
      return res.status(500).json({ detail: `Could not complete setup: ${e.message}` });
    }
  });

  // Suggestion questions for the wizard "Try it!" step and the empty chat
  // state (ROADMAP §1.5): derived from the current KB's document titles, so
  // they always ask about *this* user's content. No model call needed.
  app.get('/api/setup/questions', (req, res) => {
    const titles = Array.from(new Set((vectorStore.documents || []).map((d) => d.doc_title || 'Untitled').filter(Boolean)));
    const pick = titles.slice(0, 3);
    const questions = pick.map((t) => `What is "${t}" about?`);
    while (questions.length < 3) {
      const n = questions.length + 1;
      if (pick.length === 0) {
        questions.push(['What is retrieval-augmented generation?', 'How do I add my own documents?', 'Which model should I pick?'][n - 1]);
      } else {
        const t = pick[n % pick.length];
        questions.push(`Summarise the key points in "${t}".`);
      }
    }
    return res.json({ questions: questions.slice(0, 3), has_kb: pick.length > 0 });
  });

  app.get('/api/config', (req, res) => {
    return res.json(getConfig());
  });

  app.post('/api/config', async (req, res) => {
    try {
      const {
        ollama_models_dir, ollama_url, embedding_model, top_k, similarity_threshold, search_mode,
        rerank_enabled, query_expansion_enabled, hyde_enabled
      } = req.body;
      const updated = saveConfig({
        ollama_models_dir: ollama_models_dir !== undefined ? String(ollama_models_dir).trim() : undefined,
        ollama_url: ollama_url !== undefined ? String(ollama_url).trim() : undefined,
        embedding_model: embedding_model !== undefined ? String(embedding_model).trim() : undefined,
        top_k: top_k !== undefined ? clampInt(top_k, 1, 20, 4) : undefined,
        similarity_threshold: similarity_threshold !== undefined ? clampFloat(similarity_threshold, 0, 0.99, 0.4) : undefined,
        search_mode: (search_mode === 'vector' || search_mode === 'hybrid') ? search_mode : undefined,
        rerank_enabled: typeof rerank_enabled === 'boolean' ? rerank_enabled : undefined,
        query_expansion_enabled: typeof query_expansion_enabled === 'boolean' ? query_expansion_enabled : undefined,
        hyde_enabled: typeof hyde_enabled === 'boolean' ? hyde_enabled : undefined
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

  // Shared standalone-AI builder used by the Model Forge form AND the
  // "rebuild after AI-pack import" flow (ROADMAP §5.1 / Model Forge). Bakes
  // the CURRENT knowledge base into a system prompt and creates the model in
  // Ollama. Returns a Promise<boolean>; all progress/errors go through
  // sendProgress and the caller ends the NDJSON response.
  function bakeStandaloneAi({ base_model, modelName, instructions, sendProgress }) {
    return new Promise((resolve) => {
      (async () => {
        sendProgress({ status: 'progress', percent: 8, stage: 'Reading your knowledge base...' });

        const docs = vectorStore.documents || [];
        if (docs.length === 0) {
          sendProgress({ status: 'error', detail: 'Your knowledge base is empty — add documents first, then create your AI model.' });
          return resolve(false);
        }

        const kbContentStr = docs.map((d, idx) => `--- DOCUMENT ${idx + 1}: ${d.doc_title} ---\n${d.content}`).join('\n\n');

        sendProgress({
          status: 'progress',
          percent: 18,
          stage: `Found ${vectorStore.getStats().total_documents} document(s) (${docs.length} chunk(s)) to bake in. Checking model fit...`
        });

        // Honest fit warning (never silently bake a KB too big to be remembered).
        const fit = await analyzeKbFit(base_model, instructions);
        if (fit.verdict === 'too_large') {
          sendProgress({
            status: 'warning',
            detail: `⚠️ Your knowledge base (≈${fit.estimated_tokens} tokens) is larger than what '${base_model}' can remember in one go (≈${fit.usable_tokens} tokens). The model will only retain part of it. For best results use a model with a larger context window or trim your knowledge base first.`
          });
        }

        sendProgress({ status: 'progress', percent: 28, stage: 'Constructing the AI system prompt...' });

        const systemPrompt = `${instructions || 'You are a specialized expert AI assistant.'}\n\nVERIFIED EMBEDDED KNOWLEDGE BASE:\n${kbContentStr}\n\nINSTRUCTIONS:\nUse the above context and your knowledge base to answer user questions accurately.`;

        const { ollamaUrl } = getOllamaSettings();
        sendProgress({ status: 'progress', percent: 40, stage: `Building your AI model '${modelName}' from '${base_model}'...` });

        const ollamaRes = await fetch(`${ollamaUrl}/api/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: modelName,
            from: base_model,
            system: systemPrompt,
            stream: true
          })
        });

        if (!ollamaRes.ok) {
          const errText = await ollamaRes.text();
          sendProgress({ status: 'error', detail: `Ollama API error: ${errText}` });
          return resolve(false);
        }

        let progressStep = 45;
        let sawSuccess = false;

        ollamaRes.body.on('data', (chunk) => {
          const text = chunk.toString('utf-8');
          const lines = text.split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              if (data.status) {
                if (data.status === 'success') sawSuccess = true;
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
          if (!sawSuccess) {
            sendProgress({ status: 'error', detail: 'Ollama did not confirm the model build (no success event).' });
            return resolve(false);
          }
          const stats = vectorStore.getStats();
          aiRegistry.addAi({
            name: modelName,
            base_model,
            custom_instructions: instructions,
            kb: { documents: stats.total_documents, chunks: docs.length }
          });
          sendProgress({
            status: 'complete',
            percent: 100,
            message: `✔ Your AI model '${modelName}' is ready! Built from '${base_model}' with ${stats.total_documents} document(s) (${docs.length} chunk(s)) baked in. Run it in your terminal with: ollama run ${modelName}`,
            model: modelName
          });
          return resolve(true);
        });

        ollamaRes.body.on('error', (err) => {
          sendProgress({ status: 'error', detail: err.message });
          return resolve(false);
        });
      })().catch((e) => {
        console.error('Bake model error:', e);
        sendProgress({ status: 'error', detail: e.message });
        resolve(false);
      });
    });
  }

  app.post('/api/export-ollama-model', async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');

    const sendProgress = (obj) => res.write(JSON.stringify(obj) + '\n');
    const { base_model, new_model_name, custom_instructions } = req.body || {};

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
    if (!sanitizedModelName.includes(':')) sanitizedModelName += ':latest';

    const ok = await bakeStandaloneAi({
      base_model: base_model.trim(),
      modelName: sanitizedModelName,
      instructions,
      sendProgress
    });
    return res.end();
  });

  // ---- Custom-AI registry (Model Forge; feeds AI packs, ROADMAP §5.1) ----
  app.get('/api/ais', (req, res) => {
    return res.json({ ais: aiRegistry.listAis() });
  });

  app.post('/api/ai/rebuild', async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    const sendProgress = (obj) => res.write(JSON.stringify(obj) + '\n');
    const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      sendProgress({ status: 'error', detail: 'An AI name is required.' });
      return res.end();
    }
    const rec = aiRegistry.findAi(name);
    if (!rec) {
      sendProgress({ status: 'error', detail: `No registered AI named '${name}' found on this device.` });
      return res.end();
    }
    const ok = await bakeStandaloneAi({
      base_model: rec.base_model,
      modelName: rec.name,
      instructions: rec.custom_instructions || '',
      sendProgress
    });
    return res.end();
  });

  // Installed Ollama model names (used by import missing-model detection).
  async function fetchOllamaModelNames() {
    const { ollamaUrl } = getOllamaSettings();
    const tagsRes = await fetch(`${ollamaUrl}/api/tags`, { timeout: 4000 });
    if (!tagsRes.ok) return [];
    const data = await tagsRes.json();
    return (data.models || []).map((m) => m.name);
  }

  // Pull a missing Ollama model (post-import wizard / Model Forge helper),
  // NDJSON passthrough of Ollama's own pull progress.
  app.post('/api/ollama/pull', async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    const sendProgress = (obj) => res.write(JSON.stringify(obj) + '\n');
    const model = req.body && typeof req.body.model === 'string' ? req.body.model.trim() : '';
    const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_.:-]*)?$/; // optional ns/name, tag via :
    if (!model || model.length > 128 || model.includes('..') || !MODEL_RE.test(model)) {
      sendProgress({ status: 'error', detail: 'Please provide a valid model name to download (e.g. llama3.2 or qwen2.5:7b).' });
      return res.end();
    }
    try {
      const { ollamaUrl } = getOllamaSettings();
      const ollamaRes = await fetch(`${ollamaUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: model, stream: true })
      });
      if (!ollamaRes.ok) {
        const errText = await ollamaRes.text();
        sendProgress({ status: 'error', detail: `Ollama pull error: ${errText}` });
        return res.end();
      }
      let step = 10;
      let sawSuccess = false;
      ollamaRes.body.on('data', (chunk) => {
        const lines = chunk.toString('utf-8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.error) {
              sendProgress({ status: 'error', detail: `Ollama pull error: ${data.error}` });
            } else if (data.status === 'success') {
              sawSuccess = true;
              sendProgress({ status: 'complete', percent: 100, message: `✔ Model '${model}' is downloaded and ready.` });
            } else if (data.status) {
              step = Math.min(96, step + 7);
              sendProgress({ status: 'progress', percent: step, stage: `⬇ ${data.status}` });
            }
          } catch (e) { /* ignore partial chunks */ }
        }
      });
      ollamaRes.body.on('end', () => {
        if (!sawSuccess) sendProgress({ status: 'error', detail: `Ollama finished without confirming '${model}'. It may already be downloading in the Ollama app.` });
        return res.end();
      });
      ollamaRes.body.on('error', (err) => {
        sendProgress({ status: 'error', detail: err.message });
        res.end();
      });
    } catch (e) {
      sendProgress({ status: 'error', detail: `Cannot reach Ollama: ${e.message}` });
      return res.end();
    }
  });

  // Scheduled auto-backups (ROADMAP §5.6): while the app runs, snapshot the
  // KB when its file changed since the last snapshot. Interval in minutes:
  // RAGANYLLM_BACKUP_MINUTES (default 30, min 0.02 for tests). Timer is
  // unref'd so it never keeps the process alive on its own.
  const backupIntervalMin = Math.max(0.02, parseFloat(process.env.RAGANYLLM_BACKUP_MINUTES || '30') || 30);
  let backupTimer = null;
  let lastBackupMtime = 0;
  function scheduleAutoBackups(server) {
    if (backupTimer) clearInterval(backupTimer);
    if (backupIntervalMin <= 0) return;
    backupTimer = setInterval(() => {
      try {
        if (!fs.existsSync(vectorStore.storagePath)) return;
        const st = fs.statSync(vectorStore.storagePath);
        if (st.mtimeMs === lastBackupMtime) return; // unchanged since last snapshot
        if (makeBackup()) lastBackupMtime = st.mtimeMs;
      } catch (e) { /* non-fatal */ }
    }, backupIntervalMin * 60 * 1000);
    if (backupTimer.unref) backupTimer.unref();
    server.on('close', () => {
      if (backupTimer) { clearInterval(backupTimer); backupTimer = null; }
    });
  }

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
  // Shared builder: turn the live knowledge base (+ optional AI definitions)
  // into an encoded .raganyllm pack. Used by the export routes AND by the LAN
  // share flow (§5.4) so a share is byte-identical to what an export would be.
  function buildPackExport(req) {
    const docs = vectorStore.documents || [];
    if (docs.length === 0) return { empty: true };
    const includeEmbeddings = !(req.query && (req.query.embeddings === '0' || req.query.embeddings === 'false') || (req.body && req.body.embeddings === false));
    const password = (req.body && typeof req.body.password === 'string' && req.body.password)
      ? req.body.password
      : (req.query && typeof req.query.password === 'string' ? req.query.password : '');
    const requestedKind = (req.body && req.body.kind) ? req.body.kind : (req.query && req.query.kind);
    const kind = requestedKind === 'ai' ? 'ai' : 'knowledge';
    const pack = {
      format: 'raganyllm-pack',
      version: 1,
      kind,
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
    // AI packs (ROADMAP §5.1) also carry the custom-AI definitions registered
    // from this device's Model Forge, so a friend gets the assistant too.
    if (kind === 'ai') {
      pack.ai = { models: aiRegistry.listAis() };
    }
    const useZip = !(req.query && (req.query.zip === '0' || req.query.zip === 'false') || (req.body && req.body.zip === false));
    const body = packLib.encodePack(pack, password, { zip: useZip });
    const date = new Date().toISOString().slice(0, 10);
    return {
      body,
      contentType: Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
      filename: `${kind === 'ai' ? 'raganyllm-ai' : 'raganyllm-kb'}-${date}.raganyllm`,
      summary: {
        kind,
        protected: !!password,
        chunk_count: pack.knowledge.chunks.length,
        embedding_model: (pack.settings && pack.settings.embedding_model) || null,
        embeddings_included: !!pack.knowledge.embeddings,
        created_at: pack.created_at,
        ai_models: (pack.ai && Array.isArray(pack.ai.models)) ? pack.ai.models.map((m) => m.name) : []
      }
    };
  }

  function exportPackHandler(req, res) {
    try {
      const built = buildPackExport(req);
      if (built.empty) {
        return res.status(400).json({ detail: 'Your knowledge base is empty — add documents first, then export.' });
      }
      res.setHeader('Content-Type', built.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${built.filename}"`);
      return res.send(built.body);
    } catch (e) {
      console.error('Export KB error:', e);
      return res.status(500).json({ detail: `Export failed: ${e.message}` });
    }
  }

  app.get('/api/kb/export', exportPackHandler);
  app.post('/api/kb/export', exportPackHandler);

  // 7b. LAN share — single-use, auto-expiring transfer links (ROADMAP §5.4).
  // POST /api/kb/share snapshots the current KB into a pack and mints a token.
  // Any device on the network (or this one) opens /packs/share/:token, sees a
  // summary, and imports with one click — no external service, no file to
  // ferry around. Tokens live in memory only, are consumed by the first
  // successful import (or manual file download), and expire by default after
  // 60 minutes (RAGANYLLM_SHARE_TTL_MINUTES to tune, e.g. 0.05 = 3 seconds;
// floor 1 second, cap 7 days).
  const shares = new Map(); // token -> { expiresAt, bytes, filename, summary, consumed }
  const shareTtlMs = Math.max(1000, Math.min(7 * 24 * 60 * 60 * 1000,
    (parseFloat(process.env.RAGANYLLM_SHARE_TTL_MINUTES || '60') || 60) * 60 * 1000));

  function pruneShares() {
    const now = Date.now();
    for (const [token, sh] of shares) {
      if (sh.expiresAt <= now) shares.delete(token);
    }
  }

  function getShare(token) {
    pruneShares();
    const sh = shares.get(token);
    if (!sh || sh.consumed) return null;
    return sh;
  }

  function osLanIPv4() {
    try {
      for (const name of Object.keys(os.networkInterfaces())) {
        for (const addr of os.networkInterfaces()[name] || []) {
          if (addr.family === 'IPv4' && !addr.internal) return addr.address;
        }
      }
    } catch (e) { /* non-fatal */ }
    return null;
  }

  app.post('/api/kb/share', async (req, res) => {
    try {
      const built = buildPackExport(req);
      if (built.empty) {
        return res.status(400).json({ detail: 'Your knowledge base is empty — add documents first, then share.' });
      }
      pruneShares();
      const token = crypto.randomBytes(18).toString('base64url');
      log.info('share-created', 'single-use share link minted', { token: token.slice(0, 8), kind: built.summary.kind, chunk_count: built.summary.chunk_count, protected: built.summary.protected });
      shares.set(token, {
        expiresAt: Date.now() + shareTtlMs,
        bytes: built.body,
        filename: built.filename,
        summary: built.summary,
        consumed: false
      });
      const boundAll = host === '0.0.0.0' || host === '::' || host === '::0';
      const lanIp = osLanIPv4();
      // Best-guess absolute URL for non-browser consumers. The admin UI instead
      // composes the link from the browser's own origin (correct behind
      // proxies/reverse-proxies) and posts it back for the QR code.
      const reqHost = String(req.headers.host || '').split(':')[0];
      const guessedHost = (!boundAll && host) ? host : (lanIp || reqHost || 'localhost');
      const localPort = (req.socket && req.socket.localPort) || 8000;
      const guessedPort = (localPort && localPort !== 80 && localPort !== 443) ? `:${localPort}` : '';
      const scheme = req.secure ? 'https' : 'http';
      const baseUrl = (req.body && typeof req.body.base_url === 'string' && req.body.base_url.trim())
        ? req.body.base_url.trim().replace(/\/+$/, '')
        : `${scheme}://${guessedHost}${guessedPort}`;
      const pageUrl = `${baseUrl}/packs/share/${token}`;
      let qrSvg = null;
      try {
        qrSvg = await QRCode.toString(pageUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      } catch (e) { /* URL too long to encode -> UI just shows the link */ }
      return res.json({
        ok: true,
        token,
        path: `/packs/share/${token}`,
        url: pageUrl,
        qr_svg: qrSvg,
        ttl_minutes: Math.round(shareTtlMs / 60000),
        single_use: true,
        reachable_remotely: boundAll,
        lan_ip: lanIp,
        warning: boundAll ? null : 'The server is bound to this computer only — other devices cannot reach it. Restart with HOST=0.0.0.0 to share over your network.',
        summary: built.summary,
        filename: built.filename
      });
    } catch (e) {
      console.error('Share KB error:', e);
      return res.status(500).json({ detail: `Could not create the share link: ${e.message}` });
    }
  });

  function shareMeta(sh) {
    const m = sh.summary || {};
    return {
      kind: m.kind === 'ai' ? 'ai' : 'knowledge',
      protected: !!m.protected,
      chunk_count: m.chunk_count || 0,
      ai_models: Array.isArray(m.ai_models) ? m.ai_models : [],
      embedding_model: m.embedding_model,
      embeddings_included: !!m.embeddings_included,
      created_at: m.created_at,
      filename: sh.filename,
      single_use: true,
      expires_at: new Date(sh.expiresAt).toISOString()
    };
  }

  function sharePageHtml(token, sh) {
    const meta = shareMeta(sh);
    const tokenJs = JSON.stringify(token);
    const metaJs = JSON.stringify(meta);
    const kindLabel = meta.kind === 'ai' ? '🤖 AI knowledge pack' : '📚 Knowledge pack';
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Incoming raganyllm pack</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(1200px 600px at 20% -10%,#1e1b4b 0%,#0b1120 55%,#020617 100%);color:#e2e8f0;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px}
  .card{max-width:560px;width:100%;background:rgba(15,23,42,.85);border:1px solid #334155;border-radius:18px;padding:26px 28px;box-shadow:0 24px 60px rgba(2,6,23,.6)}
  h1{margin:0 0 4px;font-size:1.25rem}
  .sub{color:#94a3b8;margin:0 0 16px;font-size:.9rem}
  .badge{display:inline-block;font-size:.72rem;padding:2px 9px;border-radius:999px;margin:2px 6px 2px 0;background:rgba(139,92,246,.14);color:#c4b5fd;border:1px solid rgba(139,92,246,.3)}
  .badge.amber{background:rgba(251,191,36,.1);color:#fcd34d;border-color:rgba(251,191,36,.3)}
  .badge.green{background:rgba(74,222,128,.1);color:#86efac;border-color:rgba(74,222,128,.3)}
  .statrow{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 6px}
  .stat{flex:1;min-width:120px;background:rgba(2,6,23,.5);border:1px solid #1e293b;border-radius:10px;padding:10px 12px}
  .stat b{display:block;font-size:1.05rem}
  .stat span{font-size:.68rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.04em}
  .linkbox{display:flex;gap:8px;margin-top:16px}
  .linkbox input{flex:1;min-width:0;font-size:.78rem;padding:9px 11px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#7dd3fc}
  .btn{display:block;width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;cursor:pointer;font-size:.95rem;font-weight:600;color:#fff;background:linear-gradient(135deg,#7c3aed,#4f46e5);text-align:center;text-decoration:none}
  .btn.ghost{background:transparent;border:1px solid #334155;color:#cbd5e1;font-size:.85rem;padding:9px}
  .note{margin-top:14px;font-size:.8rem;color:#94a3b8;line-height:1.55}
  .hidden{display:none}
  #copied{color:#4ade80;font-size:.75rem;margin-top:6px}
</style>
</head>
<body>
<div class="card">
  <h1>${kindLabel} — from another raganyllm</h1>
  <p class="sub">A single-use share link: the pack can be fetched by exactly one recipient before it expires.</p>
  <div><span class="badge" id="b-chunks"></span><span class="badge amber hidden" id="b-protected">🔒 password-protected</span><span class="badge green hidden" id="b-emb">⚡ embeddings included</span><span class="badge hidden" id="b-ais"></span></div>
  <div class="statrow">
    <div class="stat"><b id="s-chunks">–</b><span>chunks</span></div>
    <div class="stat"><b id="s-exp">–</b><span>link expires</span></div>
    <div class="stat"><b id="s-model">–</b><span>embedding model</span></div>
  </div>
  <p class="note">The full link is:</p>
  <div class="linkbox"><input id="url" readonly value=""><button class="btn ghost" id="copyBtn" type="button" style="width:auto;margin-top:0">Copy</button></div>
  <div id="copied" class="hidden">✔ Copied</div>
  <a class="btn" id="downloadBtn">⬇ Download the .raganyllm pack (uses up the link)</a>
  <p class="note"><b>Importing into raganyllm on this computer:</b> either open the downloaded file via <b>⬇ Import KB</b>, or — if the app is already running here — use the KB panel's <b>Import from link</b> and paste the address above. Whichever way you use it, this link works once, then it's gone.</p>
  <p class="note">If the link stops working before you used it, it expired — ask the sender for a fresh one.</p>
</div>
<script>
  var TOKEN=${tokenJs};
  var META=${metaJs};
  var pageUrl=location.origin + '/packs/share/' + TOKEN;
  var urlInput=document.getElementById('url');
  urlInput.value=pageUrl;
  var dl=document.getElementById('downloadBtn');
  dl.href='/packs/share/'+TOKEN+'/download';
  dl.download=META.filename||'pack.raganyllm';
  document.getElementById('s-chunks').textContent=META.chunk_count;
  document.getElementById('s-exp').textContent=new Date(META.expires_at).toLocaleString([],{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
  document.getElementById('s-model').textContent=META.embedding_model||'—';
  document.getElementById('b-chunks').textContent=(META.kind==='ai'?'🤖 AI pack · ':'')+META.chunk_count+' chunk'+(META.chunk_count===1?'':'s');
  if(META.protected)document.getElementById('b-protected').classList.remove('hidden');
  if(META.embeddings_included)document.getElementById('b-emb').classList.remove('hidden');
  if(META.ai_models&&META.ai_models.length){var ae=document.getElementById('b-ais');ae.textContent='🤖 '+META.ai_models.length+' custom AI'+(META.ai_models.length>1?'s':'');ae.classList.remove('hidden');}
  document.getElementById('copyBtn').addEventListener('click',function(){
    var flash=function(){var c=document.getElementById('copied');c.classList.remove('hidden');setTimeout(function(){c.classList.add('hidden');},1600);};
    urlInput.focus();urlInput.select();
    try{navigator.clipboard.writeText(pageUrl).then(flash,function(){document.execCommand('copy');flash();});}
    catch(e){document.execCommand('copy');flash();}
  });
</script>
</body>
</html>
`;
  }

  app.get('/packs/share/:token', (req, res) => {
    const sh = getShare(req.params.token);
    if (!sh) {
      return res.status(410).send('<!doctype html><html><body style="font-family:system-ui;background:#0b1120;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="max-width:420px;text-align:center"><h2>🔗 This share link is no longer available</h2><p style="color:#94a3b8">It was already used once, or it expired. Ask the sender to create a fresh share link.</p></div></body></html>');
    }
    return res.send(sharePageHtml(req.params.token, sh));
  });

  app.get('/packs/share/:token/meta', (req, res) => {
    const sh = getShare(req.params.token);
    if (!sh) return res.status(410).json({ detail: 'gone' });
    return res.json(shareMeta(sh));
  });

  app.get('/packs/share/:token/download', (req, res) => {
    const sh = getShare(req.params.token);
    if (!sh) {
      return res.status(410).json({ detail: 'This share link is no longer available (already used or expired).' });
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${sh.filename}"`);
    res.on('finish', () => {
      const cur = shares.get(req.params.token);
      if (cur && res.statusCode === 200) {
        cur.consumed = true;
        log.info('share-consumed', 'single-use share link used', { token: req.params.token.slice(0, 8) });
      }
    });
    return res.send(sh.bytes);
  });



  // 7c. Preview a .raganyllm pack before importing (ROADMAP §5.2). Read-only:
  // decodes + summarizes the pack but never touches the local knowledge base.
  app.post('/api/kb/preview', packUpload.single('pack'), async (req, res) => {
    if (!req.file) return res.status(400).json({ detail: 'No .raganyllm pack file was uploaded.' });
    const password = (typeof req.body.password === 'string' && req.body.password) ? req.body.password : '';
    const decoded = packLib.decodePack(req.file.buffer, password);
    if (!decoded.ok) {
      return res.status(400).json({ ok: false, reason: decoded.reason, detail: decoded.detail });
    }
    const pack = decoded.pack;
    const chunks = pack.knowledge.chunks || [];
    const titles = [...new Set(chunks.map((c) => c.doc_title || 'Untitled'))].filter(Boolean);
    const embArr = pack.knowledge.embeddings;
    return res.json({
      ok: true,
      kind: pack.kind === 'ai' ? 'ai' : 'knowledge',
      created_at: pack.created_at || null,
      total_documents: titles.length,
      total_chunks: chunks.length,
      document_titles: titles.slice(0, 8),
      embedding_model: (pack.settings && pack.settings.embedding_model) || null,
      embeddings_included: Array.isArray(embArr) && embArr.length === chunks.length && chunks.length > 0,
      ai_models: (pack.kind === 'ai' && pack.ai && Array.isArray(pack.ai.models))
        ? pack.ai.models.map((m) => ({
            name: m.name,
            base_model: m.base_model,
            custom_instructions: (m.custom_instructions || '').slice(0, 140)
          }))
        : []
    });
  });

  // Shared import pipeline: decode + apply a pack's raw bytes. Used by both
  // /api/kb/import (uploaded file) and the LAN-share import (§5.4) so the two
  // paths behave identically. Emits the same NDJSON progress events; resolves
  // `true` only when the pack was FULLY applied (so a caller may then consume
  // a single-use token) and `false` on any failure the recipient may retry.
  async function runPackImport(buffer, opts, sendProgress) {
    try {
      const password = (typeof opts.password === 'string' && opts.password) ? opts.password : '';
      sendProgress({ status: 'progress', percent: 5, stage: 'Reading knowledge pack...', totalChunks: 0, currentChunk: 0 });

      // Shared codec: ZIP/JSON auto-detect, optional password decrypt,
      // format/version checks, all-or-nothing chunk normalization (lib/pack.js).
      const decoded = packLib.decodePack(buffer, password);
      if (!decoded.ok) {
        sendProgress({ status: 'error', detail: decoded.detail });
        return false;
      }
      const pack = decoded.pack;

      const mode = opts.mode === 'replace' ? 'replace' : 'merge';
      const normalized = packLib.normalizePackChunks(pack.knowledge.chunks);
      if (!normalized.ok) {
        sendProgress({ status: 'error', detail: normalized.detail });
        return false;
      }
      const docs = normalized.docs;

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
            return false;
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

      // AI packs additionally register their custom-AI definitions so the
      // recipient can rebuild the finished assistants (ROADMAP §5.1).
      let aiNote = '';
      let missingModels = [];
      if (pack.kind === 'ai' && pack.ai && Array.isArray(pack.ai.models)) {
        sendProgress({ status: 'progress', percent: 96, stage: 'Registering your custom AIs...', totalChunks: docs.length, currentChunk: docs.length });
        const reg = aiRegistry.importModels(pack.ai.models);
        if (reg.added > 0) {
          aiNote = ` + ${reg.added} AI definition(s) registered (rebuild them in 🤖 Model Forge)`;
        } else if (reg.skipped > 0) {
          aiNote = ` (all ${reg.skipped} AI definition(s) already on this device)`;
        }
        // Wizard data: which base models does this device still need so the
        // imported AIs can be rebuilt? (ROADMAP §5.2 post-import wizard.)
        try {
          const installed = await fetchOllamaModelNames();
          const missing = [...new Set(pack.ai.models.map((m) => m.base_model).filter((b) => b && !installed.includes(b)))];
          missingModels = missing.sort();
        } catch (e) { /* Ollama offline -> wizard simply won't offer downloads */ }
      }

      sendProgress({
        status: 'complete',
        percent: 100,
        message: `✔ ${modeNote}: ${added} new chunk(s) imported` + (skipped > 0 ? ` (${skipped} duplicate(s) skipped)` : '') + `. Now ${stats.total_documents} document(s) / ${stats.total_chunks} chunk(s).` + aiNote,
        missing_models: missingModels.length > 0 ? missingModels : undefined
      });
      return true;
    } catch (e) {
      console.error('Import KB error:', e);
      log.error('kb-import', 'import pipeline failed', { error: e.message });
      sendProgress({ status: 'error', detail: `Import failed: ${e.message}` });
      return false;
    }
  }

  app.post('/api/kb/import', packUpload.single('pack'), async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    const sendProgress = (obj) => res.write(JSON.stringify(obj) + '\n');

    if (!req.file) {
      sendProgress({ status: 'error', detail: 'No .raganyllm pack file was uploaded.' });
      return res.end();
    }
    await runPackImport(req.file.buffer, {
      password: (typeof req.body.password === 'string' && req.body.password) ? req.body.password : '',
      mode: req.body.mode
    }, sendProgress);
    return res.end();
  });

  // 8a. Import from another device's share link (ROADMAP §5.4). The RECEIVING
  // app fetches the sender's single-use link server-to-server and imports the
  // pack into THIS device's knowledge base — the sender's KB is never touched.
  // Downloaded bytes are cached locally per token for a few minutes so a wrong
  // password does not force the sender to re-share (the remote link itself is
  // single-use and is consumed by the first successful download).
  const shareFetchCache = new Map(); // token -> { bytes, fetchedAt }
  const SHARE_CACHE_TTL_MS = 10 * 60 * 1000;

  function pruneShareCache() {
    const now = Date.now();
    for (const [t, c] of shareFetchCache) {
      if (now - c.fetchedAt > SHARE_CACHE_TTL_MS) shareFetchCache.delete(t);
    }
  }

  function parseShareUrl(raw) {
    if (typeof raw !== 'string') return null;
    let u;
    try { u = new URL(raw.trim()); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const m = /^\/packs\/share\/([A-Za-z0-9_-]{10,})(\/.*)?$/.exec(u.pathname);
    if (!m) return null;
    return { origin: u.origin, token: m[1] };
  }

  async function remoteFetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
      if (!resp.ok) return { status: resp.status };
      return { status: resp.status, json: await resp.json() };
    } catch (e) {
      return { error: e.message };
    } finally { clearTimeout(timer); }
  }

  async function remoteFetchBuffer(url, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
      if (!resp.ok) return { status: resp.status };
      const bytes = Buffer.from(await resp.arrayBuffer());
      return { status: resp.status, bytes };
    } catch (e) {
      return { error: e.message };
    } finally { clearTimeout(timer); }
  }

  app.post('/api/kb/import-link', async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    const sendProgress = (obj) => res.write(JSON.stringify(obj) + '\n');
    try {
      const parsed = parseShareUrl(req.body && req.body.url);
      if (!parsed) {
        sendProgress({ status: 'error', detail: 'That does not look like a raganyllm share link. Paste the full http://…/packs/share/… address shown by the sending device.' });
        return res.end();
      }
      pruneShareCache();
      const cached = shareFetchCache.get(parsed.token);

      // 1) Check the link is still alive (skipped when we already hold the
      // bytes from an earlier fetch of this same token).
      let summary = null;
      if (!cached) {
        const metaUrl = `${parsed.origin}/packs/share/${parsed.token}/meta`;
        const meta = await remoteFetchJson(metaUrl, 8000);
        if (meta.error) {
          sendProgress({ status: 'error', detail: `Could not reach the sharing device (${meta.error}). Make sure both computers are on the same network and the sender started raganyllm with HOST=0.0.0.0.` });
          return res.end();
        }
        if (meta.status !== 200) {
          sendProgress({ status: 'error', detail: 'That share link is no longer available on the other device (already used or expired). Ask the sender for a fresh link.' });
          return res.end();
        }
        summary = meta.json;
      }
      if (summary && summary.chunk_count > 0) {
        sendProgress({
          status: 'progress', percent: 8,
          stage: `Found the ${summary.kind === 'ai' ? '🤖 AI ' : ''}knowledge pack — ${summary.chunk_count} chunk(s)${summary.protected ? ' (password-protected)' : ''}. Fetching it over the network…`,
          totalChunks: summary.chunk_count, currentChunk: 0
        });
      }

      // 2) The bytes: from the local cache, or via the sender's single-use
      // download link (consuming it — exactly one device may take the pack).
      let bytes = cached ? cached.bytes : null;
      if (!bytes) {
        const dlUrl = `${parsed.origin}/packs/share/${parsed.token}/download`;
        const dl = await remoteFetchBuffer(dlUrl, 60000);
        if (dl.error) {
          sendProgress({ status: 'error', detail: `Could not download the pack (${dl.error}). Is the sending device still running?` });
          return res.end();
        }
        if (dl.status !== 200) {
          sendProgress({ status: 'error', detail: dl.status === 410 ? 'That share link was already used or expired — the pack can only be fetched once. Ask the sender for a fresh link.' : `Download from the sharing device failed (HTTP ${dl.status}).` });
          return res.end();
        }
        bytes = dl.bytes;
        shareFetchCache.set(parsed.token, { bytes, fetchedAt: Date.now() });
      }

      // 3) Import locally — same pipeline as a file import (merge/replace,
      // password, duplicate-skip, AI registration).
      await runPackImport(bytes, {
        password: (req.body && typeof req.body.password === 'string') ? req.body.password : '',
        mode: (req.body && req.body.mode === 'replace') ? 'replace' : 'merge'
      }, sendProgress);
      return res.end();
    } catch (e) {
      console.error('Import-from-link error:', e);
      sendProgress({ status: 'error', detail: `Import from link failed: ${e.message}` });
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


  app.get('/api/kb/export/csv', (req, res) => {
    try {
      const docs = vectorStore.documents || [];
      if (docs.length === 0) return res.status(400).json({ detail: 'Your knowledge base is empty — add documents first, then export.' });
      const esc = (v) => {
        const str = String(v == null ? '' : v);
        return /[",\r\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
      };
      const lines = ['doc_title,source,chunk_index,content'];
      for (const d of docs) {
        lines.push([d.doc_title || 'Untitled', d.source || '', Number.isInteger(d.chunk_index) ? d.chunk_index : 0, d.content || ''].map(esc).join(','));
      }
      const body = lines.join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="raganyllm-kb-${new Date().toISOString().slice(0, 10)}.csv"`);
      return res.send(body);
    } catch (e) {
      console.error('CSV export error:', e);
      return res.status(500).json({ detail: `Export failed: ${e.message}` });
    }
  });

  app.get('/api/kb/export/report', (req, res) => {
    try {
      const docs = vectorStore.documents || [];
      if (docs.length === 0) return res.status(400).json({ detail: 'Your knowledge base is empty — add documents first, then export.' });
      const stats = vectorStore.getStats();
      const settings = getOllamaSettings();
      const cfg = getConfig();
      const byTitle = new Map();
      for (const d of docs) {
        const t = d.doc_title || 'Untitled';
        if (!byTitle.has(t)) byTitle.set(t, { source: d.source || '', chunks: [] });
        byTitle.get(t).chunks.push(d);
      }
      const escHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const docSections = [...byTitle.entries()].map(([title, info]) => {
        const chunks = info.chunks.map((c, i) =>
          `<tr><td class="idx">${i + 1}</td><td><pre>${escHtml(c.content)}</pre></td></tr>`).join('\n');
        return `<section class="doc"><h2>📄 ${escHtml(title)}</h2><p class="src">${escHtml(info.source)} · ${info.chunks.length} chunk(s)</p>
          <table>${chunks}</table></section>`;
      }).join('\n');
      const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>raganyllm Knowledge Base Report</title>
<style>
  body{font:14px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:860px;color:#0f172a;background:#fff}
  h1{font-size:1.5rem;margin:0 0 .2rem} .meta{color:#475569;font-size:.85rem;margin-bottom:1.4rem}
  .stats{display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:1.6rem}
  .stat{flex:1;min-width:120px;border:1px solid #e2e8f0;border-radius:10px;padding:.6rem .8rem}
  .stat b{display:block;font-size:1.3rem}.stat span{font-size:.7rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em}
  section.doc{border:1px solid #e2e8f0;border-radius:12px;padding:.9rem 1rem;margin-bottom:1rem;page-break-inside:avoid}
  section.doc h2{margin:0 0 .15rem;font-size:1.05rem}
  .src{color:#64748b;font-size:.78rem;margin:0 0 .5rem}
  table{width:100%;border-collapse:collapse}
  td{border-top:1px solid #eef2f7;padding:.35rem .4rem;vertical-align:top}
  td.idx{width:1.6rem;color:#94a3b8;text-align:right}
  pre{white-space:pre-wrap;word-break:break-word;margin:0;font:inherit}
</style></head><body>
  <h1>📚 raganyllm Knowledge Base Report</h1>
  <p class="meta">Generated ${new Date().toISOString()} · embedding model <b>${escHtml(cfg.embedding_model)}</b> · search mode <b>${escHtml(cfg.search_mode)}</b> · top-k ${settings.topK} · similarity ≥ ${settings.threshold}</p>
  <div class="stats">
    <div class="stat"><b>${stats.total_documents}</b><span>documents</span></div>
    <div class="stat"><b>${stats.total_chunks}</b><span>chunks</span></div>
    <div class="stat"><b>${stats.total_tokens ? stats.total_tokens : '—'}</b><span>≈ tokens</span></div>
  </div>
  ${docSections}
</body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="raganyllm-kb-${new Date().toISOString().slice(0, 10)}-report.html"`);
      return res.send(body);
    } catch (e) {
      console.error('Report export error:', e);
      return res.status(500).json({ detail: `Export failed: ${e.message}` });
    }
  });

  // 9b. Recent structured log records (ROADMAP §6) — same-origin only.
  app.get('/api/logs', (req, res) => {
    const lines = clampInt(parseInt(req.query.lines || req.query.tail, 10) || 100, 1, 500, 100);
    return res.json({ logs: log.ring().slice(-lines), log_dir: log.dir() });
  });

  // 9. RAG Query API (DO NOT override default Modelfile system prompt when use_rag is false)
  // Supports both JSON (stream: false/omitted) and SSE token streaming (stream: true).
  // Optional `history`: [{role:'user'|'assistant', content}] — previous turns of a
  // conversation, appended after any RAG system prompt so follow-up questions like
  // "and what about price?" stay in context (see ROADMAP §2.4).
  app.post('/api/query', async (req, res) => {
    const { query, model, use_rag = true, stream = false } = req.body;
    if (!query || !query.trim()) return res.status(400).json({ detail: 'Query is required.' });

    // ROADMAP §1.3 Simple-mode "How much detail?" — concise | balanced | detailed.
    const detail = (typeof req.body.detail === 'string' && promptLib.DETAILS.has(req.body.detail)) ? req.body.detail : undefined;

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
      let advInfo = null; // §2.2 advanced-retrieval trace (filters/expansion/rerank/hyde)
      const messages = [];

      if (use_rag) {
        // Perform RAG Vector Search & Inject System Prompt
        try {
          // §2.2 metadata filters: restrict retrieval to chosen documents /
          // sources (empty = everything).
          const docTitles = (Array.isArray(req.body.filter_docs) ? req.body.filter_docs : [])
            .filter((t) => typeof t === 'string' && t.trim())
            .map((t) => t.trim())
            .slice(0, 50);
          const sourceText = (typeof req.body.filter_source === 'string') ? req.body.filter_source.trim() : '';
          const filter = (docTitles.length > 0 || sourceText) ? { docTitles, sourceText } : null;

          // §2.2 advanced toggles: default from saved config, per-request
          // booleans override.
          const advCfg = getConfig();
          const wantRerank = (typeof req.body.rerank === 'boolean') ? req.body.rerank : !!advCfg.rerank_enabled;
          const wantExpand = (typeof req.body.query_expansion === 'boolean') ? req.body.query_expansion : !!advCfg.query_expansion_enabled;
          const wantHyde = (typeof req.body.hyde === 'boolean') ? req.body.hyde : !!advCfg.hyde_enabled;

          const pipe = await runRetrievalPipeline({
            model: selectedModel,
            query,
            topK: top_k,
            simThreshold,
            searchMode,
            filter,
            rerank: wantRerank,
            expand: wantExpand,
            hyde: wantHyde
          });
          retrievedChunks = pipe.chunks;
          advInfo = pipe.info;

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

            // ROADMAP §2.3: the RAG instruction layer is assembled from a
            // per-model-family template (+ Simple-mode detail level) instead of
            // one hard-coded block. Ollama's own Modelfile still handles the
            // low-level chat template per family.
            const systemPrompt = promptLib.buildRagSystemPrompt({ context: contextStr, family: selectedModel, detail });

            messages.push({ role: 'system', content: systemPrompt });
          } else {
            ragStatus = 'no_context';
            // Honest fallback: no relevant context above threshold — the model
            // must say so instead of quietly answering without knowledge.
            messages.push({
              role: 'system',
              content: promptLib.honestyFallback(selectedModel)
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
        prompt_family: promptLib.modelFamily(selectedModel),
        retrieval_settings: {
          top_k, similarity_threshold: simThreshold, search_mode: searchMode,
          detail: detail || null,
          filter_docs: (advInfo && advInfo.filter && advInfo.filter.docTitles.length > 0) ? advInfo.filter.docTitles : null,
          filter_source: (advInfo && advInfo.filter && advInfo.filter.sourceText) ? advInfo.filter.sourceText : null,
          rerank: !!(advInfo && advInfo.rerank),
          query_expansion: !!(advInfo && advInfo.query_expansion),
          hyde: !!(advInfo && advInfo.hyde)
        },
        hyde_passage: (advInfo && advInfo.hyde_passage) ? advInfo.hyde_passage : null,
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

      return res.json({ answer, ...metaPayload });
    } catch (e) {
      console.error('RAG Query Error:', e);
      log.error('query-error', 'RAG query failed', { model: selectedModel, error: e.message });
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
        scheduleAutoBackups(server);
        // §5.4: expired share links are swept in the background (unref'd so
        // tests/apps can exit; cleared when the server closes).
        try { pruneShares(); } catch (e) { /* non-fatal */ }
        const shareSweep = setInterval(() => { try { pruneShares(); } catch (e) { /* non-fatal */ } }, 60 * 1000);
        if (shareSweep.unref) shareSweep.unref();
        server.on('close', () => clearInterval(shareSweep));
        log.info('server-start', 'raganyllm server listening', { host, port: actual });
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
