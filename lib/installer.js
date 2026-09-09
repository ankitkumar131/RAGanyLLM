const inquirer = require('inquirer');
const chalk = require('chalk');
const fetch = require('node-fetch');
const { checkEmbeddingModel } = require('./checker');
const { getConfig } = require('./config');

async function runInteractiveSetup(defaultEmbModel = 'nomic-embed-text') {
  console.log(chalk.cyan.bold('\n🔍 Checking prerequisites for raganyllm...\n'));

  const config = getConfig();
  const ollamaUrl = process.env.OLLAMA_URL || config.ollama_url || 'http://localhost:11434';

  let check = await checkEmbeddingModel(defaultEmbModel);

  // 1. Check if Ollama is running
  if (!check.connected) {
    console.log(chalk.red.bold(`❌ Ollama service is not running on ${ollamaUrl}`));
    console.log(chalk.yellow('   Please ensure Ollama is installed and running (`ollama serve` or open Ollama app).\n'));

    const { retry } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'retry',
        message: 'Would you like to re-check connection to Ollama now?',
        default: true
      }
    ]);

    if (retry) {
      check = await checkEmbeddingModel(defaultEmbModel);
      if (!check.connected) {
        console.log(chalk.red('Ollama is still unreachable. Continuing in offline server mode...'));
      }
    }
  } else {
    console.log(chalk.green('✔ Ollama service detected and connected.'));
  }

  // 2. Check if embedding model is installed
  if (check.connected && !check.available) {
    console.log(chalk.yellow(`\n⚠️ Embedding model '${defaultEmbModel}' is not pulled in Ollama yet.`));
    
    const { pullModel } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'pullModel',
        message: `Would you like raganyllm to pull '${defaultEmbModel}' automatically via Ollama?`,
        default: true
      }
    ]);

    if (pullModel) {
      console.log(chalk.cyan(`\n📥 Pulling '${defaultEmbModel}' via Ollama API... This may take 1-2 minutes.\n`));
      try {
        const pullRes = await fetch(`${ollamaUrl}/api/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: defaultEmbModel, stream: false })
        });
        if (pullRes.ok) {
          console.log(chalk.green.bold(`✔ Successfully pulled embedding model '${defaultEmbModel}'!\n`));
        } else {
          console.log(chalk.red(`Failed to pull model: ${await pullRes.text()}`));
        }
      } catch (e) {
        console.log(chalk.red(`Error pulling model: ${e.message}`));
      }
    }
  } else if (check.connected) {
    console.log(chalk.green(`✔ Embedding model '${defaultEmbModel}' is ready.`));
  }

  return check;
}

module.exports = {
  runInteractiveSetup
};
