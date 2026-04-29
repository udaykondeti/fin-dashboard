const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');

// Allowed task types. Extend this list as new agent-driven features land.
const TASK_TYPES = ['categorise_file', 'validate_name', 'parse_message', 'suggest_tax_action'];

// USD per 1M tokens. Update when Anthropic pricing changes.
// Source of truth lives here so cost math in admin views stays in sync.
const PRICE_TABLE = {
  'claude-haiku-4-5':       { input: 1.0, output: 5.0 },
  'claude-sonnet-4-5':      { input: 3.0, output: 15.0 },
  'claude-opus-4-5':        { input: 15.0, output: 75.0 }
};

const DEFAULT_MODEL = 'claude-haiku-4-5';

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
async function runTask({ userId, taskType, systemPrompt, userInput, maxTokens } = {}) {
  if (!TASK_TYPES.includes(taskType)) {
    throw new Error(`Invalid taskType "${taskType}". Allowed: ${TASK_TYPES.join(', ')}`);
  }
  if (typeof systemPrompt !== 'string' || typeof userInput !== 'string') {
    throw new Error('runTask requires string systemPrompt and userInput');
  }

  const client = getClient();
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const inputHash = sha256(systemPrompt + '\n' + userInput);
  const inputPreview = preview(userInput);

  const startedAt = Date.now();
  let response;
  try {
    response = await client.messages.create({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userInput }],
      max_tokens: maxTokens || 200
    });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    try {
      insertCallStmt.run(
        userId || null,
        taskType,
        model,
        inputHash,
        inputPreview,
        null,
        0,
        0,
        0,
        latencyMs,
        err.message || String(err)
      );
    } catch (auditErr) {
      console.error('[agent] Failed to audit error call:', auditErr.message);
    }
    throw err;
  }

  const latencyMs = Date.now() - startedAt;
  const outputText = (response.content && response.content[0] && response.content[0].text) || '';
  const tokensIn = (response.usage && response.usage.input_tokens) || 0;
  const tokensOut = (response.usage && response.usage.output_tokens) || 0;
  const costUsd = estimateCost({ tokensIn, tokensOut, model });

  const result = insertCallStmt.run(
    userId || null,
    taskType,
    model,
    inputHash,
    inputPreview,
    preview(outputText),
    tokensIn,
    tokensOut,
    costUsd,
    latencyMs,
    null
  );

  return {
    output: outputText,
    usage: response.usage,
    callId: result.lastInsertRowid
  };
}

module.exports = {
  isAgentConfigured,
  getClient,
  runTask,
  estimateCost,
  TASK_TYPES,
  PRICE_TABLE
};
