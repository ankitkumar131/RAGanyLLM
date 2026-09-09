'use strict';
// Smart chunking (ROADMAP §2.1). Two pure splitters, no dependencies:
//
//  - splitPlain(text, size, overlap): the canonical character-level chunker
//    (moved here from VectorStore.chunkText so there is a single source of
//    truth). Breaks at paragraph → line → sentence boundaries.
//
//  - markdownChunks(text, opts): structure-aware splitting for Markdown.
//    Chunks respect section headings (# → heading levels with a full heading
//    path) and fenced code blocks are kept intact (never split mid-fence, and
//    a '#' inside a fence is not treated as a heading). Every chunk carries
//    `heading` + `headingPath` metadata for better citations/display.
//
// Both return [{ content, heading, headingPath }] (heading/headingPath are
// null when the source has no headings).

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function splitPlain(text, chunkSize = 600, overlap = 100) {
  if (!text || typeof text !== 'string') return [];
  const normalized = text.replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return [];
  if (normalized.length <= chunkSize) return [{ content: normalized, heading: null, headingPath: null }];

  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = start + chunkSize;
    if (end >= normalized.length) {
      chunks.push(normalized.slice(start));
      break;
    }

    let breakPos = normalized.lastIndexOf('\n\n', end);
    if (breakPos === -1 || breakPos < start + Math.floor(chunkSize / 2)) {
      breakPos = normalized.lastIndexOf('\n', end);
    }
    if (breakPos === -1 || breakPos < start + Math.floor(chunkSize / 2)) {
      breakPos = normalized.lastIndexOf('. ', end);
    }

    if (breakPos !== -1 && breakPos > start) {
      chunks.push(normalized.slice(start, breakPos).trim());
      start = breakPos + 1 - overlap;
    } else {
      chunks.push(normalized.slice(start, end).trim());
      start = end - overlap;
    }
  }
  return chunks.filter((c) => c.length > 15).map((content) => ({ content, heading: null, headingPath: null }));
}

function isFenceStart(line) {
  const t = line.trim();
  return /^```/.test(t) || /^~~~/.test(t);
}
function isFenceEnd(line, marker) {
  const t = line.trim();
  const sym = marker[0];
  const count = marker.length;
  return new RegExp(`^${sym}{${count},}\\s*$`).test(t);
}

// Split one section's raw text (headings + body) into chunks, keeping fenced
// code blocks intact whenever they fit.
function splitSection(raw, chunkSize) {
  const text = raw.replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return [];
  if (text.length <= chunkSize) return [text];

  // Break into atomic blocks: fences stay whole, everything else is split on
  // blank lines into paragraphs (a run of non-empty lines).
  const lines = text.split('\n');
  const blocks = [];
  let fenceMarker = null;
  let acc = [];
  const flushAcc = () => {
    if (acc.length > 0) {
      blocks.push({ type: 'text', text: acc.join('\n') });
      acc = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenceMarker) {
      acc.push(line);
      if (isFenceEnd(line, fenceMarker)) {
        blocks.push({ type: 'fence', text: acc.join('\n') });
        acc = [];
        fenceMarker = null;
      }
      continue;
    }
    if (isFenceStart(line)) {
      flushAcc();
      fenceMarker = line.trim().match(/^(```+|~~~+)/)[1];
      acc.push(line);
      continue;
    }
    if (line.trim() === '') {
      flushAcc();
      continue;
    }
    acc.push(line);
  }
  flushAcc();

  // Pack blocks into chunks of <= chunkSize. Fences are atomic; an oversized
  // fence or paragraph is sliced on newlines as a last resort.
  const out = [];
  let current = [];
  let currentLen = 0;
  const pushText = (t) => {
    const piece = t.trim();
    if (piece) out.push(piece);
  };
  for (const block of blocks) {
    if (block.type === 'fence') {
      if (block.text.length <= chunkSize) {
        if (currentLen + block.text.length + 2 > chunkSize && currentLen > 0) {
          pushText(current.join('\n\n'));
          current = [];
          currentLen = 0;
        }
        current.push(block.text);
        currentLen += block.text.length + 2;
        continue;
      }
      // Oversized fence: flush pending, then slice the fence interior.
      pushText(current.join('\n\n'));
      current = [];
      currentLen = 0;
      const interior = block.text.split('\n');
      let part = [];
      let partLen = 0;
      for (const il of interior) {
        if (partLen + il.length + 1 > chunkSize && part.length > 0) {
          pushText(part.join('\n'));
          part = [];
          partLen = 0;
        }
        part.push(il);
        partLen += il.length + 1;
      }
      if (part.length) pushText(part.join('\n'));
      continue;
    }
    // Text block
    if (currentLen + block.text.length + 2 <= chunkSize) {
      current.push(block.text);
      currentLen += block.text.length + 2;
    } else if (block.text.length <= chunkSize) {
      pushText(current.join('\n\n'));
      current = [block.text];
      currentLen = block.text.length;
    } else {
      // Oversized paragraph -> character-level split via splitPlain.
      pushText(current.join('\n\n'));
      current = [];
      currentLen = 0;
      for (const piece of splitPlain(block.text, chunkSize, 0)) {
        if (piece.content) pushText(piece.content);
      }
    }
  }
  pushText(current.join('\n\n'));
  return out;
}

function markdownChunks(text, opts = {}) {
  const chunkSize = Number.isInteger(opts.chunkSize) && opts.chunkSize > 0 ? opts.chunkSize : 600;
  if (!text || typeof text !== 'string') return [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return [];

  // First pass: walk lines and slice the document into heading sections.
  const sections = [];
  let cur = { heading: null, headingPath: null, lines: [] };
  const stack = []; // { level, title }
  const lines = normalized.split('\n');
  let fenceMarker = null;

  const flushSection = () => {
    if (cur.lines.some((l) => l.trim() !== '')) sections.push(cur);
    cur = { heading: null, headingPath: null, lines: [] };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenceMarker) {
      cur.lines.push(line);
      if (isFenceEnd(line, fenceMarker)) fenceMarker = null;
      continue;
    }
    if (isFenceStart(line)) {
      const m = line.trim().match(/^(```+|~~~+)/);
      fenceMarker = m[1];
      cur.lines.push(line);
      continue;
    }
    const h = HEADING_RE.exec(line.trim());
    if (h) {
      flushSection();
      const level = h[1].length;
      const title = h[2].trim();
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      cur.heading = title;
      cur.headingPath = stack.slice(0, -1).map((s) => s.title).join(' › ') || null;
      cur.lines.push(line); // keep the heading text searchable/visible
      continue;
    }
    cur.lines.push(line);
  }
  flushSection();
  if (sections.length === 0) return [];

  // Second pass: size each section, splitting overlong ones.
  const out = [];
  for (const sec of sections) {
    const raw = sec.lines.join('\n');
    const parts = splitSection(raw, chunkSize);
    for (let i = 0; i < parts.length; i++) {
      // Continuation chunks repeat the section in headingPath (so a source
      // card can still show *where* inside the document the snippet lived),
      // but only the section-start chunk carries the `heading` itself.
      let headingPath = i === 0 ? sec.headingPath : (sec.headingPath || null);
      if (i > 0 && sec.heading) {
        headingPath = sec.headingPath ? `${sec.headingPath} › ${sec.heading}` : sec.heading;
      }
      out.push({
        content: parts[i],
        heading: i === 0 ? sec.heading : null,
        headingPath
      });
    }
  }
  return out;
}

module.exports = { splitPlain, markdownChunks };
