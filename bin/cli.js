#!/usr/bin/env node

const chalk = require('chalk');
const open = require('open');
const { runInteractiveSetup } = require('../lib/installer');
const { createServer } = require('../lib/server');

async function main() {
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

main().catch(err => {
  console.error(chalk.red('Fatal error launching raganyllm:'), err);
  process.exit(1);
});
