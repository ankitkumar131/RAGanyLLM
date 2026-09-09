'use strict';
// Persistent registry of user-built custom AIs ("Model Forge" / standalone
// RAG models baked into Ollama). Gives AI packs (ROADMAP §5.1) an
// authoritative list of definitions to export and lets the UI list/rebuild
// them. Store: <data-dir>/raganyllm-ais.json  { ais: [...] }

const fs = require('fs');
const { getFilePath } = require('./paths');

const AI_FILE = getFilePath('raganyllm-ais.json');

function loadAis() {
  try {
    if (!fs.existsSync(AI_FILE)) return [];
    const data = JSON.parse(fs.readFileSync(AI_FILE, 'utf-8'));
    return Array.isArray(data.ais) ? data.ais : [];
  } catch (e) {
    return [];
  }
}

function saveAis(ais) {
  try {
    fs.mkdirSync(require('path').dirname(AI_FILE), { recursive: true });
    fs.writeFileSync(AI_FILE, JSON.stringify({ ais }, null, 2), 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

function listAis() {
  return loadAis().sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
}

function findAi(name) {
  return loadAis().find((a) => a.name === name) || null;
}

function addAi(rec) {
  const ais = loadAis();
  const now = new Date().toISOString();
  const idx = ais.findIndex((a) => a.name === rec.name);
  const entry = {
    name: rec.name,
    base_model: rec.base_model,
    custom_instructions: typeof rec.custom_instructions === 'string' ? rec.custom_instructions.slice(0, 4000) : '',
    kb: rec.kb && typeof rec.kb === 'object'
      ? { documents: Number.isInteger(rec.kb.documents) ? rec.kb.documents : null, chunks: Number.isInteger(rec.kb.chunks) ? rec.kb.chunks : null }
      : null,
    created_at: (idx >= 0 && ais[idx].created_at) || now,
    updated_at: now
  };
  if (idx >= 0) ais[idx] = entry;
  else ais.push(entry);
  saveAis(ais);
  return entry;
}

// Import/validate AI definitions from an AI pack (ROADMAP §5.1). Names are
// sanitized the same way the Model Forge route sanitizes them, so anything
// that lands in the registry is safe to rebuild via Ollama later.
function importModels(models) {
  if (!Array.isArray(models)) return { added: 0, skipped: 0 };
  const ais = loadAis();
  const known = new Set(ais.map((a) => a.name));
  let added = 0;
  let skipped = 0;
  for (const raw of models) {
    if (!raw || typeof raw !== 'object') { skipped++; continue; }
    let name = typeof raw.name === 'string' ? raw.name.trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, '') : '';
    if (!name.includes(':')) name += ':latest';
    const base = typeof raw.base_model === 'string' ? raw.base_model.trim() : '';
    if (!name || !base) { skipped++; continue; }
    const rec = {
      name,
      base_model: base.slice(0, 128),
      custom_instructions: typeof raw.custom_instructions === 'string' ? raw.custom_instructions : '',
      kb: raw.kb && typeof raw.kb === 'object'
        ? { documents: Number.isInteger(raw.kb.documents) ? raw.kb.documents : null, chunks: Number.isInteger(raw.kb.chunks) ? raw.kb.chunks : null }
        : null
    };
    if (known.has(name)) { skipped++; continue; }
    addAi(rec);
    known.add(name);
    added++;
  }
  return { added, skipped };
}

module.exports = { AI_FILE, listAis, findAi, addAi, importModels };
