#!/usr/bin/env node
// raganyllm CLI — ROADMAP §5.3 (CLI parity for knowledge packs).
//
//   raganyllm                     interactive setup + launch the web app (default)
//   raganyllm serve               same as above
//   raganyllm export [out.raganyllm] [--password ...] [--no-embeddings]
//   raganyllm import <pack> [--mode merge|replace] [--password ...]
//
// A CLI-exported pack imports in the web UI and vice-versa: both sides use
// lib/pack.js, the single pack codec.

'use strict';

const fs = require('fs');
const path = require('path');

const chalk = require('chalk');
const { getDataDir, getFilePath } = require('../lib/paths');
const { getConfig } = require('../lib/config');
const VectorStore = require('../lib/vector-store');
const packLib = require('../lib/pack');
const fetch = require('node-fetch');

function fail(msg) {
  console.error(chalk.red.bold('✖ ') + chalk.red(msg));
  process.exit(1);
}

function ok(msg) {
  console.log(chalk.green.bold('✔ ') + chalk.green(msg));
}

function info(msg) {
  console.log(chalk.cyan(msg));
}

function defaultPackName() {
  return `raganyllm-kb-${new Date().toISOString().slice(0, 10)}.raganyllm`;
}

function parseFlags(args) {
  const flags = { password: '', withEmbeddings: true, mode: 'merge', positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--password' || a === '-p') {
      flags.password = args[++i] || '';
    } else if (a === '--mode') {
      flags.mode = args[++i] === 'replace' ? 'replace' : 'merge';
    } else if (a === '--no-embeddings') {
      flags.withEmbeddings = false;
    } else if (a === '--with-embeddings') {
      flags.withEmbeddings = true;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith('-')) {
      flags.positional.push(a);
    } else {
      fail(`Unknown option: ${a} (run 'raganyllm export --help' or 'raganyllm import --help')`);
    }
  }
  return flags;
}

function printHelp() {
  console.log(`
raganyllm — knowledge-pack CLI (ROADMAP §5.3)

  raganyllm                          Interactive setup + launch the web app
  raganyllm serve                    (same as above)

  raganyllm export [FILE] [options]
      Export the local knowledge base as a .raganyllm pack.
      FILE defaults to ${defaultPackName()} in the current directory.
      --password <pw>     Protect the pack with a password (AES-256-GCM)
      --no-embeddings     Compact text-only pack (re-embeds on import)

  raganyllm import FILE [options]
      Import a .raganyllm pack into the local knowledge base.
      --mode merge|replace   merge (default) skips duplicates; replace wipes first
      --password <pw>        password, when the pack is encrypted

Packs are interchangeable with the web app's ⬆ Export KB / ⬇ Import KB.
`);
}

async function runExport(args) {
  const flags = parseFlags(args);
  const outFile = flags.positional[0] || defaultPackName();

  const store = new VectorStore(getFilePath('raganyllm-kb.json'));
  const docs = store.documents || [];
  if (docs.length === 0) {
    fail('Your knowledge base is empty — add documents first, then export.');
  }

  const config = getConfig();
  const pack = {
    format: 'raganyllm-pack',
    version: 1,
    kind: 'knowledge',
    created_at: new Date().toISOString(),
    stats: store.getStats(),
    settings: { embedding_model: config.embedding_model || 'nomic-embed-text' },
    knowledge: {
      chunks: docs.map((d) => ({
        id: typeof d.id === 'string' && d.id ? d.id : require('crypto').randomUUID(),
        doc_title: d.doc_title || 'Untitled',
        content: d.content || '',
        source: d.source || '',
        chunk_index: Number.isInteger(d.chunk_index) ? d.chunk_index : 0
      })),
      embeddings: flags.withEmbeddings ? (store.embeddings || []) : undefined
    }
  };

  try {
    fs.writeFileSync(outFile, packLib.encodePack(pack, flags.password), 'utf-8');
  } catch (e) {
    fail(`Could not write ${outFile}: ${e.message}`);
  }
  const stats = store.getStats();
  ok(`Exported ${stats.total_documents} document(s) / ${stats.total_chunks} chunk(s)` +
     (flags.withEmbeddings ? ' with embeddings' : ' (compact, no embeddings)') +
     (flags.password ? ' (password-protected)' : ''));
  info(`Pack saved to ${path.resolve(outFile)}`);
}

