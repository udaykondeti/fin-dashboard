const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');
const tools = require('./chatTools');
const routeProvider = require('./routeProvider');

// ─────────────────────────── Live artifacts ───────────────────────────────
//
// Substantial generated content (markdown reports, HTML/SVG visualisations,
// code snippets) is wrapped by the model in <artifact ...>...</artifact> tags
// so the frontend can render it in a side panel and stream updates in real
// time. The parser below intercepts streamed text deltas, splits them into
// inline-text vs artifact-content, and emits SSE events the chat route
// proxies to the client.

const ARTIFACT_INSTRUCTIONS = [
  'Artifacts: when you produce substantial generated content (a multi-line code snippet, an HTML or SVG visualisation, a markdown report, a tabular summary the user will want to read or copy in full), wrap it in an artifact tag so it renders in a live side panel:',
  '  <artifact identifier="stable-id" type="markdown|html|svg|code" language="js|python|..." title="Short title">...content...</artifact>',
  '- type="markdown" for narrative reports/tables; type="html" for self-contained HTML; type="svg" for inline SVG; type="code" with a language attribute for code listings.',
  '- Pick a stable identifier (slug-style, e.g. "fy25-tax-summary") so reusing the same id updates the same artifact.',
  '- Keep short, conversational replies in the message body. Do not wrap one-liners in artifacts.',
  '- Never put a propose_* tool call inside an artifact. Artifacts are display-only.'
].join('\n');

function parseArtifactAttrs(openTag) {
  const out = {};
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(openTag)) !== null) out[m[1]] = m[2];
  return out;
}

// Streaming parser: feed text deltas, get back text/artifact_* events.
// Handles the split-tag case (a delta may end mid-tag like '<arti').
class ArtifactStreamParser {
  constructor(emit) {
    this.emit = emit;
    this.buf = '';
    this.mode = 'text';   // 'text' | 'artifact'
    this.current = null;  // { identifier, type, language, title, content }
    this.cleanText = '';  // text outside artifacts, accumulated for DB persistence
    this.artifacts = [];  // completed artifacts for the current turn
  }

  feed(delta) {
    this.buf += delta;
    while (true) {
      if (this.mode === 'text') {
        const i = this.buf.indexOf('<artifact');
        if (i === -1) {
          // Hold back any tail that could be a prefix of '<artifact' so we
          // don't emit '<arti' as text and then have to retract it.
          let hold = 0;
          for (let n = Math.min(9, this.buf.length); n > 0; n--) {
            if ('<artifact'.startsWith(this.buf.slice(this.buf.length - n))) { hold = n; break; }
          }
          const flush = this.buf.slice(0, this.buf.length - hold);
          if (flush) { this.cleanText += flush; this.emit('text', { delta: flush }); }
          this.buf = this.buf.slice(this.buf.length - hold);
          return;
        }
        if (i > 0) {
          const flush = this.buf.slice(0, i);
          this.cleanText += flush;
          this.emit('text', { delta: flush });
          this.buf = this.buf.slice(i);
        }
        // buf now starts with '<artifact'. Wait for the closing '>'.
        const gt = this.buf.indexOf('>');
        if (gt === -1) return;
        const attrs = parseArtifactAttrs(this.buf.slice(0, gt + 1));
        this.current = {
          identifier: attrs.identifier || ('art_' + Date.now()),
          type: (attrs.type || 'markdown').toLowerCase(),
          language: attrs.language || null,
          title: attrs.title || 'Artifact',
          content: ''
        };
        this.emit('artifact_start', { ...this.current });
        this.buf = this.buf.slice(gt + 1);
        this.mode = 'artifact';
      } else {
        const close = '</artifact>';
        const i = this.buf.indexOf(close);
        if (i === -1) {
          // Hold back any tail that could be a prefix of '</artifact>'.
          let hold = 0;
          for (let n = Math.min(close.length, this.buf.length); n > 0; n--) {
            if (close.startsWith(this.buf.slice(this.buf.length - n))) { hold = n; break; }
          }
          const flush = this.buf.slice(0, this.buf.length - hold);
          if (flush) {
            this.current.content += flush;
            this.emit('artifact_delta', { identifier: this.current.identifier, delta: flush });
          }
          this.buf = this.buf.slice(this.buf.length - hold);
          return;
        }
        if (i > 0) {
          const flush = this.buf.slice(0, i);
          this.current.content += flush;
          this.emit('artifact_delta', { identifier: this.current.identifier, delta: flush });
        }
        this.emit('artifact_end', { ...this.current });
        this.artifacts.push(this.current);
        this.current = null;
        this.buf = this.buf.slice(i + close.length);
        this.mode = 'text';
      }
    }
  }

