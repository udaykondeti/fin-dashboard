const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');
const tools = require('./chatTools');

// USD per 1M tokens. Mirrors PRICE_TABLE in services/agent.js — kept in sync
// manually because the chat module can't import from services/agent.js
// without pulling in its single-shot machinery.
const PRICE_TABLE = {
  'claude-haiku-4-5':  { input: 1.0,  output: 5.0  },
  'claude-sonnet-4-5': { input: 3.0,  output: 15.0 },
  'claude-opus-4-5':   { input: 15.0, output: 75.0 }
};
const DEFAULT_MODEL = 'claude-haiku-4-5';

function isAgentConfigured() { return !!process.env.ANTHROPIC_API_KEY; }
function getClient() {
  if (!isAgentConfigured()) throw new Error('Anthropic agent is not configured. Set ANTHROPIC_API_KEY.');
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
      "Use the read tools (get_net_worth, query_holdings, query_liabilities, query_hand_loans, query_earnings, query_payments, query_tax, query_properties) whenever the answer depends on the user's actual data — do not guess.",
      "When the user asks you to make a change to their data, use a propose_* tool. NEVER claim a change has been made until the user confirms the proposal — the system will execute the mutation only after explicit user approval.",
      "Be concise. Bullet lists for >2 items. Numbers should be formatted with Indian commas (e.g. ₹1,50,000)."
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
  if (!isAgentConfigured()) throw new Error('Anthropic agent is not configured. Set ANTHROPIC_API_KEY.');

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

  const client = getClient();
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
async function streamMessage({ threadId, userId, content }, emit) {
  const t = getThread.get(threadId, userId);
  if (!t) throw new Error(`Thread ${threadId} not found for user ${userId}`);
  if (!isAgentConfigured()) throw new Error('Anthropic agent is not configured. Set ANTHROPIC_API_KEY.');

  const userMsgId = Number(insertMessage.run(threadId, 'user', content, null, 'final').lastInsertRowid);
  emit('thread_meta', { user_message_id: userMsgId });

  const msgCountRow = db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE thread_id = ? AND role = "user"').get(threadId);
  if (msgCountRow.n === 1) updateThreadTitle.run(content.slice(0, 40).trim() || 'New chat', threadId, userId);
  else updateThreadTouch.run(threadId, userId);

  const client = getClient();
  let totalIn = 0, totalOut = 0;
  const t0 = Date.now();

  for (let iter = 0; iter < 8; iter++) {
    const messages = rowsToMessages(listMessages.all(threadId));
    const stream = client.messages.stream({
      model: t.model, max_tokens: 1024,
      system: systemPromptFor(t.agent_kind),
      tools: tools.TOOLS, messages
    });

    let textBuf = '';
    let asstId = null;
    const toolUses = [];

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
          textBuf += event.delta.text;
          emit('text', { delta: event.delta.text });
        } else if (event.delta.type === 'input_json_delta') {
          toolUses[toolUses.length - 1].input_buf += event.delta.partial_json;
        }
      }
    }

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
      const cost = auditAndCost({ userId, threadId, model: t.model, content, text: textBuf, totalIn, totalOut, t0, error: null });
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
      const first = proposals[0];
      let payload;
      try { payload = tools.buildProposal(first.name, first.input, { userId }); }
      catch (e) { emit('error', { message: e.message }); return; }
      emit('proposal', {
        tool_use_id: first.id, name: first.name, input: first.input,
        message_id: asstId, summary: payload.summary, mutation: payload.mutation
      });
      auditAndCost({ userId, threadId, model: t.model, content, text: textBuf, totalIn, totalOut, t0, error: null });
      return;
    }

    // All read tools — finalize the assistant row, run them, loop.
    if (asstId == null) asstId = Number(insertMessage.run(threadId, 'assistant', textBuf, JSON.stringify(finalToolUses), 'final').lastInsertRowid);
    else updateMessageStatus.run('final', textBuf, JSON.stringify(finalToolUses), asstId);
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
