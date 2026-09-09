'use strict';
// Shared .raganyllm knowledge-pack codec used by both the HTTP server
// (lib/server.js) and the CLI (bin/cli.js) so the pack format stays in sync
// (ROADMAP §5.1 / §5.3).
//
// On-disk formats (all detected automatically on import):
//   v1 plain:    JSON object { format:'raganyllm-pack', version:1, ... }
//   v1 enc:      { format:'raganyllm-pack-enc', ... ciphertext of v1 JSON }
//   v2 zip:      a real ZIP container (PK..) with manifest.json (version 2,
//                sha-256 checksums per entry), knowledge/chunks.jsonl,
//                knowledge/embeddings.jsonl, settings.json and
//                ai/model-card.json. Deflated; scales to large document sets.
//   v2 enc:      the same wrapper object with ciphertext = AES-256-GCM of the
//                ZIP bytes (scrypt key derivation, random salt+iv).
//
// Knowledge *schema* stays at version 1; the version bump only describes the
// transport container, so importers keep validating the same chunk fields.

const crypto = require('crypto');
const AdmZip = require('adm-zip');

const PACK_VERSION = 1; // knowledge schema version (unchanged across containers)
const ZIP_VERSION = 2; // ZIP container version

const ZIP_ENTRIES = [
  'manifest.json',
  'settings.json',
  'knowledge/chunks.jsonl',
  'knowledge/embeddings.jsonl',
  'ai/model-card.json'
];

function encryptBytes(bytes, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(password), salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    format: 'raganyllm-pack-enc',
    version: 1,
    container: Buffer.isBuffer(bytes) ? 'zip-v2' : 'json-v1',
    kdf: { name: 'scrypt', salt: salt.toString('base64') },
    cipher: { algo: 'aes-256-gcm', iv: iv.toString('base64'), tag: tag.toString('base64') },
    ciphertext: ciphertext.toString('base64')
  });
}

