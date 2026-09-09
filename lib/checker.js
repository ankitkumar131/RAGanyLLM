const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');

function scanModelsDirectory(customDir) {
  if (!customDir || !fs.existsSync(customDir)) return [];
  const models = new Set();

  // Ollama manifest layout:
  //   <dir>/manifests/registry.ollama.ai/library/llama3/latest          -> llama3:latest
  //   <dir>/manifests/registry.ollama.ai/liquidai/lfm2.5-1.2b-instruct/latest
  //                                                                    -> liquidai/lfm2.5-1.2b-instruct:latest
  // The tag file sits in the model dir; a registry host dir may prefix it.
  const manifestsDir = path.join(customDir, 'manifests');
  if (!fs.existsSync(manifestsDir)) return [];

  function walk(currentDir, dirs = []) {
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (e) {
      return; // ignore read errors
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(currentDir, entry.name), [...dirs, entry.name]);
      } else if (entry.isFile() && dirs.length >= 2) {
        const tag = entry.name;
        // dirs = [..., model] (model is always the last directory).
        let parts = dirs;
        // Drop a leading registry host segment (e.g. registry.ollama.ai).
        if (parts[0].includes('.') || parts[0] === 'localhost') parts = parts.slice(1);

        const modelName = parts[parts.length - 1];
        const beforeModel = parts.slice(0, -1);
        const isLibrary = beforeModel[beforeModel.length - 1] === 'library';

        // library/llama3 -> llama3 ; {ns}/model -> {ns}/model
        const fullName = (!isLibrary && beforeModel.length >= 1)
          ? `${beforeModel[beforeModel.length - 1]}/${modelName}`
          : modelName;

        models.add(`${fullName}:${tag}`);
        models.add(fullName); // Also add base name
      }
    }
  }
  walk(manifestsDir);
  return Array.from(models);
}

async function checkOllamaConnection() {
  const config = getConfig();
  const ollamaUrl = process.env.OLLAMA_URL || config.ollama_url || 'http://localhost:11434';
  const customModelsDir = process.env.OLLAMA_MODELS || config.ollama_models_dir;
  
  let connected = false;
  let apiModels = [];

  try {
    const res = await fetch(`${ollamaUrl}/api/tags`, { timeout: 4000 });
    if (res.ok) {
      const data = await res.json();
      apiModels = (data.models || []).map(m => m.name);
      connected = true;
    }
  } catch (e) {
    // connection failed
  }

  // Also scan disk if custom directory provided
  const diskModels = scanModelsDirectory(customModelsDir);
  
  // Combine all unique models
  const allModelsSet = new Set([...apiModels, ...diskModels]);
  const models = Array.from(allModelsSet);

  return {
    connected,
    models,
    customDir: customModelsDir || '',
    customDirExists: customModelsDir ? fs.existsSync(customModelsDir) : false,
    diskModelCount: diskModels.length
  };
}

async function checkEmbeddingModel(modelName = 'nomic-embed-text') {
  const status = await checkOllamaConnection();
  if (!status.connected && status.models.length === 0) return { available: false, connected: false, models: [] };
  
  const hasModel = status.models.some(m => m.includes(modelName));
  return { available: hasModel, connected: status.connected, models: status.models };
}

module.exports = {
  checkOllamaConnection,
  checkEmbeddingModel,
  scanModelsDirectory
};
