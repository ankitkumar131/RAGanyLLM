const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const v4 = require('crypto').randomUUID || (() => Math.random().toString(36).substr(2, 9));

const VectorStore = require('./vector-store');
const { checkOllamaConnection } = require('./checker');
const { getConfig, saveConfig } = require('./config');

function createServer(preferredPort = 8000) {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage() });
  const vectorStore = new VectorStore('raganyllm-kb.json');

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.static(path.join(__dirname, '../public')));

  // Helper: Get current Ollama settings
  function getOllamaSettings() {
    const config = getConfig();
    const ollamaUrl = process.env.OLLAMA_URL || config.ollama_url || 'http://localhost:11434';
    const embeddingModel = process.env.EMBEDDING_MODEL || config.embedding_model || 'nomic-embed-text';
    const modelsDir = process.env.OLLAMA_MODELS || config.ollama_models_dir || '';
    return { ollamaUrl, embeddingModel, modelsDir };
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
      const { embeddingModel, modelsDir } = getOllamaSettings();
      const dbStats = vectorStore.getStats();

      return res.json({
        connected: status.connected,
        models: status.models,
        embedding_model: embeddingModel,
        ollama_models_dir: modelsDir,
        knowledge_base: dbStats
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
      const { ollama_models_dir, ollama_url, embedding_model } = req.body;
      const updated = saveConfig({
        ollama_models_dir: ollama_models_dir !== undefined ? ollama_models_dir.trim() : undefined,
        ollama_url: ollama_url !== undefined ? ollama_url.trim() : undefined,
        embedding_model: embedding_model !== undefined ? embedding_model.trim() : undefined
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

        vectorStore.addChunks(chunkObjs, chunkEmbs);
        totalAddedChunks += item.chunks.length;
        fileNames.push(item.filename);
      }

      sendProgress({
        status: 'complete',
        percent: 100,
        message: `Successfully ingested ${fileNames.length} file(s) into ${totalAddedChunks} vector chunks.`,
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

      vectorStore.addChunks(chunkObjs, chunkEmbs);

      sendProgress({
        status: 'complete',
        percent: 100,
        message: `Successfully scraped & ingested URL '${url}' (${chunks.length} vector chunks).`
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

      vectorStore.addChunks(chunkObjs, chunkEmbs);

      sendProgress({
        status: 'complete',
        percent: 100,
        message: `Successfully ingested '${title || 'Text'}' into ${chunks.length} vector chunks.`
      });
      return res.end();

    } catch (e) {
      sendProgress({ status: 'error', detail: e.message });
      return res.end();
    }
  });

  // 5. Create Standalone Ollama Model from Knowledge Base
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

    let sanitizedModelName = new_model_name.trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, '');
    if (!sanitizedModelName.includes(':')) {
      sanitizedModelName += ':latest';
    }

    try {
      sendProgress({ status: 'progress', percent: 10, stage: 'Retrieving Knowledge Base content...' });

      const docs = vectorStore.documents || [];
      let kbContentStr = '';
      if (docs.length > 0) {
        kbContentStr = docs.map((d, idx) => `--- DOCUMENT ${idx + 1}: ${d.doc_title} ---\n${d.content}`).join('\n\n');
      } else {
        kbContentStr = 'No custom documents provided.';
      }

      sendProgress({ status: 'progress', percent: 25, stage: 'Constructing Ollama System Prompt...' });

      const systemPrompt = `${custom_instructions || 'You are a specialized expert AI assistant.'}\n\nVERIFIED EMBEDDED KNOWLEDGE BASE:\n${kbContentStr}\n\nINSTRUCTIONS:\nUse the above context and your knowledge base to answer user questions accurately.`;

      const { ollamaUrl } = getOllamaSettings();

      sendProgress({ status: 'progress', percent: 40, stage: `Building Ollama model '${sanitizedModelName}' from '${base_model.trim()}'...` });

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
          message: `✔ Successfully created standalone Ollama model '${sanitizedModelName}'! You can now run 'ollama run ${sanitizedModelName}' directly in terminal.`
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

  // 6. Clear KB
  app.post('/api/clear-kb', (req, res) => {
    vectorStore.clear();
    return res.json({ message: 'Knowledge Base cleared successfully.' });
  });

  // 7. RAG Query API (DO NOT override default Modelfile system prompt when use_rag is false)
  app.post('/api/query', async (req, res) => {
    const { query, model, top_k = 4, use_rag = true } = req.body;
    if (!query || !query.trim()) return res.status(400).json({ detail: 'Query is required.' });

    try {
      const { ollamaUrl } = getOllamaSettings();
      let retrievedChunks = [];
      const messages = [];

      if (use_rag) {
        // Perform RAG Vector Search & Inject System Prompt
        try {
          const queryEmb = await getEmbedding(query);
          retrievedChunks = vectorStore.search(queryEmb, top_k, 0.15);

          if (retrievedChunks.length > 0) {
            const contextStr = retrievedChunks
              .map((c, idx) => `--- [SOURCE ${idx + 1}: ${c.doc_title}] (Similarity Match: ${c.similarity_score}) ---\n${c.content}`)
              .join('\n\n');

            const systemPrompt = `You are an expert AI assistant. Below is verified documentation retrieved from the user's Knowledge Base:\n\n${contextStr}\n\nINSTRUCTIONS:\n1. Answer the user's question directly using the provided context snippets.\n2. Include code examples where appropriate.\n3. Be concise, accurate, and structured.`;

            messages.push({ role: 'system', content: systemPrompt });
          }
        } catch (embErr) {
          console.warn('Embedding warning:', embErr.message);
        }
      }

      // DO NOT push system message when use_rag is false!
      // This allows the model's internal Modelfile system prompt (e.g. in angular20-lfm:latest) to be used!
      messages.push({ role: 'user', content: query });

      const selectedModel = model || 'llama3:latest';

      // Call Ollama Chat API
      const ollamaResp = await fetch(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: selectedModel,
          messages: messages,
          stream: false
        })
      });

      if (!ollamaResp.ok) {
        const errText = await ollamaResp.text();
        return res.status(500).json({ detail: `Ollama error: ${errText}` });
      }

      const resData = await ollamaResp.json();
      const answer = resData.message ? resData.message.content : 'No answer generated.';

      return res.json({
        query,
        answer,
        model_used: selectedModel,
        rag_enabled: use_rag,
        retrieved_sources: retrievedChunks
      });
    } catch (e) {
      console.error('RAG Query Error:', e);
      return res.status(500).json({ detail: e.message });
    }
  });

  // Return Promise with automatic EADDRINUSE port fallback
  return new Promise((resolve, reject) => {
    let port = parseInt(preferredPort, 10) || 8000;
    
    function tryListen() {
      const server = app.listen(port, () => {
        console.log(`🚀 raganyllm server running on http://localhost:${port}`);
        resolve({ app, server, port });
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
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
