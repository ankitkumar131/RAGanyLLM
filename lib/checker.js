const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');

function scanModelsDirectory(customDir) {
  if (!customDir || !fs.existsSync(customDir)) return [];
  const models = new Set();
  
  const manifestsDir = path.join(customDir, 'manifests');
  if (fs.existsSync(manifestsDir)) {
    function walk(currentDir, relativeParts = []) {
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            walk(path.join(currentDir, entry.name), [...relativeParts, entry.name]);
          } else if (entry.isFile()) {
            if (relativeParts.length >= 1) {
              const tag = entry.name;
              const modelName = relativeParts[relativeParts.length - 1];
              const fullModelName = tag === 'latest' ? `${modelName}:latest` : `${modelName}:${tag}`;
              models.add(fullModelName);
              models.add(modelName); // Also add base name
            }
          }
        }
      } catch (e) {
        // ignore read errors
      }
    }
    walk(manifestsDir);
  }
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
