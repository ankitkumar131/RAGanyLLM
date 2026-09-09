'use strict';
// Per-model-family prompt templates (ROADMAP §2.3). Different Ollama model
// families — Llama, Qwen, Gemma, Mistral, DeepSeek, Phi, … — follow slightly
// different instruction-following conventions, so the RAG system prompt is
// assembled from a family-aware template instead of one hard-coded block.
//
// Ollama still owns the low-level chat-template wrapping (via each model's
// Modelfile); what we tune here is the *instruction layer*: how the model is
// told to use the retrieved context, cite it, and handle honesty/detail.
// Unknown/new families fall back to a neutral default template.

// Lowercased model-name fragment -> family id. Checked in order; the first
// match wins, and namespace prefixes (e.g. `qwen2.5-coder`) are fine.
const FAMILY_RULES = [
  { id: 'llama', re: /(^|[/:_-])llama/i },
  { id: 'qwen', re: /(^|[/:_-])qwen/i },
  { id: 'gemma', re: /(^|[/:_-])gemma/i },
  { id: 'mistral', re: /(^|[/:_-])mistral|(^|[/:_-])mixtral|(^|[/:_-])codestral/i },
  { id: 'deepseek', re: /(^|[/:_-])deepseek/i },
  { id: 'phi', re: /(^|[/:_-])phi/i },
  { id: 'gpt', re: /(^|[/:_-])(gpt|gpt-oss)/i }
];

const FAMILY_LABELS = {
  llama: 'Llama', qwen: 'Qwen', gemma: 'Gemma', mistral: 'Mistral',
  deepseek: 'DeepSeek', phi: 'Phi', gpt: 'GPT', default: 'Generic'
};

function modelFamily(modelName) {
  const name = String(modelName || '').toLowerCase().trim();
  for (const rule of FAMILY_RULES) {
    if (rule.re.test(name)) return rule.id;
  }
  return 'default';
}

// Detail modes the UI exposes ("How much detail?", ROADMAP §1.3 Simple mode).
const DETAILS = new Set(['concise', 'balanced', 'detailed']);

// Core RAG instruction body shared by every family, with per-family phrasing
// (one honest, versioned reason per family so the templates stay real and
// easy to tweak) and the requested detail level applied on top.
const CORE = {
  role: 'You are an expert AI assistant. Below is verified documentation retrieved from the user\'s Knowledge Base:\n\n{{CONTEXT}}\n\nINSTRUCTIONS:',
  familyNotes: {
    llama: 'Llama-family models: answer directly and conversationally, using Markdown headings sparingly.',
    qwen: 'Qwen-family models: answer in clear, well-structured Markdown; prefer short paragraphs.',
    gemma: 'Gemma-family models: be helpful and direct; start with the answer, then support it.',
    mistral: 'Mistral-family models: be precise and technical; prefer bullets over long prose.',
    deepseek: 'DeepSeek-family models: answer like a careful reasoning assistant; show your chain only when asked.',
    phi: 'Phi-family models: be educational — state the answer, then briefly explain why.',
    gpt: 'GPT-family models: answer conversationally with clean Markdown structure.',
    default: 'Answer clearly and accurately using the provided context.'
  },
  citing: '1. Answer the user\'s question directly using the provided context snippets.',
  detail: {
    concise: '2. Keep the answer short and scannable: a few sentences or compact bullets. Do not pad.',
    balanced: '2. Be concise, accurate, and structured.',
    detailed: '2. Be thorough: cover every relevant point in the context, explain reasoning, and include concrete examples where useful.'
  },
  code: '3. Include code examples where appropriate.'
};

function buildRagSystemPrompt({ context, family, detail }) {
  const famId = modelFamily(family);
  const detailMode = DETAILS.has(detail) ? detail : 'balanced';
  const notes = CORE.familyNotes[famId] || CORE.familyNotes.default;
  const parts = [
    CORE.role.replace('{{CONTEXT}}', context),
    notes,
    CORE.citing,
    CORE.detail[detailMode],
    CORE.code
  ];
  return parts.join('\n');
}

// Small builder used by the same prompt for the no-context honesty fallback so
// the phrasing still matches the active family. Optional.
function honestyFallback(family) {
  const fam = modelFamily(family);
  const base = 'You are an expert AI assistant. You searched the user\'s knowledge base but found NO relevant context (best similarity was below the configured threshold). Reply honestly: tell the user you could not find this in their knowledge base, and invite them to add the information. Do NOT invent facts, URLs, code, or documentation details.';
  return fam === 'default' ? base : `${base}\n(${FAMILY_LABELS[fam]} phrasing: be direct and do not over-apologize.)`;
}

module.exports = { modelFamily, familyLabel: (f) => FAMILY_LABELS[f] || FAMILY_LABELS.default, DETAILS, buildRagSystemPrompt, honestyFallback };
