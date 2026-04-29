const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');
const groqClient = require('./groqClient');

// Allowed task types. Extend this list as new agent-driven features land.
const TASK_TYPES = [
  'categorise_file',
  'validate_name',
  'parse_message',
  'suggest_tax_action',
  // Run by scripts/groq-watcher.js every 5 minutes — summarises recent DB
  // changes into plain-English activity_log entries.
  'summarise_db_changes'
];

// USD per 1M tokens. Source of truth so admin cost views stay in sync. Models
// are keyed by provider:model_id where provider matches PROVIDERS below.
// Update when pricing changes.
const PRICE_TABLE = {
  // Anthropic
  'claude-haiku-4-5':           { input: 1.0,  output: 5.0  },
  'claude-sonnet-4-5':          { input: 3.0,  output: 15.0 },
  'claude-opus-4-5':            { input: 15.0, output: 75.0 },
  // Groq (OpenAI-compatible) — prices as of 2026-04
  'llama-3.1-8b-instant':       { input: 0.05, output: 0.08 },
  'llama-3.3-70b-versatile':    { input: 0.59, output: 0.79 }
};

const PROVIDERS = ['anthropic', 'groq'];

const DEFAULT_MODEL = 'claude-haiku-4-5';
const GROQ_DEFAULT_MODEL = 'llama-3.1-8b-instant';

/**
 * True iff ANTHROPIC_API_KEY is present in the environment.
 * Mirrors `isS3Configured` in services/s3.js so callers can degrade gracefully.
 */
function isAgentConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Returns a configured Anthropic SDK client.
 * Throws a descriptive error if the API key is not set — mirrors getS3Client().
 */
function getClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Anthropic agent is not configured. Please set ANTHROPIC_API_KEY in your environment.'
    );
  }
  return new Anthropic({ apiKey });
}

/**
 * Returns the cost in USD for a given token count and model.
 * Unknown models fall back to Haiku 4.5 prices so we never crash on a new model.
 */
function estimateCost({ tokensIn = 0, tokensOut = 0, model = DEFAULT_MODEL } = {}) {
  const prices = PRICE_TABLE[model] || PRICE_TABLE[DEFAULT_MODEL];
  const inCost = (tokensIn / 1_000_000) * prices.input;
  const outCost = (tokensOut / 1_000_000) * prices.output;
  return inCost + outCost;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function preview(text, n = 200) {
  if (text == null) return null;
  const s = String(text);
  return s.length > n ? s.slice(0, n) : s;
}

const insertCallStmt = db.prepare(`
  INSERT INTO agent_calls (
    user_id, task_type, model,
    input_hash, input_preview, output_preview,
    tokens_in, tokens_out, cost_usd, latency_ms, error
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

/**
 * Single entry point for all agent calls. Validates task_type, dispatches to
 * the Anthropic API, audits the call to `agent_calls`, and returns the result.
 *
 * Privacy: full prompts are NEVER persisted. Only a SHA-256 of (system+user)
 * input plus a 200-char preview are stored.
 */
async function runTask({ userId, taskType, systemPrompt, userInput, maxTokens, provider, model } = {}) {
  if (!TASK_TYPES.includes(taskType)) {
    throw new Error(`Invalid taskType "${taskType}". Allowed: ${TASK_TYPES.join(', ')}`);
  }
  if (typeof systemPrompt !== 'string' || typeof userInput !== 'string') {
    throw new Error('runTask requires string systemPrompt and userInput');
  }

  const useProvider = provider || 'anthropic';
  if (!PROVIDERS.includes(useProvider)) {
    throw new Error(`Invalid provider "${useProvider}". Allowed: ${PROVIDERS.join(', ')}`);
  }

  const useModel =
    model ||
    (useProvider === 'groq'
      ? (process.env.GROQ_MODEL || GROQ_DEFAULT_MODEL)
      : (process.env.ANTHROPIC_MODEL || DEFAULT_MODEL));

  const inputHash = sha256(systemPrompt + '\n' + userInput);
  const inputPreview = preview(userInput);
  const startedAt = Date.now();

  let outputText = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let usage = null;

  try {
    if (useProvider === 'groq') {
      const r = await groqClient.chatCompletion({
        model: useModel,
        system: systemPrompt,
        user: userInput,
        maxTokens: maxTokens || 400
      });
      outputText = r.output;
      tokensIn = r.tokensIn;
      tokensOut = r.tokensOut;
      usage = { input_tokens: tokensIn, output_tokens: tokensOut };
    } else {
      const client = getClient();
      const response = await client.messages.create({
        model: useModel,
        system: systemPrompt,
        messages: [{ role: 'user', content: userInput }],
        max_tokens: maxTokens || 200
      });
      outputText = (response.content && response.content[0] && response.content[0].text) || '';
      tokensIn = (response.usage && response.usage.input_tokens) || 0;
      tokensOut = (response.usage && response.usage.output_tokens) || 0;
      usage = response.usage;
    }
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    try {
      insertCallStmt.run(
        userId || null, taskType, useModel,
        inputHash, inputPreview, null,
        0, 0, 0, latencyMs,
        err.message || String(err)
      );
    } catch (auditErr) {
      console.error('[agent] Failed to audit error call:', auditErr.message);
    }
    throw err;
  }

  const latencyMs = Date.now() - startedAt;
  const costUsd = estimateCost({ tokensIn, tokensOut, model: useModel });

  const result = insertCallStmt.run(
    userId || null, taskType, useModel,
    inputHash, inputPreview, preview(outputText),
    tokensIn, tokensOut, costUsd, latencyMs,
    null
  );

  return { output: outputText, usage, callId: result.lastInsertRowid, provider: useProvider, model: useModel };
}

module.exports = {
  isAgentConfigured,
  isGroqConfigured: groqClient.isGroqConfigured,
  getClient,
  runTask,
  estimateCost,
  TASK_TYPES,
  PRICE_TABLE,
  PROVIDERS
};