  // End-of-stream: flush whatever is left. If we're stuck inside an open
  // artifact (model didn't close the tag), close it implicitly so the UI
  // doesn't hang on a half-open render.
  flush() {
    if (this.buf.length) {
      if (this.mode === 'text') {
        this.cleanText += this.buf;
        this.emit('text', { delta: this.buf });
      } else {
        this.current.content += this.buf;
        this.emit('artifact_delta', { identifier: this.current.identifier, delta: this.buf });
      }
      this.buf = '';
    }
    if (this.mode === 'artifact' && this.current) {
      this.emit('artifact_end', { ...this.current, incomplete: true });
      this.artifacts.push(this.current);
      this.current = null;
      this.mode = 'text';
    }
  }
}

const upsertArtifactStmt = db.prepare(`
  INSERT INTO agent_artifacts (thread_id, message_id, identifier, type, language, title, content, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'final')
  ON CONFLICT(thread_id, identifier) DO UPDATE SET
    message_id = excluded.message_id,
    type       = excluded.type,
    language   = excluded.language,
    title      = excluded.title,
    content    = excluded.content,
    status     = 'final',
    updated_at = CURRENT_TIMESTAMP
`);
const listArtifactsStmt = db.prepare(`SELECT id, thread_id, message_id, identifier, type, language, title, content, status, created_at, updated_at FROM agent_artifacts WHERE thread_id = ? ORDER BY id ASC`);

function persistArtifacts(threadId, messageId, artifacts) {
  for (const a of artifacts) {
    try {
      upsertArtifactStmt.run(threadId, messageId, a.identifier, a.type, a.language, a.title, a.content);
    } catch (e) {
      console.error('[artifacts] persist failed:', e.message);
    }
  }
}

// USD per 1M tokens. Anthropic prices mirror PRICE_TABLE in
// services/agent.js — kept in sync manually because the chat module
// can't import from agent.js without pulling in its single-shot
// machinery. Groq prices from groq.com/pricing as of 2026-04.
const PRICE_TABLE = {
  // Anthropic
  'claude-haiku-4-5':        { input: 1.0,  output: 5.0  },
  'claude-sonnet-4-5':       { input: 3.0,  output: 15.0 },
  'claude-opus-4-5':         { input: 15.0, output: 75.0 },
  // Groq (OpenAI-compatible)
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant':    { input: 0.05, output: 0.08 }
};
// 'auto' triggers per-message provider routing via routeProvider.js — Anthropic
// for app/data questions, Groq for general queries. Users can override by
// picking a specific Claude or Llama model from the chat header dropdown.
const DEFAULT_MODEL = 'auto';
const GROQ_DEFAULT  = 'llama-3.3-70b-versatile';

// Provider routing. Anthropic preferred when its key is set; Groq is the
// fallback. The chat agent works against either provider; the rest of
// the module handles protocol differences via the *Anthropic / *Groq
// helpers below.
function hasAnthropic() { return !!process.env.ANTHROPIC_API_KEY; }
function hasGroq()      { return !!process.env.GROQ_API_KEY; }
function isAgentConfigured() { return hasAnthropic() || hasGroq(); }

// Pick the provider for a given thread. If the thread's stored model is a
// Claude model, we need Anthropic (else fall back to whichever is set).
function providerFor(model) {
  if (typeof model === 'string' && model.startsWith('claude-')) {
    return hasAnthropic() ? 'anthropic' : (hasGroq() ? 'groq' : null);
  }
  if (typeof model === 'string' && (model.startsWith('llama-') || model.includes('mixtral'))) {
    return hasGroq() ? 'groq' : null;
  }
  // Unknown model id — pick whichever is configured.
  return hasAnthropic() ? 'anthropic' : (hasGroq() ? 'groq' : null);
}