async function runImport(args) {
  const flags = parseFlags(args);
  if (flags.positional.length === 0) fail('Usage: raganyllm import FILE [--mode merge|replace] [--password ...]');
  const packFile = flags.positional[0];
  if (!fs.existsSync(packFile)) fail(`Pack file not found: ${packFile}`);

  let decoded;
  try {
    decoded = packLib.decodePack(fs.readFileSync(packFile), flags.password);
  } catch (e) {
    fail(`Could not read pack: ${e.message}`);
  }
  if (!decoded.ok) {
    if (decoded.reason === 'needs-password') {
      fail('This pack is password-protected. Re-run with --password <pw>.');
    }
    fail(decoded.detail);
  }
  const pack = decoded.pack;
  info(`Reading pack: ${pack.stats ? `${pack.stats.total_documents} document(s), ${pack.stats.total_chunks} chunk(s)` : 'unknown size'}` +
       (pack.settings && pack.settings.embedding_model ? ` — embedding model '${pack.settings.embedding_model}'` : ''));

  const normalized = packLib.normalizePackChunks(pack.knowledge.chunks);
  if (!normalized.ok) fail(normalized.detail);
  const docs = normalized.docs;

  // Embeddings: prefer in-pack vectors; otherwise re-learn through Ollama.
  const embArr = pack.knowledge.embeddings;
  let embeddings = null;
  if (Array.isArray(embArr) && embArr.length === docs.length && embArr.every((e) => Array.isArray(e) && e.length > 0)) {
    embeddings = embArr;
  } else {
    const config = getConfig();
    const model = (pack.settings && pack.settings.embedding_model) || config.embedding_model || 'nomic-embed-text';
    const base = process.env.OLLAMA_URL || config.ollama_url || 'http://localhost:11434';
    info(`Pack has no embeddings — generating them with '${model}' via Ollama (${base})...`);
    embeddings = [];
    for (let i = 0; i < docs.length; i++) {
      try {
        const res = await fetch(`${base}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: docs[i].content })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        embeddings.push(data.embedding || []);
      } catch (e) {
        fail(`Embedding ${i + 1}/${docs.length} failed (${e.message}). Is Ollama running and '${model}' installed?`);
      }
      if ((i + 1) % 10 === 0 || i + 1 === docs.length) {
        info(`  embedded ${i + 1}/${docs.length}`);
      }
    }
  }

  const store = new VectorStore(getFilePath('raganyllm-kb.json'));
  if (flags.mode === 'replace' && store.documents.length > 0) {
    // Rollback point, matching the app's auto-backup before destructive ops.
    try {
      const backupsDir = path.join(getDataDir(), 'backups');
      fs.mkdirSync(backupsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.copyFileSync(store.storagePath, path.join(backupsDir, `raganyllm-kb-${stamp}.json`));
      info('A backup of the current knowledge base was saved before replacing.');
    } catch (e) { /* non-fatal */ }
    store.clear();
  }

  const { added, skipped } = store.addChunks(docs, embeddings);
  const stats = store.getStats();
  if (flags.mode === 'replace') {
    ok(`Replaced knowledge base: ${added} new chunk(s) imported. Now ${stats.total_documents} document(s) / ${stats.total_chunks} chunk(s).`);
  } else if (added > 0) {
    ok(`Merged: ${added} new chunk(s) imported` + (skipped > 0 ? ` (${skipped} duplicate(s) skipped)` : '') + `. Now ${stats.total_documents} document(s) / ${stats.total_chunks} chunk(s).`);
  } else {
    info(`Nothing new to import — all ${skipped} chunk(s) already exist in the knowledge base.`);
  }
}

async function runServe() {
  const open = require('open');
  const { runInteractiveSetup } = require('../lib/installer');
  const { createServer } = require('../lib/server');

  console.log(chalk.bold.magenta('\n================================================================'));
  console.log(chalk.bold.magenta(' 🚀 raganyllm - Universal Local RAG Studio CLI for Ollama'));
  console.log(chalk.bold.magenta('================================================================\n'));

  // 1. Run Interactive Prerequisite & Model Check
  await runInteractiveSetup('nomic-embed-text');

  // 2. Start Express Server (with automatic port fallback if port in use)
  const PREFERRED_PORT = process.env.PORT || 8000;
  const { port } = await createServer(PREFERRED_PORT);

  // 3. Open Browser Automatically
  const targetUrl = `http://localhost:${port}`;
  console.log(chalk.green.bold(`\n✨ Opening ${targetUrl} in your default browser...\n`));

  try {
    await open(targetUrl);
  } catch (e) {
    console.log(chalk.yellow(`Could not auto-open browser. Please manually open: ${targetUrl}`));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sub = args[0];
  if (sub === 'export' || sub === 'import') {
    return sub === 'export' ? runExport(args.slice(1)) : runImport(args.slice(1));
  }
  if (sub === 'serve' || sub === '--help' || sub === '-h' || sub === undefined) {
    if (sub === '--help' || sub === '-h') { printHelp(); return; }
    return runServe();
  }
  fail(`Unknown command: ${sub} (try 'raganyllm --help')`);
}

main().catch((err) => {
  console.error(chalk.red('Fatal error:'), err);
  process.exit(1);
});
