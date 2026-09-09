const fs = require('fs');
const path = require('path');

class VectorStore {
  constructor(storagePath = 'raganyllm-kb.json') {
    this.storagePath = path.resolve(process.cwd(), storagePath);
    this.documents = [];
    this.embeddings = []; // Array of float arrays
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

  addChunks(chunks, chunkEmbeddings) {
    if (!chunks || !chunkEmbeddings || chunks.length === 0) return;

    for (let i = 0; i < chunks.length; i++) {
      const normEmb = VectorStore.normalizeVector(chunkEmbeddings[i]);
      this.documents.push(chunks[i]);
      this.embeddings.push(normEmb);
    }
    this.save();
  }

  search(queryEmbedding, topK = 5, scoreThreshold = 0.15) {
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
    if (fs.existsSync(this.storagePath)) {
      try {
        const raw = fs.readFileSync(this.storagePath, 'utf-8');
        const data = JSON.parse(raw);
        this.documents = data.documents || [];
        this.embeddings = data.embeddings || [];
      } catch (e) {
        console.error('Error loading vector store:', e);
        this.documents = [];
        this.embeddings = [];
      }
    }
  }
}

module.exports = VectorStore;
