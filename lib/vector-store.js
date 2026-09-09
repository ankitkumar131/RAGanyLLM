const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getFilePath } = require('./paths');

class VectorStore {
  constructor(storagePath = getFilePath('raganyllm-kb.json')) {
    // Absolute paths (data-dir resolved, tests, RAGANYLLM_HOME) pass through;
    // relative paths are kept relative to cwd for simple dev experiments.
    this.storagePath = path.isAbsolute(storagePath)
      ? storagePath
      : path.resolve(process.cwd(), storagePath);
    this.documents = [];
    this.embeddings = []; // Array of float arrays
    this._contentIndex = new Set(); // keys: sha256(source|chunk_index|content)
    this.load();
  }

  // Recursive character text chunker
  static chunkText(text, chunkSize = 600, overlap = 100) {
    if (!text || typeof text !== 'string') return [];
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    if (text.length <= chunkSize) return [text];

    const chunks = [];
    let start = 0;
    while (start < text.length) {
      let end = start + chunkSize;
      if (end >= text.length) {
        chunks.push(text.slice(start));
        break;
      }

      let breakPos = text.lastIndexOf('\n\n', end);
      if (breakPos === -1 || breakPos < start + Math.floor(chunkSize / 2)) {
        breakPos = text.lastIndexOf('\n', end);
      }
      if (breakPos === -1 || breakPos < start + Math.floor(chunkSize / 2)) {
        breakPos = text.lastIndexOf('. ', end);
      }

      if (breakPos !== -1 && breakPos > start) {
        chunks.push(text.slice(start, breakPos).trim());
        start = breakPos + 1 - overlap;
      } else {
        chunks.push(text.slice(start, end).trim());
        start = end - overlap;
      }
    }
    return chunks.filter(c => c.length > 15);
  }

  // Normalize float vector
  static normalizeVector(vec) {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    if (norm === 0) return vec;
    return vec.map(v => v / norm);
  }

  // Cosine similarity between two vectors
  static cosineSimilarity(vecA, vecB) {
    let dot = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += vecA[i] * vecB[i];
    }
    return dot;
  }

  // Stable dedupe key for a chunk object.
  static contentKey(doc) {
    const source = doc.source || doc.doc_title || '';
    const idx = doc.chunk_index === undefined ? '' : doc.chunk_index;
    const content = doc.content || '';
    return crypto.createHash('sha256').update(`${source}\u0000${idx}\u0000${content}`).digest('hex');
  }

  // True when an identical chunk (same source + index + content) already exists.
  isDuplicate(doc) {
    return this._contentIndex.has(VectorStore.contentKey(doc));
  }

  addChunks(chunks, chunkEmbeddings) {
    if (!chunks || !chunkEmbeddings || chunks.length === 0) {
      return { added: 0, skipped: 0 };
    }

    let added = 0;
    let skipped = 0;

    for (let i = 0; i < chunks.length; i++) {
      const key = VectorStore.contentKey(chunks[i]);
      if (this._contentIndex.has(key)) {
        skipped++;
        continue;
      }
      const normEmb = VectorStore.normalizeVector(chunkEmbeddings[i]);
      this.documents.push(chunks[i]);
      this.embeddings.push(normEmb);
      this._contentIndex.add(key);
      added++;
    }

    if (added > 0) this.save();
    return { added, skipped };
  }

  search(queryEmbedding, topK = 5, scoreThreshold = 0.4) {
    if (this.embeddings.length === 0 || this.documents.length === 0) {
      return [];
    }

    const normQuery = VectorStore.normalizeVector(queryEmbedding);
    const results = [];

    for (let i = 0; i < this.embeddings.length; i++) {
      const score = VectorStore.cosineSimilarity(normQuery, this.embeddings[i]);
      if (score >= scoreThreshold) {
        results.push({
          ...this.documents[i],
          similarity_score: parseFloat(score.toFixed(4))
        });
      }
    }

    results.sort((a, b) => b.similarity_score - a.similarity_score);
    return results.slice(0, topK);
  }

  getStats() {
    const titles = Array.from(new Set(this.documents.map(d => d.doc_title || 'Untitled')));
    return {
      total_chunks: this.documents.length,
      total_documents: titles.length,
      document_titles: titles
    };
  }

  clear() {
    this.documents = [];
    this.embeddings = [];
    this._contentIndex.clear();
    if (fs.existsSync(this.storagePath)) {
      try {
        fs.unlinkSync(this.storagePath);
      } catch (e) {
        // ignore error
      }
    }
  }

  save() {
    try {
      const data = {
        documents: this.documents,
        embeddings: this.embeddings
      };
      fs.writeFileSync(this.storagePath, JSON.stringify(data), 'utf-8');
    } catch (e) {
      console.error('Error saving vector store:', e);
    }
  }

  load() {
    this.documents = [];
    this.embeddings = [];
    this._contentIndex = new Set();
    if (fs.existsSync(this.storagePath)) {
      try {
        const raw = fs.readFileSync(this.storagePath, 'utf-8');
        const data = JSON.parse(raw);
        this.documents = data.documents || [];
        this.embeddings = data.embeddings || [];
        // Rebuild content index (also silently heals any pre-existing duplicates
        // added by older versions that lacked dedupe).
        const seen = new Set();
        const uniqueDocs = [];
        const uniqueEmbs = [];
        for (let i = 0; i < this.documents.length; i++) {
          const key = VectorStore.contentKey(this.documents[i]);
          if (seen.has(key)) continue;
          seen.add(key);
          uniqueDocs.push(this.documents[i]);
          uniqueEmbs.push(this.embeddings[i] || []);
        }
        if (uniqueDocs.length !== this.documents.length) {
          console.warn(`[vector-store] Removed ${this.documents.length - uniqueDocs.length} duplicate chunk(s) on load.`);
          this.documents = uniqueDocs;
          this.embeddings = uniqueEmbs;
          this.save();
        }
        this._contentIndex = seen;
      } catch (e) {
        console.error('Error loading vector store:', e);
        this.documents = [];
        this.embeddings = [];
        this._contentIndex = new Set();
      }
    }
  }
}

module.exports = VectorStore;
