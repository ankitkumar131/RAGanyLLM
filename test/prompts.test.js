'use strict';
// §2.3 per-model-family prompt templates + §1.3 Simple-mode detail levels.
const { test } = require('node:test');
const assert = require('node:assert');
const { modelFamily, buildRagSystemPrompt, honestyFallback, DETAILS } = require('../lib/prompts');

test('model family detection covers common names and namespaces', () => {
  assert.strictEqual(modelFamily('llama3.2:latest'), 'llama');
  assert.strictEqual(modelFamily('qwen2.5:7b'), 'qwen');
  assert.strictEqual(modelFamily('gemma2:9b'), 'gemma');
  assert.strictEqual(modelFamily('mistral:latest'), 'mistral');
  assert.strictEqual(modelFamily('mixtral:8x7b'), 'mistral');
  assert.strictEqual(modelFamily('deepseek-r1:7b'), 'deepseek');
  assert.strictEqual(modelFamily('phi3:mini'), 'phi');
  assert.strictEqual(modelFamily('gpt-oss:20b'), 'gpt');
  assert.strictEqual(modelFamily('lmstudio-community/qwen2.5-coder-7b-instruct'), 'qwen');
  assert.strictEqual(modelFamily('totally-unknown-model'), 'default');
  assert.strictEqual(modelFamily(''), 'default');
});

test('family templates differ and unknown families fall back to the neutral one', () => {
  const ctx = '--- [SOURCE 1] ---\nhello';
  const llama = buildRagSystemPrompt({ context: ctx, family: 'llama3.2:latest', detail: 'balanced' });
  const qwen = buildRagSystemPrompt({ context: ctx, family: 'qwen2.5:7b', detail: 'balanced' });
  const generic = buildRagSystemPrompt({ context: ctx, family: 'weird-model', detail: 'balanced' });
  assert.ok(llama.includes('Llama-family models'), 'family note is present');
  assert.ok(qwen.includes('Qwen-family models'));
  assert.ok(generic.includes('Answer clearly and accurately'), 'neutral default');
  assert.ok(generic.includes(ctx), 'context is embedded');
});

test('detail levels change the instructions; unknown detail falls back to balanced', () => {
  const ctx = 'ctx';
  const concise = buildRagSystemPrompt({ context: ctx, family: 'llama3.2', detail: 'concise' });
  const detailed = buildRagSystemPrompt({ context: ctx, family: 'llama3.2', detail: 'detailed' });
  const fallback = buildRagSystemPrompt({ context: ctx, family: 'llama3.2', detail: 'shouty' });
  assert.ok(concise.includes('Keep the answer short'));
  assert.ok(detailed.includes('Be thorough'));
  assert.ok(fallback.includes('Be concise, accurate, and structured'), 'balanced default');
  assert.ok(DETAILS.has('concise') && DETAILS.has('balanced') && DETAILS.has('detailed') && !DETAILS.has('shouty'));
});

test('honesty fallback adapts to the family and stays honest for unknown', () => {
  assert.ok(honestyFallback('qwen2.5').includes('could not find this in their knowledge base'));
  assert.ok(honestyFallback('qwen2.5').includes('Qwen phrasing'));
  assert.ok(!honestyFallback('nonsense-model').includes('phrasing'), 'default is not family-prefixed');
});
