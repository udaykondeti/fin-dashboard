// Shared provider router. Used by the chat agent today; future Slack
// bidirectional handler will import the same routeForMessage() so behaviour
// is identical between web and Slack surfaces.
//
// Routing rules (local-first):
//   - explicit user choice (forceProvider / pinnedModel) always wins
//   - if a local model (Ollama) is configured → use it for everything;
//     it's free and private, so it's the default primary
//   - cloud fallback when no local: app/data questions → Anthropic,
//     general questions → Groq
//   - if only one provider is configured, use it regardless

const ANTHROPIC_DEFAULT = 'claude-haiku-4-5';
const GROQ_DEFAULT      = 'llama-3.3-70b-versatile';  // kept for fallback chain; not used when Ollama is primary
// Ollama: OpenAI-compatible API. OLLAMA_BASE_URL e.g. http://host.docker.internal:11434/v1
const LOCAL_DEFAULT     = process.env.OLLAMA_MODEL || 'mistral';

function hasAnthropic() { return !!process.env.ANTHROPIC_API_KEY; }
function hasGroq()      { return !!process.env.GROQ_API_KEY; }
function hasLocal()     { return !!process.env.OLLAMA_BASE_URL; }

// Heuristic — lowercase regex over the user message. Cheap, deterministic,
// no extra LLM call. Two-stage classification with a Groq-first bias:
//
//   1. STRONG_APP_PATTERNS   → "this is definitely about the user's data"
//      (possessives, mutation verbs, "show me my X", time-scoped queries)
//      Match → Anthropic. These need the read/propose tools to answer
//      correctly; sending them to Groq risks Llama hallucinating fake SQL.
//
//   2. Everything else        → Groq.
//
//   Including bare app-entity mentions ("net worth", "PPF", "ELSS") with
//   no possessive context — those are usually educational. The system
//   prompt + the model itself decide whether to call a tool; if tools
//   aren't needed, Groq is much cheaper.
//
//   Users can override by picking a specific Claude or Llama model from
//   the chat header dropdown — the pinned model wins regardless of
//   message content.

// Stage 1: clearly-personal data phrasing.
const STRONG_APP_PATTERNS = [
  /\bmy\b/, /\bi\s+(have|own|hold|bought|sold|paid|owe|invested)\b/,
  /\bshow\s+(me|us)\b/, /\blist\s+(my|all|the)\b/,
  /\b(fetch|get|display)\s+(me|my|all)\b/,
  // Mutation verbs followed by a domain noun
  // Allow up to 2 modifier words between verb and domain noun ("add a new payment", "create my next sip")
  /\b(add|record|log|enter|create|register|insert|update|edit|change|delete|remove)(\s+\w+){0,3}\s+(stock|mutual|fund|fd|rd|loan|payment|income|earning|tax|insurance|nps|ppf|property|hand|us|sip|emi|salary|deposit|premium)/,
  /\bmark\s+(as|paid|received)\b/, /\b(import|upload|attach)\s+/,
  /\b(this|last|next)\s+(month|quarter|year|fy)\b/, /\bytd\b/, /\bfy\s*20\d{2}\b/
];

// Stage 2: educational / explanatory phrasing.
const GENERAL_INTENT_PATTERNS = [
  /\bwhat\s+(is|are|does|do)\b/, /\bwhat['']?s\s+(the\s+)?(difference|meaning|definition)/,
  /\bexplain\b/, /\bdefine\b/, /\bdescribe\b/,
  /\bhow\s+(does|do|can|to)\b/,
  /\btell\s+me\s+about\b/, /\bgive\s+me\s+(an?\s+)?(overview|summary|primer)\b/,
  /\bdifference\s+between\b/,
  /\bwhy\s+(does|is|are|do)\b/,
  /\bwhen\s+is\s+(the\s+)?\w+\s+(deadline|due\s+date)\b/,
  /\bcompare\s+\w+\s+(and|vs)\b/
];

// Stage 3: app vocabulary without strong personal context.
const APP_ENTITY_PATTERNS = [
  /\bnet[-\s]?worth\b/, /\bportfolio\b/, /\bholdings?\b/,
  /\btotal\s+(assets?|liabilit(?:y|ies)|investments?)\b/,
  /\bvault\b/, /\bca\s+access\b/, /\bform\s*16\b/,
  /\badvance\s+tax\s+(payments?|installments?|deadlines?)\b/,
  /\b(rental|rent)\s+(income|agreement)\b/,
  /\bscheduled?\s+payments?\b/, /\bhand\s+loans?\b/,
  /\bsection\s+24\b/, /\bsec\s+24\b/
];

