// Thin OpenAI-compatible chat-completions client. Points at OLLAMA_BASE_URL
// (default http://localhost:11434/v1 for a local Ollama). Set OLLAMA_API_KEY
// to authenticate against a fronted endpoint like ai.kirakon.com — when unset,
// no Authorization header is sent, preserving the unauthenticated local-Ollama
// default. Kept minimal — services/agent.js handles auditing, retries, pricing.

const DEFAULT_BASE = 'http://localhost:11434/v1';

function isOllamaConfigured() {
  return !!process.env.OLLAMA_BASE_URL;
}

function isVisionConfigured() {
  return !!(process.env.OLLAMA_BASE_URL && process.env.OLLAMA_VISION_MODEL);
}

async function chatCompletion({ model, system, user, maxTokens = 400, timeoutMs = 30000 }) {
  const base = (process.env.OLLAMA_BASE_URL || DEFAULT_BASE).replace(/\/$/,  '');
  const apiKey = process.env.OLLAMA_API_KEY;
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2 }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status}: ${body.slice(0, 300)}`);
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

// Vision completion: sends an image (base64) + text prompt to a multimodal
// model such as llava:7b or qwen2.5-vl. Uses OLLAMA_VISION_MODEL env var;
// requires a higher default timeout because vision inference is slower.
async function chatCompletionWithImage({
  model,
  prompt,
  imageBase64,
  mimeType = 'image/jpeg',
  maxTokens = 1200,
  timeoutMs = 120000
}) {
  const base = (process.env.OLLAMA_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
  const apiKey = process.env.OLLAMA_API_KEY;

  const dataUrl = `data:${mimeType};base64,${imageBase64}`;
  const messages = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'text', text: prompt }
    ]
  }];

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.2 }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama vision HTTP ${res.status}: ${body.slice(0, 300)}`);
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

module.exports = { isOllamaConfigured, isVisionConfigured, chatCompletion, chatCompletionWithImage };
