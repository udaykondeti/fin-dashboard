// Shared provider router. Used by the chat agent today; future Slack
// bidirectional handler will import the same routeForMessage() so behaviour
// is identical between web and Slack surfaces.
//
// Routing rules:
//   - explicit user choice (forceProvider) always wins
//   - app/data-related questions → Anthropic (better tool use, primary)
//   - general / educational / off-topic questions → Groq (cheap + fast)
//   - if only one provider is configured, use it regardless

const ANTHROPIC_DEFAULT = 'claude-haiku-4-5';
const GROQ_DEFAULT      = 'llama-3.3-70b-versatile';

function hasAnthropic() { return !!process.env.ANTHROPIC_API_KEY; }
function hasGroq()      { return !!process.env.GROQ_API_KEY; }

// Heuristic — lowercase regex over the user message. Cheap, deterministic,
// no extra LLM call. Three-stage classification:
//
//   1. STRONG_APP_PATTERNS   → "this is definitely about the user's data"
//      (possessives, mutation verbs, "show me my X")
//      Match → Anthropic, regardless of anything else.
//
//   2. GENERAL_INTENT_PATTERNS → educational phrasing
//      ("what is", "explain", "difference between", "how does")
//      If we got here without a STRONG_APP hit, the user is asking for
//      knowledge, not their records → Groq.
//
//   3. APP_ENTITY_PATTERNS   → app vocabulary (stocks, mutual funds,
//      net worth, EMIs, etc.) without strong context. Treat as app-related
//      and route to Anthropic.
//
//   Otherwise → general → Groq.

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
  for (const re of STRONG_APP_PATTERNS)     if (re.test(t)) return true;
  for (const re of GENERAL_INTENT_PATTERNS) if (re.test(t)) return false;
  for (const re of APP_ENTITY_PATTERNS)     if (re.test(t)) return true;
  return false;
}

// Pick provider + model for a single user message.
//
// forceProvider: 'anthropic' | 'groq' | null  — explicit override (wins over heuristic)
// pinnedModel:  string | null                  — explicit model override (wins over both)
// returns:      { provider, model, reason }
function routeForMessage({ content, forceProvider = null, pinnedModel = null } = {}) {
  // Pinned model wins outright — it implies the user picked the provider
  // through the dropdown.
  if (pinnedModel && typeof pinnedModel === 'string' && pinnedModel !== 'auto') {
    if (pinnedModel.startsWith('claude-')) {
      if (!hasAnthropic()) return fallbackToGroq('user pinned Anthropic but no key set');
      return { provider: 'anthropic', model: pinnedModel, reason: 'pinned' };
    }
    if (pinnedModel.startsWith('llama-') || pinnedModel.includes('mixtral')) {
      if (!hasGroq()) return fallbackToAnthropic('user pinned Groq but no key set');
      return { provider: 'groq', model: pinnedModel, reason: 'pinned' };
    }
  }

  if (forceProvider === 'anthropic') {
    if (!hasAnthropic()) return fallbackToGroq('forced Anthropic but no key set');
    return { provider: 'anthropic', model: ANTHROPIC_DEFAULT, reason: 'forced' };
  }
  if (forceProvider === 'groq') {
    if (!hasGroq()) return fallbackToAnthropic('forced Groq but no key set');
    return { provider: 'groq', model: GROQ_DEFAULT, reason: 'forced' };
  }

  // Auto routing
  const appRelated = looksAppRelated(content);
  if (appRelated) {
    if (hasAnthropic()) return { provider: 'anthropic', model: ANTHROPIC_DEFAULT, reason: 'auto:app-related' };
    if (hasGroq())      return { provider: 'groq',      model: GROQ_DEFAULT,      reason: 'auto:app-related-fallback' };
  } else {
    if (hasGroq())      return { provider: 'groq',      model: GROQ_DEFAULT,      reason: 'auto:general' };
    if (hasAnthropic()) return { provider: 'anthropic', model: ANTHROPIC_DEFAULT, reason: 'auto:general-fallback' };
  }
  throw new Error('No agent provider configured. Set ANTHROPIC_API_KEY or GROQ_API_KEY.');
}

function fallbackToGroq(reason) {
  if (!hasGroq()) throw new Error('No agent provider configured. Set ANTHROPIC_API_KEY or GROQ_API_KEY.');
  return { provider: 'groq', model: GROQ_DEFAULT, reason };
}
function fallbackToAnthropic(reason) {
  if (!hasAnthropic()) throw new Error('No agent provider configured. Set ANTHROPIC_API_KEY or GROQ_API_KEY.');
  return { provider: 'anthropic', model: ANTHROPIC_DEFAULT, reason };
}

module.exports = {
  routeForMessage,
  looksAppRelated,
  hasAnthropic,
  hasGroq,
  ANTHROPIC_DEFAULT,
  GROQ_DEFAULT
};
