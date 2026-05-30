const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');
const tools = require('./chatTools');
const routeProvider = require('./routeProvider');

// ─────────────────────────── Live artifacts ─────────────────────────────────
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

// Defensive scrub against models (especially Llama on Groq) hallucinating
// fake SQL/database errors in their reply text.
const SQL_HALLUCINATION_PATTERNS = [
  /no such column[^\n]{0,200}/gi,
  /no such table[^\n]{0,200}/gi,
  /SELECT\s+[*\w,\s]+FROM[^\n;]{0,400}/gi,
  /SQLite(\s+error)?:[^\n]{0,200}/gi,
  /SQLITE_ERROR[^\n]{0,200}/gi,
  /Traceback \(most recent call last\):[\s\S]{0,400}/g
];
function scrubAssistantText(s) {
  if (typeof s !== 'string' || !s) return s == null ? '' : String(s);
  try {
    let out = s;
    for (const re of SQL_HALLUCINATION_PATTERNS) {
      out = out.replace(re, '[internal database detail suppressed]');
    }
    return out;
  } catch (err) {
    console.error('[scrubAssistantText] regex error:', err.message);
    return s;
  }
}

class ArtifactStreamParser {
  constructor(emit) {
    this.emit = emit;
    this.buf = '';
    this.mode = 'text';
    this.current = null;
    this.cleanText = '';
    this.artifacts = [];
  }

