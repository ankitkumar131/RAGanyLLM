const fs = require('fs');
const path = require('path');
const { getFilePath } = require('./paths');

// Config now lives in a user-owned data dir (~/.raganyllm by default),
// NOT in process.cwd() — see lib/paths.js.
const CONFIG_FILE = getFilePath('raganyllm-config.json');

const defaultConfig = {
  ollama_models_dir: '',
  ollama_url: 'http://localhost:11434',
  embedding_model: 'nomic-embed-text',
  // Retrieval quality controls (see ROADMAP.md §0 / §2)
  top_k: 4,
  similarity_threshold: 0.4
};

function getConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return { ...defaultConfig };
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return { ...defaultConfig, ...data };
  } catch (e) {
    console.error('Error reading config file:', e);
    return { ...defaultConfig };
  }
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampFloat(value, min, max, fallback) {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function saveConfig(newConfig) {
  try {
    const current = getConfig();
    const updated = { ...current, ...newConfig };

    // Defensive clamping of numeric settings that can come from the HTTP API.
    if (updated.top_k !== undefined) {
      updated.top_k = clampInt(updated.top_k, 1, 20, defaultConfig.top_k);
    }
    if (updated.similarity_threshold !== undefined) {
      updated.similarity_threshold = clampFloat(updated.similarity_threshold, 0, 0.99, defaultConfig.similarity_threshold);
    }

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf-8');

    // Apply process.env override if directory set
    if (updated.ollama_models_dir) {
      process.env.OLLAMA_MODELS = updated.ollama_models_dir;
    }
    return updated;
  } catch (e) {
    console.error('Error saving config file:', e);
    throw e;
  }
}

// Initial setup of environment variable on module load
const initialConfig = getConfig();
if (initialConfig.ollama_models_dir) {
  process.env.OLLAMA_MODELS = initialConfig.ollama_models_dir;
}

module.exports = {
  getConfig,
  saveConfig,
  clampInt,
  clampFloat,
  CONFIG_FILE
};
