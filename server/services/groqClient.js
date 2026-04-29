// Thin Groq client. Uses the OpenAI-compatible chat-completions endpoint
// at https://api.groq.com/openai/v1 with native fetch (Node ≥18). Kept
// minimal — services/agent.js handles auditing, retries, and pricing.

const GROQ_BASE = 'https://api.groq.com/openai/v1';

function isGroqConfigured() {
  return !!process.env.GROQ_API_KEY;
}

async function chatCompletion({ model, system, user, maxTokens = 400, timeoutMs = 15000 }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('Groq is not configured. Set GROQ_API_KEY in the environment.');
  }
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2 }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  const usage = data?.usage || {};
  return {
    output: text,
    tokensIn: usage.prompt_tokens || 0,
    tokensOut: usage.completion_tokens || 0,
    raw: data
  };
}

module.exports = { isGroqConfigured, chatCompletion };
