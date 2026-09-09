'use strict';
// Grounded-citation verification (ROADMAP §2.4).
//
// The RAG system prompt (§2.3/§2.4) asks the model to end sentences that use
// specific facts with a square-bracket marker, e.g. "…carbon steel holds
// heat evenly. [2]". Markers are *claims* — this module is the honesty
// layer: every marker is checked against the source chunk it points to, and
// markers with no lexical support (or an out-of-range index) are dropped so
// the UI never displays a fabricated citation. Pure & dependency-free.

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while',
  'of', 'in', 'on', 'at', 'to', 'for', 'from', 'with', 'by', 'as', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did', 'have', 'has',
  'had', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must',
  'not', 'no', 'so', 'too', 'very', 'it', 'its', 'this', 'that', 'these',
  'those', 'i', 'you', 'he', 'she', 'they', 'we', 'me', 'him', 'her', 'them',
  'us', 'my', 'your', 'our', 'their', 'what', 'which', 'who', 'whom', 'how',
  'about', 'into', 'over', 'under', 'again', 'further', 'once', 'here',
  'there', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'only', 'own', 'same'
]);

// Word-level tokenizer over content words (lowercased, unicode letters +
// digits, stopwords removed). Code tokens inside backticks are counted too —
// they carry real signal for code-heavy answers.
function contentTokens(text) {
  const out = [];
  for (const m of String(text || '').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const w = m[0];
    if (w.length > 1 && !STOPWORDS.has(w)) out.push(w);
  }
  return out;
}

// Split text into sentence-ish units with character offsets. A unit ends at
// a newline (keeps list bullets separate) or at sentence punctuation (. ! ?
// …) followed by whitespace/end — UNLESS what follows the punctuation is a
// citation marker ("…heat evenly. [2]"), which stays attached to the
// sentence it evidences. Returns [{ text, start, end }].
function splitSentences(text) {
  const units = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let cut = ch === '\n';
    if (!cut && '.!?…'.includes(ch) && i + 1 < text.length && /\s/.test(text[i + 1])) {
      let look = i + 1;
      while (look < text.length && /\s/.test(text[look])) look++;
      const after = text.slice(look, look + 6);
      cut = !/^\[\d{1,2}\]/.test(after); // "…sentence. [3]" -> no cut
    }
    if (cut) {
      units.push({ text: text.slice(start, i + 1), start, end: i + 1 });
      start = i + 1;
    }
  }
  if (start < text.length) units.push({ text: text.slice(start), start, end: text.length });
  return units;
}

const MARKER_RE = /\[(\d{1,2})\]/g;

// A marker is a *candidate citation* only when it sits at the end of a
// sentence — immediately after terminal punctuation (". …sentence. [2]")
// or alone at the end of a line — or continues a chain of markers
// ("[1][2]"). Bracketed numbers used as ordinary prose — "options [1] and
// [2]", "see [3] below" — are never treated as citation claims, so the UI
// neither chips nor strips them.
function isPlausibleMarker(text, start, end) {
  const next = end < text.length ? text[end] : null;
  if (next && /[\p{L}\p{N}]/u.test(next)) return false; // e.g. "[1]st"
  if (start === 0) return true;
  const prev = text[start - 1];
  if (/[\p{L}\p{N}]/u.test(prev)) return false; // glued to a word
  if (prev === ']' || prev === ')') return true;  // part of a "[1][2]" chain
  if (prev === '\n' || prev === ' ' || prev === '\t') {
    // Walk back over whitespace: sentence end means terminal punctuation
    // (or the line start) sits just before the gap.
    let j = start - 1;
    while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
    if (j < 0 || text[j] === '\n' || '.!?…'.includes(text[j])) return true;
    // Otherwise this is mid-prose ("points [1] and [2]"): only accept when
    // nothing but whitespace/closing punctuation follows on the line.
    let k = end;
    while (k < text.length && text[k] !== '\n' && /[\s)\]}"'….!?]/.test(text[k])) k++;
    return k >= text.length || text[k] === '\n';
  }
  return false;
}

function coefficient(sentenceTokens, chunkTokens) {
  if (!sentenceTokens.length) return 0;
  const inChunk = new Set(chunkTokens);
  let shared = 0;
  for (const w of sentenceTokens) if (inChunk.has(w)) shared++;
  return shared / sentenceTokens.length;
}

