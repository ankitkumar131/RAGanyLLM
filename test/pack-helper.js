'use strict';
// Shared helpers for decoding .raganyllm export bodies in tests. Exports are
// ZIP containers (v2) by default; the codec transparently decodes v1 JSON too.
const { decodePack } = require('../lib/pack');

// Decode a fetch() response body into the canonical pack object.
async function decodeExportBody(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  const d = decodePack(buf, '');
  if (!d.ok) throw new Error(`test decode failed: ${d.reason} ${d.detail}`);
  return { pack: d.pack, bytes: buf };
}

// Read a pack file from disk (used by the CLI tests).
function readPackFile(file) {
  const d = decodePack(require('fs').readFileSync(file), '');
  if (!d.ok) throw new Error(`test read failed: ${d.reason} ${d.detail}`);
  return d.pack;
}

module.exports = { decodeExportBody, readPackFile };
