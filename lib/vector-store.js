const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const chunker = require('./chunker');
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
    this._keywordDirty = true; // BM25 index needs rebuild after any change
    this._kw = null; // lazy BM25 index
    this.load();
  }

  // Recursive character text chunker — delegates to lib/chunker.js so there
  // is a single source of truth for plain splitting (ROADMAP §2.1).
  static chunkText(text, chunkSize = 600, overlap = 100) {
    return chunker.splitPlain(text, chunkSize, overlap).map((c) => c.content);
  }

  // Normalize float vector
  // Optional retrieval filters (ROADMAP §2.2 metadata filters):
  //   filter = { docTitles?: string[] (exact titles), sourceText?: string (case-insensitive substring) }
  static matchesFilter(doc, filter) {
    if (!filter) return true;
    if (Array.isArray(filter.docTitles) && filter.docTitles.length > 0) {
      const title = (doc && doc.doc_title) || 'Untitled';
      if (!filter.docTitles.includes(title)) return false;
    }
    if (typeof filter.sourceText === 'string' && filter.sourceText.trim()) {
      const src = String((doc && doc.source) || '');
      if (!src.toLowerCase().includes(filter.sourceText.trim().toLowerCase())) return false;
    }
    return true;
  }

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
      this._keywordDirty = true;
      added++;
    }

    if (added > 0) this.save();
    return { added, skipped };
  }

  search(queryEmbedding, topK = 5, scoreThreshold = 0.4, filter = null) {
    if (this.embeddings.length === 0 || this.documents.length === 0) {
      return [];
    }

    const normQuery = VectorStore.normalizeVector(queryEmbedding);
    const results = [];

    for (let i = 0; i < this.embeddings.length; i++) {
      const score = VectorStore.cosineSimilarity(normQuery, this.embeddings[i]);
      if (score >= scoreThreshold && VectorStore.matchesFilter(this.documents[i], filter)) {
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
    const counts = {};
    for (const d of this.documents) {
      const t = d.doc_title || 'Untitled';
      counts[t] = (counts[t] || 0) + 1;
    }
    return {
      total_chunks: this.documents.length,
      total_documents: titles.length,
      document_titles: titles,
      // Per-document detail for the KB explorer UI.
      documents: titles.map(title => ({ title, chunk_count: counts[title] }))
    };
  }

  // Remove every chunk belonging to a document title. Returns number removed.
  removeByDocTitle(title) {
    if (!title || typeof title !== 'string') return 0;
    const before = this.documents.length;
    const keptDocs = [];
    const keptEmbs = [];
    for (let i = 0; i < this.documents.length; i++) {
      const t = this.documents[i].doc_title || 'Untitled';
      if (t === title) continue;
      keptDocs.push(this.documents[i]);
      keptEmbs.push(this.embeddings[i]);
    }
    const removed = before - keptDocs.length;
    if (removed > 0) {
      this.documents = keptDocs;
      this.embeddings = keptEmbs;
      this._contentIndex = new Set(keptDocs.map(d => VectorStore.contentKey(d)));
      this._keywordDirty = true;
      this.save();
    }
    return removed;
  }

  clear() {
    this.documents = [];
    this.embeddings = [];
    this._contentIndex.clear();
    this._keywordDirty = true;
    this._kw = null;
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
        this._keywordDirty = true;
        this._kw = null;
      }
    }
  }

  // ---------------------------------------------------------------- BM25 / hybrid
  // Lightweight in-memory BM25 keyword index over chunk texts (ROADMAP §2.2).
  // Built lazily and invalidated whenever documents change, so it always
  // matches the current KB without extra bookkeeping.

  static tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    return text.toLowerCase().match(/[a-z0-9]+/g) || [];
  }

  _ensureKeywordIndex() {
    if (!this._keywordDirty && this._kw) return this._kw;
    const n = this.documents.length;
    const docTokens = new Array(n);       // token -> count per doc
    const df = new Map();                 // token -> # docs containing it
    let totalTerms = 0;
    for (let i = 0; i < n; i++) {
      const tokens = VectorStore.tokenize(this.documents[i].content);
      const counts = new Map();
      for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
      docTokens[i] = counts;
      totalTerms += tokens.length;
      for (const t of counts.keys()) df.set(t, (df.get(t) || 0) + 1);
    }
    const avgdl = n > 0 ? totalTerms / n : 0;
    this._kw = { docTokens, df, avgdl, n };
    this._keywordDirty = false;
    return this._kw;
  }

  // BM25 (Okapi, k1=1.5, b=0.75) scores per document index (0 = worst).
  bm25Scores(queryText) {
    const n = this.documents.length;
    if (n === 0) return [];
    const { docTokens, df, avgdl, n: totalDocs } = this._ensureKeywordIndex();
    const queryTokens = VectorStore.tokenize(queryText);
    const seen = new Set();
    const idf = new Map();
    for (const t of queryTokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      const f = df.get(t) || 0;
      // Classic BM25 idf with smoothing; rare terms score higher.
      idf.set(t, Math.log(1 + (totalDocs - f + 0.5) / (f + 0.5)));
    }
    const scores = new Array(n).fill(0);
    const k1 = 1.5, b = 0.75;
    for (let i = 0; i < n; i++) {
      const doc = docTokens[i];
      let dl = 0;
      for (const c of doc.values()) dl += c;
      const denom = k1 * (1 - b + b * (avgdl > 0 ? dl / avgdl : 1));
      let s = 0;
      for (const [t, idfV] of idf) {
        const tf = doc.get(t) || 0;
        if (tf > 0) s += (idfV * tf * (k1 + 1)) / (tf + denom);
      }
      scores[i] = s;
    }
    return scores;
  }

  // Hybrid retrieval: BM25 keyword scores fused with cosine similarity via
  // Reciprocal Rank Fusion. Finds exact-name / identifier matches that pure
  // vector search misses while keeping semantic ranking. Documents surface
  // when they are a strong vector hit (>= scoreThreshold) OR a strong keyword
  // hit (keyword mode). similarity_score is the normalized fused score.
  hybridSearch(queryText, queryEmbedding, topK = 4, scoreThreshold = 0.4, filter = null) {
    const n = this.documents.length;
    if (n === 0) return [];

    const normQuery = VectorStore.normalizeVector(queryEmbedding);
    const bm = this.bm25Scores(queryText || '');

    const vecScores = new Array(n);
    for (let i = 0; i < n; i++) {
      vecScores[i] = VectorStore.cosineSimilarity(normQuery, this.embeddings[i]);
    }

    // Rank each dimension (1 = best).
    const orderBy = (arr) => {
      const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v);
      const rank = new Array(n);
      idx.forEach((item, pos) => { rank[item.i] = pos + 1; });
      return rank;
    };
    const vecRank = orderBy(vecScores);
    const bmRank = orderBy(bm);

    const K = 60; // RRF constant
    const keyCandidates = Math.max(3, topK * 4);
    const fused = [];
    for (let i = 0; i < n; i++) {
      const isVecHit = vecScores[i] >= scoreThreshold;
      const isKeyHit = bmRank[i] <= keyCandidates && bm[i] > 0;
      if (!isVecHit && !isKeyHit) continue; // gate: only meaningful hits admitted
      if (!VectorStore.matchesFilter(this.documents[i], filter)) continue; // metadata filters
      const rrf = 1 / (K + vecRank[i]) + (bm[i] > 0 ? 1 / (K + bmRank[i]) : 0);
      fused.push({
        ...this.documents[i],
        similarity_score: parseFloat(Math.min(1, rrf / (2 / (K + 1))).toFixed(4)),
        cosine_similarity: parseFloat(vecScores[i].toFixed(4)),
        keyword_score: parseFloat(bm[i].toFixed(3))
      });
    }
    fused.sort((a, b) => b.similarity_score - a.similarity_score);
    return fused.slice(0, topK);
  }
}

module.exports = VectorStore;