/**
 * Verify citation markers in a generated answer against the retrieved
 * sources. Sources are the same objects the model saw labelled
 * "[SOURCE 1]", "[SOURCE 2]", … (1-based).
 *
 * Returns:
 *   { citations, markers, cleanText }
 *   citations: per-sentence grouping of the KEPT markers:
 *     [{ sentence, sources: [1-based…], support }]
 *   markers: [{ start, end, source, supported, support }] — text offsets
 *     of each *citation claim* in the original answer, so streamed UIs can
 *     swap verified claims for chips and strip unverified claims (process
 *     from end to start). Ordinary bracketed prose never appears here.
 *   cleanText: answer with citation-claim markers removed (for history/copy);
 *     ordinary "[n]" prose references are preserved.
 */
function annotateCitations(answer, sources) {
  const text = String(answer || '');
  const empty = { citations: [], markers: [], cleanText: text };
  if (!text || !Array.isArray(sources) || sources.length === 0) return empty;
  if (!MARKER_RE.test(text)) {
    MARKER_RE.lastIndex = 0;
    return empty;
  }
  MARKER_RE.lastIndex = 0;

  const sentences = splitSentences(text);
  const sentencesByOffset = [];
  for (const s of sentences) {
    for (let p = s.start; p < s.end; p++) sentencesByOffset[p] = s;
  }
  // Tokenize each source once.
  const chunkTokens = sources.map((s) => contentTokens(s && s.content));

  const markers = [];
  let m;
  while ((m = MARKER_RE.exec(text)) !== null) {
    const source = parseInt(m[1], 10);
    const plausible = isPlausibleMarker(text, m.index, m.index + m[0].length);
    const inRange = source >= 1 && source <= sources.length;
    const sentence = sentencesByOffset[m.index] || null;
    const sentenceTokens = sentence ? contentTokens(sentence.text) : [];
    let support = 0;
    if (inRange && sentenceTokens.length > 0) {
      support = coefficient(sentenceTokens, chunkTokens[source - 1]);
    }
    // kind: 'cite' (a plausible claim -> verified => chip, unverified =>
    // dropped so the UI never shows a fabricated citation) or 'text' (an
    // ordinary bracketed number like "options [1] and [2]" -> left alone).
    const kind = plausible ? 'cite' : 'text';
    const supported = kind === 'cite' && inRange && sentenceTokens.length >= 2 && support >= 0.3;
    markers.push({
      start: m.index,
      end: m.index + m[0].length,
      source,
      kind,
      supported,
      support: Math.round(support * 100) / 100
    });
  }

  // Only citation claims travel on to the UI (kind 'cite'). Ordinary
  // bracketed prose never leaves this module — nothing to chip or strip.
  const claims = markers.filter((mk) => mk.kind === 'cite');

  // Group the supported markers by the sentence they live in (sentences are
  // listed in answer order; markers within one sentence are merged).
  const seen = new Map(); // sentence.start -> citation
  const citations = [];
  for (const mk of claims) {
    if (!mk.supported) continue;
    const sentence = sentencesByOffset[mk.start];
    if (!sentence) continue;
    let c = seen.get(sentence.start);
    if (!c) {
      c = { sentence: sentence.text.trim(), sentenceAnchor: sentence, sources: [], support: mk.support, _markerEnd: mk.end };
      seen.set(sentence.start, c);
      citations.push(c);
    }
    if (!c.sources.includes(mk.source)) c.sources.push(mk.source);
    if (mk.end > c._markerEnd) c._markerEnd = mk.end;
    c.support = Math.max(c.support, mk.support);
  }

  // cleanText: remove citation-claim markers (verified or not) but leave
  // ordinary bracketed numbers untouched, e.g. "points [1] and [2]".
  let cleanText = text;
  for (const mk of [...claims].reverse()) {
    cleanText = cleanText.slice(0, mk.start) + cleanText.slice(mk.end);
  }

  // The sentence a marker evidences ends at the marker itself, not at the
  // next punctuation (a streamed answer may continue on the same line).
  for (const c of citations) {
    const anchor = c.sentenceAnchor;
    if (anchor && c._markerEnd > anchor.start) {
      c.sentence = text.slice(anchor.start, c._markerEnd).trim();
    }
    delete c._markerEnd;
    delete c.sentenceAnchor;
  }

  return { citations, markers: claims, cleanText };
}

module.exports = { annotateCitations, splitSentences, contentTokens };