// Resolve the actual model to call. If the thread asks for Claude but
// only Groq is configured, transparently swap to GROQ_DEFAULT.
function resolveModel(thread) {
  const provider = providerFor(thread.model);
  if (provider === 'anthropic') return { provider, model: thread.model };
  if (provider === 'groq') {
    if (typeof thread.model === 'string' && (thread.model.startsWith('llama-') || thread.model.includes('mixtral'))) {
      return { provider, model: thread.model };
    }
    return { provider, model: GROQ_DEFAULT };
  }
  throw new Error('No agent provider configured. Set ANTHROPIC_API_KEY or GROQ_API_KEY.');
}

function getAnthropicClient() {
  if (!hasAnthropic()) throw new Error('ANTHROPIC_API_KEY not set');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ────────────────────────────── Thread + message persistence ──────────────

const insertThread = db.prepare(`
  INSERT INTO agent_threads (user_id, agent_kind, model) VALUES (?, ?, ?)
`);
const updateThreadTouch = db.prepare(`UPDATE agent_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`);
const updateThreadTitle = db.prepare(`UPDATE agent_threads SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`);
const getThread = db.prepare(`SELECT * FROM agent_threads WHERE id = ? AND user_id = ?`);
const insertMessage = db.prepare(`
  INSERT INTO agent_messages (thread_id, role, content, tool_uses, status)
  VALUES (?, ?, ?, ?, ?)
`);
const updateMessageStatus = db.prepare(`UPDATE agent_messages SET status = ?, content = COALESCE(?, content), tool_uses = COALESCE(?, tool_uses) WHERE id = ?`);
const listMessages = db.prepare(`SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY id ASC`);
const insertCall = db.prepare(`
  INSERT INTO agent_calls (user_id, task_type, model, input_hash, input_preview, output_preview,
    tokens_in, tokens_out, cost_usd, latency_ms, error, thread_id)
  VALUES (?, 'interactive_chat', ?, '', ?, ?, ?, ?, ?, ?, ?, ?)
`);

function createThread({ userId, agentKind = 'financial_advisor', model = DEFAULT_MODEL } = {}) {
  return Number(insertThread.run(userId, agentKind, model).lastInsertRowid);
}

// ────────────────────────────── System prompt ─────────────────────────────

function systemPromptFor(agentKind) {
  if (agentKind === 'financial_advisor') {
    return [
      "You are a financial advisor agent embedded in the user's personal-finance dashboard (fin.kirakon.com).",
      "Currency is INR (₹) unless stated otherwise. The user is an Indian taxpayer; default to Indian tax rules and the New Tax Regime unless they say otherwise.",
      "",
      "Tool-use policy — be conservative:",
      "  • Call a read tool (get_net_worth, query_holdings, query_liabilities, query_hand_loans, query_earnings, query_payments, query_tax, query_properties) ONLY when the user is asking about THEIR OWN data — their portfolio, their net worth, their loans, their payments, their tax position, etc.",
      "  • For general questions (definitions, concepts, how SIPs work, tax slab explanations, market commentary, math you can do yourself, anything not specific to the user's records) answer directly from your knowledge. Do NOT call a read tool.",
      "  • If you are unsure whether a question is about the user's data or general, ask one short clarifying question instead of guessing.",
      "",
      "When the user asks you to make a change to their data, use a propose_* tool. NEVER claim a change has been made until the user confirms the proposal — the system will execute the mutation only after explicit user approval.",
      "Be concise. Bullet lists for >2 items. Numbers should be formatted with Indian commas (e.g. ₹1,50,000).",
      ARTIFACT_INSTRUCTIONS
    ].join('\n');
  }
  if (agentKind === 'upload_processor') {
    return [
      "You are processing a financial document the user just uploaded to their vault. Currency is INR (₹) unless the document states otherwise.",
      "Your job: extract any concrete entries you can identify — stock holdings, mutual fund holdings, earnings/income sources, scheduled payments, advance-tax installments — and propose adding each one using the propose_* tools.",
      "Available propose tools: propose_add_stock, propose_add_mutual_fund, propose_add_earning, propose_add_payment, propose_record_advance_tax.",
      "Be conservative. Only propose rows where you're confident about all required fields. Skip rows where values are ambiguous.",
      "If the document is something else (e.g., a tax filing summary, a bank statement summary, a research note), produce a short text reply describing what you saw — do not call propose_* tools.",
      "Do NOT use the read tools (get_net_worth etc.) — there is no human in the loop to follow up on questions; just extract from the supplied document text.",
      "Do not write conversational filler ('I will now extract...'). Go directly to the proposals or the short summary."
    ].join('\n');
  }
  return 'You are a helpful assistant.';
}

// ────────────────────────────── Conversation construction ────────────────

// Convert agent_messages rows into the Anthropic Messages API shape.
function rowsToMessages(rows) {
  const out = [];
  for (const r of rows) {
    if (r.status !== 'final') continue;            // skip half-written rows
    if (r.role === 'user') {
      out.push({ role: 'user', content: r.content });
    } else if (r.role === 'assistant') {
      const blocks = [];
      if (r.content) blocks.push({ type: 'text', text: r.content });
      const tu = r.tool_uses ? JSON.parse(r.tool_uses) : [];
      for (const t of tu) blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
      out.push({ role: 'assistant', content: blocks });
    } else if (r.role === 'tool') {
      // tool_result blocks are user-role per Anthropic API. The content
      // field accepts either a string or content blocks; pass strings
      // through verbatim so error messages don't get double-JSON-encoded.
      const parsed = JSON.parse(r.content);
      const resultStr = typeof parsed.result === 'string'
        ? parsed.result
        : JSON.stringify(parsed.result);
      out.push({ role: 'user', content: [
        { type: 'tool_result', tool_use_id: parsed.tool_use_id, content: resultStr, is_error: !!parsed.is_error }
      ]});
    }
  }
  return out;
}

// ────────────────────────────── Main entry: sendMessage ──────────────────

async function sendMessage({ threadId, userId, content }) {
  const t = getThread.get(threadId, userId);
  if (!t) throw new Error(`Thread ${threadId} not found for user ${userId}`);
  if (!isAgentConfigured()) throw new Error('No agent provider configured. Set ANTHROPIC_API_KEY or GROQ_API_KEY.');
  if (providerFor(t.model) !== 'anthropic') {
    // The non-streaming sendMessage is only used by smoke tests, which run
    // against Anthropic. Production/UI uses streamMessage which supports both.
    throw new Error('sendMessage requires Anthropic; use streamMessage for Groq.');
  }

  // Persist user message
  const userMsgId = Number(insertMessage.run(threadId, 'user', content, null, 'final').lastInsertRowid);
  // Auto-title on first user message
  const msgCountRow = db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE thread_id = ? AND role = "user"').get(threadId);
  if (msgCountRow.n === 1) {
    updateThreadTitle.run(content.slice(0, 40).trim() || 'New chat', threadId, userId);
  } else {
    updateThreadTouch.run(threadId, userId);
  }

  // Multi-turn loop. On each iteration we send the conversation, examine
  // the response: if it ended with stop_reason === 'tool_use' and ALL the
  // tool calls are read tools, run them, append tool_result blocks, and
  // loop. If a propose_* tool appears, persist the assistant message in
  // 'streaming' state and return a 'paused' result for the caller to
  // surface as a proposal card.

  const client = getAnthropicClient();
  let totalIn = 0, totalOut = 0;
  const t0 = Date.now();
  let lastError = null;

  for (let iter = 0; iter < 8; iter++) {
    const messages = rowsToMessages(listMessages.all(threadId));
    let resp;
    try {
      resp = await client.messages.create({
        model: t.model,
        max_tokens: 1024,
        system: systemPromptFor(t.agent_kind),
        tools: tools.TOOLS,
        messages
      });
    } catch (e) {
      lastError = e.message;
      break;
    }
    totalIn  += resp.usage?.input_tokens  || 0;
    totalOut += resp.usage?.output_tokens || 0;

    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const toolUses = resp.content.filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input }));

    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
      // Final assistant turn
      Number(insertMessage.run(threadId, 'assistant', text, toolUses.length ? JSON.stringify(toolUses) : null, 'final').lastInsertRowid);
      auditAndCost({ userId, threadId, model: t.model, content, text, totalIn, totalOut, t0, error: null });
      return { status: 'final', text };
    }

    // tool_use stop. Decide kind for each.
    const proposals = toolUses.filter(u => tools.TOOL_KIND[u.name] === 'propose');
    if (proposals.length > 0) {
      // Persist assistant message (with text + tool_uses) as streaming.
      // It stays "streaming" until /confirm finalises it.
      const asstId = Number(insertMessage.run(threadId, 'assistant', text, JSON.stringify(toolUses), 'streaming').lastInsertRowid);
      // Build a proposal payload per propose_* tool. (We send only the
      // first one back to the caller; multiple proposals in one turn are
      // rare and would require a UI for batch-confirmation.)
      const first = proposals[0];
      const payload = tools.buildProposal(first.name, first.input, { userId });
      auditAndCost({ userId, threadId, model: t.model, content, text, totalIn, totalOut, t0, error: null });
      return { status: 'paused', text, message_id: asstId, proposal: { tool_use_id: first.id, name: first.name, input: first.input, ...payload } };
    }

    // All read tools — run them and append tool_result rows, then loop.
    Number(insertMessage.run(threadId, 'assistant', text, JSON.stringify(toolUses), 'final').lastInsertRowid);
    for (const u of toolUses) {
      let result, isError = false;
      try { result = await tools.runReadTool(u.name, u.input, { userId }); }
      catch (e) { result = { error: e.message }; isError = true; }
      insertMessage.run(threadId, 'tool',
        JSON.stringify({ tool_use_id: u.id, name: u.name, result, is_error: isError }), null, 'final');
    }
  }

  if (lastError) {
    auditAndCost({ userId, threadId, model: t.model, content, text: '', totalIn, totalOut, t0, error: lastError });
    throw new Error(lastError);
  }
  // Hit iteration cap without final — treat as error for now.
  auditAndCost({ userId, threadId, model: t.model, content, text: '', totalIn, totalOut, t0, error: 'iteration_cap' });
  throw new Error('Tool loop did not converge in 8 iterations');
}

