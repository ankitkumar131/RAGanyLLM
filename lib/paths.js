// Central location for all user data files (knowledge base, config).
//
// v1.0 stored these next to process.cwd() which breaks global installs and lets
// two app instances corrupt each other. Default is now a user-owned data dir:
//   - $RAGANYLLM_HOME          if set (explicit override)
//   - ~/.raganyllm             otherwise (os.homedir())
// Falls back to the current working directory if the preferred dir is not
// writable/creatable (e.g. read-only home in some CI environments).

const fs = require('fs');
const os = require('os');
const path = require('path');

let cachedDir = null;

function resolveDataDir() {
  const preferred =
    (process.env.RAGANYLLM_HOME && process.env.RAGANYLLM_HOME.trim()) ||
    path.join(os.homedir(), '.raganyllm');
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch (e) {
    return process.cwd();
  }
}

function getDataDir() {
  if (!cachedDir) cachedDir = resolveDataDir();
  return cachedDir;
}

// Resolve a user-data filename. Absolute paths pass through untouched
// (allows tests / RAGANYLLM_HOME to point anywhere).
function getFilePath(name) {
  const p = path.resolve(getDataDir(), name);
  return p;
}

module.exports = { getDataDir, getFilePath };
