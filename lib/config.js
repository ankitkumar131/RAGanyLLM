const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.resolve(process.cwd(), 'raganyllm-config.json');

const defaultConfig = {
  ollama_models_dir: '',
  ollama_url: 'http://localhost:11434',
  embedding_model: 'nomic-embed-text'
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

function saveConfig(newConfig) {
  try {
    const current = getConfig();
    const updated = { ...current, ...newConfig };
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
  CONFIG_FILE
};
