'use strict';
// Pure helpers for the §2.2 advanced-retrieval features (query expansion,
// LLM reranking, HyDE). Everything here is deterministic and unit-testable;
// network calls (chat/embeddings) stay in the server route.
//
// Expansion pool / rerank sizing:
//   - when reranking, we first fetch a wider candidate pool (default 20) so
//     the reranker can promote something outside the naive top-k;
//   - expansion merges several query runs into one deduped pool.

const RERANK_CANDIDATE_POOL = 20; // roadmap: rerank over top ~20 candidates
const MAX_EXTRA_QUERIES = 2; // original + up to 2 paraphrases

// Stable identity of a retrieved chunk across query runs.
function chunkKey(c) {
  return `${(c && c.doc_title) || 'Untitled'}\u0000${(c && c.source) || ''}\u0000${Number.isInteger(c && c.chunk_index) ? c.chunk_index : (c && c.content ? c.content.slice(0, 64) : '')}`;
}

// candidate pool for the reranker given the desired final topK.
function rerankPoolSize(topK) {
  return Math.min(RERANK_CANDIDATE_POOL, Math.max(topK, Math.ceil(topK * 3)));
}

// Build the ordered list of search queries: original first, then up to
// MAX_EXTRA_QUERIES distinct non-empty paraphrases (deduped, capped length).
function selectQueries(original, extra = []) {
  const out = [original];
  const seen = new Set([original]);
  for (const q of extra) {
    if (out.length > MAX_EXTRA_QUERIES) break;
    const clean = typeof q === 'string' ? q.trim() : '';
    if (!clean || clean.length > 500) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

// Merge per-query candidate pools into one list: dedupe by chunkKey keeping
// the best similarity_score per key, sort descending, slice topK.
function mergePools(pools, topK) {
  const best = new Map();
  for (const pool of pools) {
    for (const c of pool || []) {
      const key = chunkKey(c);
      const prev = best.get(key);
      if (!prev || c.similarity_score > prev.similarity_score) best.set(key, c);
    }
  }
  return Array.from(best.values()).sort((a, b) => b.similarity_score - a.similarity_score).slice(0, topK);
}

// Extract a JSON array (or object) from a model reply, tolerating fences and
// surrounding prose. Returns null when nothing parseable is found — callers
// then fall back to their pre-LLM state (never fail a query on parse issues).
function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const objStart = t.indexOf('{');
  const arrStart = t.indexOf('[');
  const starts = [objStart, arrStart].filter((i) => i >= 0);
  if (starts.length === 0) return null;
  const from = Math.min(...starts);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (end <= from) return null;
  try {
    return JSON.parse(t.slice(from, end + 1));
  } catch (e) {
    return null;
  }
}

// Apply a model-provided index list (best-first) to reorder candidates.
// Invalid/missing indices are skipped; the result is always a permutation of
// the input (fallback = input order) so reranking can never lose candidates.
function reorderByIndices(chunks, indices) {
  if (!Array.isArray(indices) || !Array.isArray(chunks)) return chunks;
  const used = new Set();
  const out = [];
  for (const raw of indices) {
    const i = Number.isInteger(raw) ? raw : parseInt(raw, 10);
    if (Number.isNaN(i) || i < 0 || i >= chunks.length || used.has(i)) continue;
    used.add(i);
    out.push(chunks[i]);
  }
  for (let i = 0; i < chunks.length; i++) {
    if (!used.has(i)) out.push(chunks[i]);
  }
  return out;
}

module.exports = { chunkKey, rerankPoolSize, selectQueries, mergePools, extractJson, reorderByIndices, RERANK_CANDIDATE_POOL, MAX_EXTRA_QUERIES };