// Confirm/reject a pending proposal. Called from the chat route after the
// user clicks a button. If decision === 'confirm', the caller must dispatch
// the stored mutation against the real route handler and pass the result
// in here so we can write a tool_result row and finalize the assistant
// message.
function recordToolResult({ threadId, userId, message_id, tool_use_id, result, is_error }) {
  const t = getThread.get(threadId, userId);
  if (!t) throw new Error(`Thread ${threadId} not found`);
  // Append tool result row
  insertMessage.run(threadId, 'tool',
    JSON.stringify({ tool_use_id, name: 'proposal_result', result, is_error: !!is_error }), null, 'final');
  // Finalize the assistant row
  updateMessageStatus.run('final', null, null, message_id);
  updateThreadTouch.run(threadId, userId);
}

// Streaming variant. `emit(event, data)` is invoked for each SSE-shaped
// event. Returns the same shape as sendMessage — the route module
// translates {status, ...} into the final SSE event so the client knows
// the stream is done.
//
// Dispatches by provider: Anthropic uses the SDK's native streaming and
// tool-use protocol; Groq goes through the OpenAI-compatible chat
// completions endpoint with translated message + tool formats.
//
// Provider selection:
//   - thread.model === 'auto' (default for new threads) → routeForMessage()
//     classifies the user's content and picks Anthropic for app/data
//     questions, Groq for general questions
//   - explicit thread.model (e.g. 'claude-sonnet-4-5', 'llama-3.3-70b-versatile')
//     wins; user-pinned model is respected verbatim
//   - forceProvider in opts overrides everything ('anthropic'|'groq')
async function streamMessage({ threadId, userId, content, forceProvider = null }, emit) {
  const t = getThread.get(threadId, userId);
  if (!t) throw new Error(`Thread ${threadId} not found for user ${userId}`);
  if (!isAgentConfigured()) throw new Error('No agent provider configured. Set ANTHROPIC_API_KEY or GROQ_API_KEY.');

  const userMsgId = Number(insertMessage.run(threadId, 'user', content, null, 'final').lastInsertRowid);
  emit('thread_meta', { user_message_id: userMsgId });

  const msgCountRow = db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE thread_id = ? AND role = "user"').get(threadId);
  if (msgCountRow.n === 1) updateThreadTitle.run(content.slice(0, 40).trim() || 'New chat', threadId, userId);
  else updateThreadTouch.run(threadId, userId);

  const routed = routeProvider.routeForMessage({
    content,
    forceProvider,
    pinnedModel: t.model
  });
  // Surface routing decision so the UI can show "answered with Groq (auto, general)"
  emit('routing', { provider: routed.provider, model: routed.model, reason: routed.reason });

  if (routed.provider === 'groq') {
    return streamMessageGroq({ thread: t, userId, content, model: routed.model }, emit);
  }
  return streamMessageAnthropic({ thread: t, userId, content, model: routed.model }, emit);
}

