'use strict';
// Shared .raganyllm knowledge-pack codec used by both the HTTP server
// (lib/server.js) and the CLI (bin/cli.js) so the pack format stays in sync
// (ROADMAP §5.1 / §5.3).
//
// On-disk formats:
//   plain:      { format:'raganyllm-pack', version:1, ... }
//   encrypted:  { format:'raganyllm-pack-enc', version:1, kdf, cipher, ciphertext }
//               where ciphertext is the AES-256-GCM encryption of the inner
//               plain pack JSON (scrypt key derivation, random salt+iv).

const crypto = require('crypto');

const PACK_VERSION = 1;

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

// Encode a pack object (or the outer wrapper) into the string that goes to
// disk / over the wire. `password` empty => plain JSON.
function encodePack(pack, password) {
  if (password) return encryptPackJson(pack, password);
  return JSON.stringify(pack);
}

// Decode a raw pack string into the inner pack object. Never throws; returns
// { ok:true, pack } or { ok:false, detail, reason } with a plain-language
// detail suitable for both the UI and the CLI.
function decodePack(buffer, password) {
  let outer;
  try {
    outer = JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString('utf-8') : String(buffer));
  } catch (e) {
    return { ok: false, reason: 'not-json', detail: 'This file is not a valid .raganyllm knowledge pack (could not be read as JSON).' };
  }

  if (outer && outer.format === 'raganyllm-pack-enc') {
    if (!password) {
      return { ok: false, reason: 'needs-password', detail: 'This knowledge pack is password-protected. Enter its password and try importing again.' };
    }
    try {
      outer = decryptPackJson(outer, password);
    } catch (e) {
      return { ok: false, reason: 'bad-password', detail: 'Could not open this pack — the password is incorrect or the file was modified. Please try again.' };
    }
  }

  if (!outer || outer.format !== 'raganyllm-pack' || !outer.knowledge || !Array.isArray(outer.knowledge.chunks)) {
    return { ok: false, reason: 'wrong-format', detail: 'This file is not a valid .raganyllm knowledge pack (wrong format).' };
  }
  if (outer.version !== PACK_VERSION) {
    return { ok: false, reason: 'unsupported-version', detail: `Unsupported knowledge pack version (${outer.version}). Please update raganyllm and try again.` };
  }
  return { ok: true, pack: outer };
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

module.exports = { encodePack, decodePack, normalizePackChunks, PACK_VERSION };
