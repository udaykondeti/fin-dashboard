const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');
const ollamaClient = require('./ollamaClient');

// Allowed task types. Extend this list as new agent-driven features land.
const TASK_TYPES = [
  'categorise_file',
  'validate_name',
  'parse_message',
  'suggest_tax_action',
  // Run by scripts/ollama-watcher.js every 5 minutes — summarises recent DB
  // changes into plain-English activity_log entries.
  'summarise_db_changes',
  // Floating "Ask AI" panel (POST /api/ai/chat in server/index.js).
  'quick_chat'
];

// USD per 1M tokens. Source of truth so admin cost views stay in sync. Models
// are keyed by model_id where provider matches PROVIDERS below.
// Ollama models run locally — cost is $0.
const PRICE_TABLE = {
  // Anthropic
  'claude-haiku-4-5':           { input: 1.0,  output: 5.0  },
  'claude-sonnet-4-5':          { input: 3.0,  output: 15.0 },
  'claude-opus-4-5':            { input: 5.0,  output: 25.0 },
  // Groq
  'llama-3.3-70b-versatile':    { input: 0.59, output: 0.79 },
  // Ollama (local) — no cost
  'mistral':                    { input: 0,    output: 0    },
  'qwen2.5':                    { input: 0,    output: 0    }
};

/**
 * Price row for a model id. Handles Ollama-style ':tag' suffixes
 * ('qwen2.5:latest' → 'qwen2.5'). Tagged models that aren't in the table are
 * local Ollama models — priced at $0 rather than the Haiku fallback, so the
 * admin cost dashboards don't show phantom spend for free local calls.
 * Unknown untagged (cloud) models still fall back to Haiku prices so we
 * never under-report a new paid model as free.
 */
function priceFor(model) {
  if (PRICE_TABLE[model]) return PRICE_TABLE[model];
  const base = String(model || '').split(':')[0];
  if (PRICE_TABLE[base]) return PRICE_TABLE[base];
  if (String(model || '').includes(':')) return { input: 0, output: 0 };
  return PRICE_TABLE[ANTHROPIC_DEFAULT_MODEL];
}

const PROVIDERS = ['anthropic', 'ollama'];

const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-4-5';
const OLLAMA_DEFAULT_MODEL = 'qwen2.5:latest';

/**
 * True iff any LLM provider is configured (local Ollama or Anthropic).
 * Local Ollama is primary; Anthropic is the cloud fallback only.
 */
function isAgentConfigured() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.OLLAMA_BASE_URL);
}

function isAnthropicConfigured() {
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
 * Local (tagged) models cost $0; unknown cloud models fall back to Haiku 4.5
 * prices so we never crash on a new model. See priceFor().
 */
function estimateCost({ tokensIn = 0, tokensOut = 0, model = ANTHROPIC_DEFAULT_MODEL } = {}) {
  const prices = priceFor(model);
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
 * Single entry point for all agent calls. Defaults to local Ollama; falls back
 * to Anthropic automatically on any error (including credit exhaustion). Pass
 * provider:'anthropic' to explicitly start with Anthropic — it will still fall
 * back to Ollama if Anthropic fails and OLLAMA_BASE_URL is set.
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

  // Local Ollama is primary by default. Only switch to Anthropic when explicitly
  // requested — and even then fall back to Ollama if Anthropic fails.
  const primaryProvider = (provider && PROVIDERS.includes(provider)) ? provider : 'ollama';

  // Build provider chain: primary first, then the other as fallback if configured.
  const chain = [primaryProvider];
  if (primaryProvider === 'ollama' && isAnthropicConfigured()) chain.push('anthropic');
  if (primaryProvider === 'anthropic' && ollamaClient.isOllamaConfigured()) chain.push('ollama');

  const inputHash = sha256(systemPrompt + '\n' + userInput);
  const inputPreview = preview(userInput);
  const startedAt = Date.now();

  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i];
    if (p === 'anthropic' && !isAnthropicConfigured()) continue;
    if (p === 'ollama' && !ollamaClient.isOllamaConfigured()) continue;

    const useModel = model ||
      (p === 'ollama'
        ? (process.env.OLLAMA_MODEL || OLLAMA_DEFAULT_MODEL)
        : (process.env.ANTHROPIC_MODEL || ANTHROPIC_DEFAULT_MODEL));

    if (i > 0) {
      console.warn(`[agent] ${chain[i - 1]} failed (${lastErr?.message}) — falling back to ${p}`);
    }

    try {
      let outputText = '';
      let tokensIn = 0;
      let tokensOut = 0;
      let usage = null;

      if (p === 'ollama') {
        const r = await ollamaClient.chatCompletion({
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

      const latencyMs = Date.now() - startedAt;
      const costUsd = estimateCost({ tokensIn, tokensOut, model: useModel });
      const result = insertCallStmt.run(
        userId || null, taskType, useModel,
        inputHash, inputPreview, preview(outputText),
        tokensIn, tokensOut, costUsd, latencyMs,
        null
      );
      return { output: outputText, usage, callId: result.lastInsertRowid, provider: p, model: useModel };
    } catch (err) {
      lastErr = err;
    }
  }

  // All providers exhausted — audit the final error and throw.
  const latencyMs = Date.now() - startedAt;
  const auditModel = model || (primaryProvider === 'ollama' ? OLLAMA_DEFAULT_MODEL : ANTHROPIC_DEFAULT_MODEL);
  try {
    insertCallStmt.run(
      userId || null, taskType, auditModel,
      inputHash, inputPreview, null,
      0, 0, 0, latencyMs,
      lastErr?.message || String(lastErr)
    );
  } catch (auditErr) {
    console.error('[agent] Failed to audit error call:', auditErr.message);
  }
  throw lastErr || new Error('No LLM provider available (set OLLAMA_BASE_URL or ANTHROPIC_API_KEY)');
}

module.exports = {
  isAgentConfigured,
  isOllamaConfigured: ollamaClient.isOllamaConfigured,
  getClient,
  runTask,
  estimateCost,
  priceFor,
  TASK_TYPES,
  PRICE_TABLE,
  PROVIDERS
};