  feed(delta) {
    this.buf += delta;
    while (true) {
      if (this.mode === 'text') {
        const i = this.buf.indexOf('<artifact');
        if (i === -1) {
          let hold = 0;
          for (let n = Math.min(9, this.buf.length); n > 0; n--) {
            if ('<artifact'.startsWith(this.buf.slice(this.buf.length - n))) { hold = n; break; }
          }
          const flush = this.buf.slice(0, this.buf.length - hold);
          if (flush) { const safe = scrubAssistantText(flush); this.cleanText += safe; this.emit('text', { delta: safe }); }
          this.buf = this.buf.slice(this.buf.length - hold);
          return;
        }
        if (i > 0) {
          const flush = this.buf.slice(0, i);
          const safe = scrubAssistantText(flush);
          this.cleanText += safe;
          this.emit('text', { delta: safe });
          this.buf = this.buf.slice(i);
        }
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

  flush() {
    if (this.buf.length) {
      if (this.mode === 'text') {
        const safe = scrubAssistantText(this.buf);
        this.cleanText += safe;
        this.emit('text', { delta: safe });
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

// USD per 1M tokens.
const PRICE_TABLE = {
  'claude-haiku-4-5':        { input: 1.0,  output: 5.0  },
  'claude-sonnet-4-5':       { input: 3.0,  output: 15.0 },
  'claude-opus-4-5':         { input: 15.0, output: 75.0 },
  'mistral':                 { input: 0,    output: 0    },
  'qwen2.5':                 { input: 0,    output: 0    }
};
const DEFAULT_MODEL = 'auto';

function hasAnthropic() { return !!process.env.ANTHROPIC_API_KEY; }
function hasLocal()     { return !!process.env.OLLAMA_BASE_URL; }
function isAgentConfigured() { return hasAnthropic() || hasLocal(); }

function providerFor(model) {
  if (typeof model === 'string' && model.startsWith('claude-')) {
    return hasAnthropic() ? 'anthropic' : (hasLocal() ? 'local' : null);
  }
  return hasLocal() ? 'local' : (hasAnthropic() ? 'anthropic' : null);
}

function resolveModel(thread) {
  const provider = providerFor(thread.model);
  if (provider === 'anthropic') return { provider, model: thread.model };
  if (provider === 'local') {
    return { provider, model: process.env.OLLAMA_MODEL || 'qwen2.5:latest' };
  }
  throw new Error('No agent provider configured. Set OLLAMA_BASE_URL or ANTHROPIC_API_KEY.');
}

function getAnthropicClient() {
  if (!hasAnthropic()) throw new Error('ANTHROPIC_API_KEY not set');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ────────────────────────────── Thread + message persistence ──────

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

function createThread({ userId, agentKind = 'assistant', model = DEFAULT_MODEL } = {}) {
  return Number(insertThread.run(userId, agentKind, model).lastInsertRowid);
}

// ───────────────────────────────────── System prompt ─────────────────

function systemPromptFor(agentKind) {
  if (agentKind === 'assistant' || agentKind === 'financial_advisor') {
    return [
      "You are a helpful assistant inside a personal-finance dashboard.",
      "",
      "Tool-use policy — be conservative:",
      "  • Call a read tool (get_net_worth, query_holdings, query_liabilities, query_hand_loans, query_earnings, query_payments, query_tax, query_properties) ONLY when the user is asking about THEIR OWN data.",
      "  • For general questions (definitions, concepts, math, current affairs, anything not specific to the user's records) answer directly from your knowledge — do NOT call a read tool.",
      "  • If unsure whether the question is about the user's data or general, ask one short clarifying question.",
      "",
      "STRICT output rules — these prevent hallucinated errors:",
      "  • NEVER write SQL queries in your response. NEVER simulate database access in plain text.",
      "  • If you do not have data the user is asking about and no tool can fetch it, say plainly: \"I don't have access to that.\"",
      "  • If a tool returns an error, summarise the error in one short sentence — do NOT echo internal SQL or stack traces (no \"no such column: ...\", no \"SELECT ...\").",
      "  • Never invent column names, schemas, or fake query results.",
      "",
      "When the user asks you to make a change to their data, use a propose_* tool. NEVER claim a change has been made until the user confirms the proposal — the system will execute the mutation only after explicit user approval.",
      "Be concise. Bullet lists for >2 items.",
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

// ───────────────────────────────── Conversation construction ────────────

function rowsToMessages(rows) {
  const out = [];
  for (const r of rows) {
    if (r.status !== 'final') continue;
    if (r.role === 'user') {
      out.push({ role: 'user', content: r.content });
    } else if (r.role === 'assistant') {
      const blocks = [];
      if (r.content) blocks.push({ type: 'text', text: r.content });
      const tu = r.tool_uses ? JSON.parse(r.tool_uses) : [];
      for (const t of tu) blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
      out.push({ role: 'assistant', content: blocks });
    } else if (r.role === 'tool') {
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

// ─────────────────────────────────── Main entry: sendMessage ────────────

async function sendMessage({ threadId, userId, content }) {
  const t = getThread.get(threadId, userId);
  if (!t) throw new Error(`Thread ${threadId} not found for user ${userId}`);
  if (!isAgentConfigured()) throw new Error('No agent provider configured. Set OLLAMA_BASE_URL or ANTHROPIC_API_KEY.');
  if (providerFor(t.model) !== 'anthropic') {
    throw new Error('sendMessage requires Anthropic; use streamMessage for Ollama.');
  }

  const userMsgId = Number(insertMessage.run(threadId, 'user', content, null, 'final').lastInsertRowid);
  const msgCountRow = db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE thread_id = ? AND role = 'user'").get(threadId);
  if (msgCountRow.n === 1) {
    updateThreadTitle.run(content.slice(0, 40).trim() || 'New chat', threadId, userId);
  } else {
    updateThreadTouch.run(threadId, userId);
  }

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
      Number(insertMessage.run(threadId, 'assistant', text, toolUses.length ? JSON.stringify(toolUses) : null, 'final').lastInsertRowid);
      auditAndCost({ userId, threadId, model: t.model, content, text, totalIn, totalOut, t0, error: null });
      return { status: 'final', text };
    }

    const proposals = toolUses.filter(u => tools.TOOL_KIND[u.name] === 'propose');
    if (proposals.length > 0) {
      const asstId = Number(insertMessage.run(threadId, 'assistant', text, JSON.stringify(toolUses), 'streaming').lastInsertRowid);
      const first = proposals[0];
      const payload = tools.buildProposal(first.name, first.input, { userId });
      auditAndCost({ userId, threadId, model: t.model, content, text, totalIn, totalOut, t0, error: null });
      return { status: 'paused', text, message_id: asstId, proposal: { tool_use_id: first.id, name: first.name, input: first.input, ...payload } };
    }

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
  auditAndCost({ userId, threadId, model: t.model, content, text: '', totalIn, totalOut, t0, error: 'iteration_cap' });
  throw new Error('Tool loop did not converge in 8 iterations');
}

function recordToolResult({ threadId, userId, message_id, tool_use_id, result, is_error }) {
  const t = getThread.get(threadId, userId);
  if (!t) throw new Error(`Thread ${threadId} not found`);
  insertMessage.run(threadId, 'tool',
    JSON.stringify({ tool_use_id, name: 'proposal_result', result, is_error: !!is_error }), null, 'final');
  updateMessageStatus.run('final', null, null, message_id);
  updateThreadTouch.run(threadId, userId);
}

// Streaming variant. Provider selection:
//   - thread.model === 'auto' (default) → routeForMessage() picks local Ollama
//     when configured (primary/free), Anthropic as cloud fallback.
//   - explicit thread.model wins; forceProvider overrides everything.
// When Anthropic is chosen but throws before streaming (e.g. 402 credit
// exhaustion), falls back to local Ollama if OLLAMA_BASE_URL is set.
async function streamMessage({ threadId, userId, content, forceProvider = null }, emit) {
  const t = getThread.get(threadId, userId);
  if (!t) throw new Error(`Thread ${threadId} not found for user ${userId}`);
  if (!isAgentConfigured()) throw new Error('No agent provider configured. Set OLLAMA_BASE_URL or ANTHROPIC_API_KEY.');

  const userMsgId = Number(insertMessage.run(threadId, 'user', content, null, 'final').lastInsertRowid);
  emit('thread_meta', { user_message_id: userMsgId });

  const msgCountRow = db.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE thread_id = ? AND role = 'user'").get(threadId);
  if (msgCountRow.n === 1) updateThreadTitle.run(content.slice(0, 40).trim() || 'New chat', threadId, userId);
  else updateThreadTouch.run(threadId, userId);

  const routed = routeProvider.routeForMessage({
    content,
    forceProvider,
    pinnedModel: t.model
  });
  emit('routing', { provider: routed.provider, model: routed.model, reason: routed.reason });

  if (routed.provider === 'groq') {
    return streamMessageOpenAI({ thread: t, userId, content, model: routed.model,
      baseUrl: GROQ_BASE, apiKey: process.env.GROQ_API_KEY, providerLabel: 'groq' }, emit);
  }
  if (routed.provider === 'local') {
    return streamMessageOpenAI({ thread: t, userId, content, model: routed.model,
      baseUrl: process.env.OLLAMA_BASE_URL, apiKey: null, providerLabel: 'local' }, emit);
  }
  // Anthropic path: fall back to local Ollama on error (e.g. credit exhaustion)
  // if local is configured and no content has streamed yet.
  if (hasLocal()) {
    try {
      return await streamMessageAnthropic({ thread: t, userId, content, model: routed.model }, emit);
    } catch (err) {
      console.warn(`[chatAgent] Anthropic failed (${err.message}) — falling back to local Ollama`);
      const fallbackModel = process.env.OLLAMA_MODEL || 'qwen2.5:latest';
      emit('routing', { provider: 'local', model: fallbackModel, reason: 'fallback:anthropic-error' });
      return streamMessageOpenAI({ thread: t, userId, content, model: fallbackModel,
        baseUrl: process.env.OLLAMA_BASE_URL, apiKey: null, providerLabel: 'local' }, emit);
    }
  }
  return streamMessageAnthropic({ thread: t, userId, content, model: routed.model }, emit);
}

// ────────────────────────────────── Anthropic streaming path ──────────────

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

    const finalToolUses = final.content.filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input }));

    if (final.stop_reason !== 'tool_use' || finalToolUses.length === 0) {
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

// ──────────────────────────────────── Groq / OpenAI-compat streaming ──────

const GROQ_BASE = 'https://api.groq.com/openai/v1';

function toolsToOpenAI(toolsArr) {
  return toolsArr.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema }
  }));
}

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

async function streamMessageOpenAI({ thread: t, userId, content, model, baseUrl, apiKey, providerLabel }, emit) {
  if (!baseUrl) throw new Error(`${providerLabel}: base URL not set`);
  const threadId = t.id;
  let totalIn = 0, totalOut = 0;
  const t0 = Date.now();

  for (let iter = 0; iter < 8; iter++) {
    const messages = rowsToMessagesGroq(listMessages.all(threadId));
    const fullMessages = [{ role: 'system', content: systemPromptFor(t.agent_kind) }, ...messages];

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model, max_tokens: 1024, temperature: 0.2,
        messages: fullMessages,
        tools: toolsToOpenAI(tools.TOOLS),
        stream: true
      })
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      emit('error', { message: `${providerLabel} HTTP ${resp.status}: ${body.slice(0, 300)}` });
      auditAndCost({ userId, threadId, model, content, text: '', totalIn, totalOut, t0, error: `${providerLabel}_${resp.status}` });
      return;
    }

    let asstId = null;
    const toolCalls = [];
    let finishReason = null;
    let usage = null;
    const parser = new ArtifactStreamParser(emit);

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
  const prices = PRICE_TABLE[model] || { input: 0, output: 0 };
  const cost = (totalIn / 1_000_000) * prices.input + (totalOut / 1_000_000) * prices.output;
  insertCall.run(userId, model, content.slice(0, 200), (text || '').slice(0, 200),
    totalIn, totalOut, cost, Date.now() - t0, error, threadId);
  return cost;
}

module.exports = {
  isAgentConfigured,
  createThread,
  sendMessage,
  streamMessage,
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
  _deleteAllThreads: (userId) => db.prepare('DELETE FROM agent_threads WHERE user_id = ?').run(userId).changes,
  _listThreads: (userId) => db.prepare(`
    SELECT t.id, t.title, t.agent_kind, t.model, t.updated_at,
      (SELECT COUNT(*) FROM agent_messages m
        WHERE m.thread_id = t.id AND m.role = 'assistant' AND m.status = 'streaming') AS pending_count
    FROM agent_threads t
    WHERE t.user_id = ?
    ORDER BY t.updated_at DESC
  `).all(userId)
};