// ────────────────────────────── Anthropic streaming path ──────────────────

async function streamMessageAnthropic({ thread: t, userId, content, model }, emit) {
  const client = getAnthropicClient();
  let totalIn = 0, totalOut = 0;
  const t0 = Date.now();
  const threadId = t.id;

  for (let iter = 0; iter < 8; iter++) {
    const messages = rowsToMessages(listMessages.all(threadId));
    const stream = client.messages.stream({
      model, max_tokens: 1024,
      system: systemPromptFor(t.agent_kind),
      tools: tools.TOOLS, messages
    });

    let asstId = null;
    const toolUses = [];
    const parser = new ArtifactStreamParser(emit);

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'text' && asstId == null) {
          asstId = Number(insertMessage.run(threadId, 'assistant', '', null, 'streaming').lastInsertRowid);
          emit('assistant_start', { message_id: asstId });
        }
        if (event.content_block.type === 'tool_use') {
          toolUses.push({ id: event.content_block.id, name: event.content_block.name, input_buf: '' });
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          parser.feed(event.delta.text);
        } else if (event.delta.type === 'input_json_delta') {
          toolUses[toolUses.length - 1].input_buf += event.delta.partial_json;
        }
      }
    }
    parser.flush();
    const textBuf = parser.cleanText;

    const final = await stream.finalMessage();
    totalIn  += final.usage?.input_tokens  || 0;
    totalOut += final.usage?.output_tokens || 0;

    // Resolve tool_use inputs (input_buf is a JSON string; the SDK also
    // exposes parsed input on the final block, prefer that).
    const finalToolUses = final.content.filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input }));

    if (final.stop_reason !== 'tool_use' || finalToolUses.length === 0) {
      // Finalize the assistant row with the buffered text
      if (asstId == null) asstId = Number(insertMessage.run(threadId, 'assistant', textBuf, null, 'final').lastInsertRowid);
      else updateMessageStatus.run('final', textBuf, null, asstId);
      persistArtifacts(threadId, asstId, parser.artifacts);
      const cost = auditAndCost({ userId, threadId, model, content, text: textBuf, totalIn, totalOut, t0, error: null });
      emit('done', { message_id: asstId, usage: { in: totalIn, out: totalOut, cost_usd: cost } });
      return;
    }

    const proposals = finalToolUses.filter(u => tools.TOOL_KIND[u.name] === 'propose');
    if (proposals.length > 0) {
      // Persist assistant message with text + tool_uses, status streaming
      if (asstId == null) {
        asstId = Number(insertMessage.run(threadId, 'assistant', textBuf, JSON.stringify(finalToolUses), 'streaming').lastInsertRowid);
      } else {
        updateMessageStatus.run('streaming', textBuf, JSON.stringify(finalToolUses), asstId);
      }
      persistArtifacts(threadId, asstId, parser.artifacts);
      const first = proposals[0];
      let payload;
      try { payload = tools.buildProposal(first.name, first.input, { userId }); }
      catch (e) { emit('error', { message: e.message }); return; }
      emit('proposal', {
        tool_use_id: first.id, name: first.name, input: first.input,
        message_id: asstId, summary: payload.summary, mutation: payload.mutation
      });
      auditAndCost({ userId, threadId, model, content, text: textBuf, totalIn, totalOut, t0, error: null });
      return;
    }

    // All read tools — finalize the assistant row, run them, loop.
    if (asstId == null) asstId = Number(insertMessage.run(threadId, 'assistant', textBuf, JSON.stringify(finalToolUses), 'final').lastInsertRowid);
    else updateMessageStatus.run('final', textBuf, JSON.stringify(finalToolUses), asstId);
    persistArtifacts(threadId, asstId, parser.artifacts);
    for (const u of finalToolUses) {
      emit('tool_use', { id: u.id, name: u.name, input: u.input });
      let result, isError = false;
      try { result = await tools.runReadTool(u.name, u.input, { userId }); }
      catch (e) { result = { error: e.message }; isError = true; }
      insertMessage.run(threadId, 'tool',
        JSON.stringify({ tool_use_id: u.id, name: u.name, result, is_error: isError }), null, 'final');
      emit('tool_result', { tool_use_id: u.id, status: isError ? 'error' : 'ok', result });
    }
  }

  emit('error', { message: 'Tool loop did not converge in 8 iterations' });
}