function looksAppRelated(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  const t = text.toLowerCase();
  // Only escalate to Anthropic on STRONG personal-data signals. Bare
  // app-entity mentions ("net worth", "ELSS", "section 80C") fall through
  // to Groq — the model can still call a tool if it actually needs to.
  for (const re of STRONG_APP_PATTERNS)     if (re.test(t)) return true;
  return false;
}

// Pick provider + model for a single user message.
//
// forceProvider: 'local' | 'anthropic' | 'groq' | null — explicit override
// pinnedModel:   string | null                          — explicit model override
// returns:       { provider, model, reason }
function routeForMessage({ content, forceProvider = null, pinnedModel = null } = {}) {
  // Pinned model wins outright — it implies the user picked the provider
  // through the dropdown.
  if (pinnedModel && typeof pinnedModel === 'string' && pinnedModel !== 'auto') {
    if (pinnedModel.startsWith('claude-')) {
      if (!hasAnthropic()) return fallbackChain('user pinned Anthropic but no key set');
      return { provider: 'anthropic', model: pinnedModel, reason: 'pinned' };
    }
    if (pinnedModel.startsWith('llama-') || pinnedModel.includes('mixtral')) {
      if (!hasGroq()) return fallbackChain('user pinned Groq but no key set');
      return { provider: 'groq', model: pinnedModel, reason: 'pinned' };
    }
    // Anything else (e.g. "llama3.1:8b", "qwen2.5:14b") → treat as a local
    // Ollama model tag.
    if (hasLocal()) return { provider: 'local', model: pinnedModel, reason: 'pinned' };
  }

  if (forceProvider === 'local') {
    if (!hasLocal()) return fallbackChain('forced local but OLLAMA_BASE_URL not set');
    return { provider: 'local', model: LOCAL_DEFAULT, reason: 'forced' };
  }
  if (forceProvider === 'anthropic') {
    if (!hasAnthropic()) return fallbackChain('forced Anthropic but no key set');
    return { provider: 'anthropic', model: ANTHROPIC_DEFAULT, reason: 'forced' };
  }
  if (forceProvider === 'groq') {
    if (!hasGroq()) return fallbackChain('forced Groq but no key set');
    return { provider: 'groq', model: GROQ_DEFAULT, reason: 'forced' };
  }

  // Auto routing — local model is primary when configured (free + private).
  if (hasLocal()) {
    return { provider: 'local', model: LOCAL_DEFAULT, reason: 'auto:local-primary' };
  }
  // Cloud fallback: app/data questions → Anthropic, general → Groq.
  const appRelated = looksAppRelated(content);
  if (appRelated) {
    if (hasAnthropic()) return { provider: 'anthropic', model: ANTHROPIC_DEFAULT, reason: 'auto:app-related' };
    if (hasGroq())      return { provider: 'groq',      model: GROQ_DEFAULT,      reason: 'auto:app-related-fallback' };
  } else {
    if (hasGroq())      return { provider: 'groq',      model: GROQ_DEFAULT,      reason: 'auto:general' };
    if (hasAnthropic()) return { provider: 'anthropic', model: ANTHROPIC_DEFAULT, reason: 'auto:general-fallback' };
  }
  throw new Error('No agent provider configured. Set OLLAMA_BASE_URL, ANTHROPIC_API_KEY, or GROQ_API_KEY.');
}

// Fallback when the requested provider isn't available: local → groq →
// anthropic, whichever is configured first.
function fallbackChain(reason) {
  if (hasLocal())     return { provider: 'local',     model: LOCAL_DEFAULT,     reason };
  if (hasGroq())      return { provider: 'groq',      model: GROQ_DEFAULT,      reason };
  if (hasAnthropic()) return { provider: 'anthropic', model: ANTHROPIC_DEFAULT, reason };
  throw new Error('No agent provider configured. Set OLLAMA_BASE_URL, ANTHROPIC_API_KEY, or GROQ_API_KEY.');
}

module.exports = {
  routeForMessage,
  looksAppRelated,
  hasAnthropic,
  hasGroq,
  hasLocal,
  ANTHROPIC_DEFAULT,
  GROQ_DEFAULT,
  LOCAL_DEFAULT
};