function decryptBytes(outer, password) {
  const salt = Buffer.from(outer.kdf.salt, 'base64');
  const iv = Buffer.from(outer.cipher.iv, 'base64');
  const tag = Buffer.from(outer.cipher.tag, 'base64');
  const key = crypto.scryptSync(String(password), salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  // Throws on wrong password / tampered file (GCM authentication failure).
  return Buffer.concat([decipher.update(Buffer.from(outer.ciphertext, 'base64')), decipher.final()]);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Flatten a pack object into v2 ZIP bytes.
function packToZip(pack) {
  const chunks = (pack.knowledge && Array.isArray(pack.knowledge.chunks)) ? pack.knowledge.chunks : [];
  const embeddings = (pack.knowledge && Array.isArray(pack.knowledge.embeddings)) ? pack.knowledge.embeddings : null;
  const settings = pack.settings && typeof pack.settings === 'object' ? pack.settings : {};
  const aiModels = (pack.kind === 'ai' && pack.ai && Array.isArray(pack.ai.models)) ? pack.ai.models : [];

  const files = {};
  files['knowledge/chunks.jsonl'] = Buffer.from(chunks.map((c) => JSON.stringify({
    id: c.id || crypto.randomUUID(),
    doc_title: c.doc_title || 'Untitled',
    content: c.content || '',
    source: c.source || '',
    chunk_index: Number.isInteger(c.chunk_index) ? c.chunk_index : 0
  })).join('\n'), 'utf8');

  if (embeddings && embeddings.length === chunks.length) {
    files['knowledge/embeddings.jsonl'] = Buffer.from(embeddings.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  }
  files['settings.json'] = Buffer.from(JSON.stringify(settings), 'utf8');
  if (aiModels.length > 0) {
    files['ai/model-card.json'] = Buffer.from(JSON.stringify({ models: aiModels }, null, 2), 'utf8');
  }

  const counts = {
    chunks: chunks.length,
    embeddings: files['knowledge/embeddings.jsonl'] ? chunks.length : 0,
    ais: aiModels.length
  };
  const entries = {};
  for (const name of Object.keys(files)) {
    entries[name] = { sha256: sha256(files[name]), bytes: files[name].length };
  }
  files['manifest.json'] = Buffer.from(JSON.stringify({
    format: 'raganyllm-pack',
    version: ZIP_VERSION,
    kind: pack.kind === 'ai' ? 'ai' : 'knowledge',
    created_at: pack.created_at || new Date().toISOString(),
    stats: pack.stats || { total_chunks: chunks.length, total_documents: 0 },
    counts,
    created_by_app: 'raganyllm',
    entries
  }, null, 2), 'utf8');

  const zip = new AdmZip();
  for (const [name, buf] of Object.entries(files)) {
    zip.addFile(name, buf, '', 0o644);
  }
  return zip.toBuffer();
}

// Parse v2 ZIP bytes back into the canonical pack object (knowledge schema v1
// plus container metadata). Verifies sha-256 entries and path allowlist.
function zipToPack(buf) {
  const zip = new AdmZip(buf);
  const names = new Set(zip.getEntries().map((e) => e.entryName).filter((n) => !n.endsWith('/')));
  const manifestName = 'manifest.json';
  if (!names.has(manifestName)) {
    throw new Error('ZIP container is missing manifest.json.');
  }
  const manifest = JSON.parse(zip.readAsText(manifestName));
  if (!manifest || manifest.format !== 'raganyllm-pack' || manifest.version !== ZIP_VERSION) {
    throw new Error('ZIP container has an unsupported manifest.');
  }
  // Reject anything outside the fixed entry set (blocks zip-slip / surprises).
  const allowed = new Set(ZIP_ENTRIES);
  for (const n of names) {
    if (!allowed.has(n)) throw new Error(`Unexpected entry in pack: ${n}`);
  }
  const readEntry = (name) => {
    if (!names.has(name)) return null;
    const raw = zip.readFile(name);
    const expected = manifest.entries && manifest.entries[name] && manifest.entries[name].sha256;
    if (expected && sha256(raw) !== expected) {
      throw new Error(`Checksum mismatch for ${name} — the pack is corrupted.`);
    }
    return raw;
  };

  const chunksRaw = readEntry('knowledge/chunks.jsonl');
  if (!chunksRaw) throw new Error('ZIP container has no chunks.jsonl.');
  const chunks = chunksRaw.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

  let embeddings = null;
  const embRaw = readEntry('knowledge/embeddings.jsonl');
  if (embRaw) {
    embeddings = embRaw.toString('utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  let settings = {};
  const setRaw = readEntry('settings.json');
  if (setRaw) {
    try { settings = JSON.parse(setRaw.toString('utf8')); } catch (e) { settings = {}; }
  }

  let aiModels = [];
  const aiRaw = readEntry('ai/model-card.json');
  if (aiRaw) {
    try {
      const card = JSON.parse(aiRaw.toString('utf8'));
      if (card && Array.isArray(card.models)) aiModels = card.models;
    } catch (e) { aiModels = []; }
  }

  const pack = {
    format: 'raganyllm-pack',
    version: PACK_VERSION, // knowledge schema
    container: 'zip-v2',
    kind: manifest.kind === 'ai' ? 'ai' : 'knowledge',
    created_at: manifest.created_at || null,
    stats: manifest.stats || null,
    settings,
    knowledge: { chunks, embeddings: embeddings || undefined }
  };
  if (aiModels.length > 0) pack.ai = { models: aiModels };
  return pack;
}

// Encode a pack object into the bytes/string that go to disk / over the wire.
//   encodePack(pack, password, { zip })  — zip:true (default) => v2 ZIP (or
//   encrypted ZIP when a password is given); zip:false => v1 JSON container.
// Returns a Buffer for ZIP forms and a string for plain v1 JSON.
function encodePack(pack, password, opts = {}) {
  const zip = !(opts.zip === false);
  if (zip) {
    const bytes = packToZip(pack);
    return password ? Buffer.from(encryptBytes(bytes, password), 'utf8') : bytes;
  }
  const json = JSON.stringify(pack);
  if (password) return encryptBytes(json, password);
  return json;
}

function isZip(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
}

// Decode a raw pack into the inner pack object. Never throws; returns
// { ok:true, pack } or { ok:false, detail, reason } with a plain-language
// detail suitable for both the UI and the CLI.
function decodePack(buffer, password) {
  let data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');

  // Password-protected wrapper first.
  if (!isZip(data)) {
    let outer = null;
    try {
      outer = JSON.parse(data.toString('utf8'));
    } catch (e) { /* fall through to zip / format errors below */ }
    if (outer && outer.format === 'raganyllm-pack-enc') {
      if (!password) {
        return { ok: false, reason: 'needs-password', detail: 'This knowledge pack is password-protected. Enter its password and try importing again.' };
      }
      try {
        data = decryptBytes(outer, password);
      } catch (e) {
        return { ok: false, reason: 'bad-password', detail: 'Could not open this pack — the password is incorrect or the file was modified. Please try again.' };
      }
    }
  }

  // ZIP container (v2) or plain JSON (v1)?
  let pack;
  if (isZip(data)) {
    try {
      pack = zipToPack(data);
    } catch (e) {
      return { ok: false, reason: 'bad-zip', detail: `This .raganyllm pack could not be opened (${e.message}).` };
    }
  } else {
    let outer;
    try {
      outer = JSON.parse(data.toString('utf8'));
    } catch (e) {
      return { ok: false, reason: 'not-json', detail: 'This file is not a valid .raganyllm knowledge pack (could not be read as JSON).' };
    }
    if (!outer || outer.format !== 'raganyllm-pack' || !outer.knowledge || !Array.isArray(outer.knowledge.chunks)) {
      return { ok: false, reason: 'wrong-format', detail: 'This file is not a valid .raganyllm knowledge pack (wrong format).' };
    }
    if (outer.version !== PACK_VERSION) {
      return { ok: false, reason: 'unsupported-version', detail: `Unsupported knowledge pack version (${outer.version}). Please update raganyllm and try again.` };
    }
    pack = outer;
  }

  return { ok: true, pack };
}

// All-or-nothing validation/normalization of pack chunks. Returns
// { ok:true, docs } or { ok:false, detail } — callers must not mutate the KB
// unless ok is true.
function normalizePackChunks(rawChunks) {
  if (!Array.isArray(rawChunks) || rawChunks.length === 0) {
    return { ok: false, detail: 'This pack contains no knowledge chunks.' };
  }
  const docs = [];
  for (let i = 0; i < rawChunks.length; i++) {
    const c = rawChunks[i];
    if (!c || typeof c.content !== 'string' || !c.content.trim() || c.content.length > 1000000) {
      return { ok: false, detail: `Pack chunk #${i + 1} is invalid (missing or oversized content). Import aborted — nothing was changed.` };
    }
    docs.push({
      id: typeof c.id === 'string' && c.id ? c.id : crypto.randomUUID(),
      doc_title: typeof c.doc_title === 'string' && c.doc_title ? c.doc_title : 'Imported Document',
      content: c.content,
      source: typeof c.source === 'string' && c.source ? c.source : 'Knowledge Pack Import',
      chunk_index: Number.isInteger(c.chunk_index) ? c.chunk_index : i
    });
  }
  return { ok: true, docs };
}

module.exports = { encodePack, decodePack, normalizePackChunks, packToZip, zipToPack, PACK_VERSION, ZIP_VERSION };