// ────────────────────────────── Groq streaming path ──────────────────────
//
// Groq exposes an OpenAI-compatible /chat/completions endpoint. The wire
// format differs from Anthropic in three ways that matter for us:
//   - tools spec is wrapped in { type: 'function', function: {...} }
//   - tool calls come back on assistant.tool_calls (not as content blocks)
//   - tool results go in role: 'tool' messages with tool_call_id
// We translate at the boundary so the rest of the chat module (DB rows,
// proposal flow, audit) is identical across providers.

const GROQ_BASE = 'https://api.groq.com/openai/v1';

function toolsToOpenAI(toolsArr) {
  return toolsArr.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema }
  }));
}

// Convert agent_messages rows into OpenAI-format messages.
function rowsToMessagesGroq(rows) {
  const out = [];
  for (const r of rows) {
    if (r.status !== 'final') continue;
    if (r.role === 'user') {
      out.push({ role: 'user', content: r.content });
    } else if (r.role === 'assistant') {
      const tu = r.tool_uses ? JSON.parse(r.tool_uses) : [];
      const msg = { role: 'assistant', content: r.content || '' };
      if (tu.length) {
        msg.tool_calls = tu.map(t => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input || {}) }
        }));
      }
      out.push(msg);
    } else if (r.role === 'tool') {
      const parsed = JSON.parse(r.content);
      const resultStr = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
      out.push({ role: 'tool', tool_call_id: parsed.tool_use_id, content: resultStr });
    }
  }
  return out;
}

async function streamMessageGroq({ thread: t, userId, content, model }, emit) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');
  const threadId = t.id;
  let totalIn = 0, totalOut = 0;
  const t0 = Date.now();

  for (let iter = 0; iter < 8; iter++) {
    const messages = rowsToMessagesGroq(listMessages.all(threadId));
    // Groq requires a system message inline (not a separate field).
    const fullMessages = [{ role: 'system', content: systemPromptFor(t.agent_kind) }, ...messages];

    const resp = await fetch(`${GROQ_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 1024, temperature: 0.2,
        messages: fullMessages,
        tools: toolsToOpenAI(tools.TOOLS),
        stream: true
      })
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      emit('error', { message: `Groq HTTP ${resp.status}: ${body.slice(0, 300)}` });
      auditAndCost({ userId, threadId, model, content, text: '', totalIn, totalOut, t0, error: `groq_${resp.status}` });
      return;
    }

    let asstId = null;
    const toolCalls = [];   // [{ id, name, arguments_buf }]
    let finishReason = null;
    let usage = null;
    const parser = new ArtifactStreamParser(emit);

    // Parse SSE stream
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop();
      for (const ev of events) {
        const dataLine = ev.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (payload === '[DONE]') continue;
        let chunk;
        try { chunk = JSON.parse(payload); } catch (_) { continue; }
        const choice = chunk.choices && chunk.choices[0];
        if (!choice) {
          if (chunk.usage) usage = chunk.usage;
          continue;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        if (delta.content) {
          if (asstId == null) {
            asstId = Number(insertMessage.run(threadId, 'assistant', '', null, 'streaming').lastInsertRowid);
            emit('assistant_start', { message_id: asstId });
          }
          parser.feed(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index || 0;
            if (!toolCalls[idx]) toolCalls[idx] = { id: tc.id || `call_${idx}`, name: '', arguments_buf: '' };
            if (tc.id) toolCalls[idx].id = tc.id;
            if (tc.function && tc.function.name) toolCalls[idx].name = tc.function.name;
            if (tc.function && tc.function.arguments) toolCalls[idx].arguments_buf += tc.function.arguments;
          }
        }
        if (chunk.usage) usage = chunk.usage;
      }
    }

    parser.flush();
    const textBuf = parser.cleanText;
    if (usage) { totalIn += usage.prompt_tokens || 0; totalOut += usage.completion_tokens || 0; }

    // Resolve tool calls' input from accumulated argument JSON
    const finalToolUses = toolCalls.filter(Boolean).map(tc => {
      let input = {};
      try { input = tc.arguments_buf ? JSON.parse(tc.arguments_buf) : {}; } catch (_) { /* keep {} */ }
      return { id: tc.id, name: tc.name, input };
    });

    if (finishReason !== 'tool_calls' || finalToolUses.length === 0) {
      if (asstId == null) asstId = Number(insertMessage.run(threadId, 'assistant', textBuf, null, 'final').lastInsertRowid);
      else updateMessageStatus.run('final', textBuf, null, asstId);
      persistArtifacts(threadId, asstId, parser.artifacts);
      const cost = auditAndCost({ userId, threadId, model, content, text: textBuf, totalIn, totalOut, t0, error: null });
      emit('done', { message_id: asstId, usage: { in: totalIn, out: totalOut, cost_usd: cost } });
      return;
    }

    const proposals = finalToolUses.filter(u => tools.TOOL_KIND[u.name] === 'propose');
    if (proposals.length > 0) {
      if (asstId == null) {
        asstId = Number(insertMessage.run(threadId, 'assistant', textBuf, JSON.stringify(finalToolUses), 'streaming').lastInsertRowid);
      } else {
        updateMessageStatus.run('streaming', textBuf, JSON.stringify(finalToolUses), asstId);
      }
      persistArtifacts(threadId, asstId, parser.artifacts);
      const first = proposals[0];
      let payload;
      try { payload = tools.buildProposal(first.name, first.input, { userId }); }
      catch (e) { emit('error', { message: e.message }); return; }
      emit('proposal', {
        tool_use_id: first.id, name: first.name, input: first.input,
        message_id: asstId, summary: payload.summary, mutation: payload.mutation
      });
      auditAndCost({ userId, threadId, model, content, text: textBuf, totalIn, totalOut, t0, error: null });
      return;
    }

    // All read tools — finalize the assistant row, run them, loop.
    if (asstId == null) asstId = Number(insertMessage.run(threadId, 'assistant', textBuf, JSON.stringify(finalToolUses), 'final').lastInsertRowid);
    else updateMessageStatus.run('final', textBuf, JSON.stringify(finalToolUses), asstId);
    persistArtifacts(threadId, asstId, parser.artifacts);
    for (const u of finalToolUses) {
      emit('tool_use', { id: u.id, name: u.name, input: u.input });
      let result, isError = false;
      try { result = await tools.runReadTool(u.name, u.input, { userId }); }
      catch (e) { result = { error: e.message }; isError = true; }
      insertMessage.run(threadId, 'tool',
        JSON.stringify({ tool_use_id: u.id, name: u.name, result, is_error: isError }), null, 'final');
      emit('tool_result', { tool_use_id: u.id, status: isError ? 'error' : 'ok', result });
    }
  }

  emit('error', { message: 'Tool loop did not converge in 8 iterations' });
}

function auditAndCost({ userId, threadId, model, content, text, totalIn, totalOut, t0, error }) {
  const prices = PRICE_TABLE[model] || PRICE_TABLE[DEFAULT_MODEL];
  const cost = (totalIn / 1_000_000) * prices.input + (totalOut / 1_000_000) * prices.output;
  insertCall.run(userId, model, content.slice(0, 200), (text || '').slice(0, 200),
    totalIn, totalOut, cost, Date.now() - t0, error, threadId);
  return cost;
}

module.exports = {
  isAgentConfigured,
  createThread,
  sendMessage,       // non-streaming, used by smoke test
  streamMessage,     // SSE-streaming, used by routes
  recordToolResult,
  _getThread: (id, userId) => getThread.get(id, userId),
  _listMessages: (threadId) => listMessages.all(threadId),
  _listArtifacts: (threadId) => listArtifactsStmt.all(threadId),
  _updateThread: (id, userId, fields) => {
    const cols = []; const vals = [];
    for (const k of ['title', 'agent_kind', 'model']) if (fields[k] != null) { cols.push(`${k} = ?`); vals.push(fields[k]); }
    if (!cols.length) return;
    db.prepare(`UPDATE agent_threads SET ${cols.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`).run(...vals, id, userId);
  },
  _deleteThread: (id, userId) => db.prepare('DELETE FROM agent_threads WHERE id = ? AND user_id = ?').run(id, userId),
  _listThreads: (userId) => db.prepare(`
    SELECT t.id, t.title, t.agent_kind, t.model, t.updated_at,
      (SELECT COUNT(*) FROM agent_messages m
        WHERE m.thread_id = t.id AND m.role = 'assistant' AND m.status = 'streaming') AS pending_count
    FROM agent_threads t
    WHERE t.user_id = ?
    ORDER BY t.updated_at DESC
  `).all(userId)
};
