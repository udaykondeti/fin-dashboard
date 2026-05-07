const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const chatAgent = require('../services/chatAgent');

router.use(authMiddleware);

// GET /api/chat/threads
router.get('/threads', (req, res) => {
  res.json({ threads: chatAgent._listThreads(req.user.id) });
});

// POST /api/chat/threads
router.post('/threads', (req, res) => {
  const { agent_kind, model } = req.body || {};
  const id = chatAgent.createThread({ userId: req.user.id, agentKind: agent_kind, model });
  res.status(201).json({ id });
});

// GET /api/chat/threads/:id
router.get('/threads/:id', (req, res) => {
  const id = Number(req.params.id);
  const thread = chatAgent._getThread(id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  res.json({
    thread,
    messages: chatAgent._listMessages(id),
    artifacts: chatAgent._listArtifacts(id)
  });
});

// PATCH /api/chat/threads/:id
router.patch('/threads/:id', (req, res) => {
  const id = Number(req.params.id);
  const thread = chatAgent._getThread(id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const { title, agent_kind, model } = req.body || {};
  if (title != null && (typeof title !== 'string' || title.length > 200)) return res.status(400).json({ error: 'title must be a string ≤ 200 chars' });
  chatAgent._updateThread(id, req.user.id, { title, agent_kind, model });
  res.json({ ok: true });
});

// DELETE /api/chat/threads/:id
router.delete('/threads/:id', (req, res) => {
  const id = Number(req.params.id);
  chatAgent._deleteThread(id, req.user.id);
  res.json({ ok: true });
});

// SSE: POST /api/chat/threads/:id/stream
router.post('/threads/:id/stream', async (req, res) => {
  const id = Number(req.params.id);
  const thread = chatAgent._getThread(id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const { content, force_provider } = req.body || {};
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  // Optional per-message override: 'anthropic' | 'groq' | null. When set,
  // wins over both auto-routing and the thread's pinned model.
  const forceProvider = force_provider === 'anthropic' || force_provider === 'groq' ? force_provider : null;
  if (!chatAgent.isAgentConfigured()) {
    return res.status(503).json({
      error: 'Agent is not configured: set ANTHROPIC_API_KEY or GROQ_API_KEY',
      message: 'Add the key to PM2/environment config and restart with --update-env.'
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const emit = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await chatAgent.streamMessage({ threadId: id, userId: req.user.id, content, forceProvider }, emit);
  } catch (e) {
    emit('error', { message: e.message });
  } finally {
    res.end();
  }
});

// POST /api/chat/threads/:id/confirm
// Body: { tool_use_id, message_id, decision: 'confirm'|'reject', mutation? }
// The mutation object was emitted in the original 'proposal' SSE event
// and is sent back here on confirm so the client doesn't need to remember
// its own tool_use_id ↔ mutation map. We re-validate by checking the
// stored assistant message has a matching tool_use_id.
router.post('/threads/:id/confirm', async (req, res) => {
  const id = Number(req.params.id);
  const thread = chatAgent._getThread(id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  const { tool_use_id, message_id, decision, mutation } = req.body || {};
  if (!tool_use_id || !message_id || !['confirm', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'tool_use_id, message_id, decision required' });
  }

  // Validate the message belongs to this thread, is the right id, and has
  // the matching tool_use_id pending.
  const msgs = chatAgent._listMessages(id);
  const asst = msgs.find(m => m.id === Number(message_id));
  if (!asst || asst.role !== 'assistant') return res.status(404).json({ error: 'Assistant message not found' });
  if (asst.status === 'final') return res.json({ ok: true, applied: false, error: 'Already resolved' });
  const tu = asst.tool_uses ? JSON.parse(asst.tool_uses) : [];
  if (!tu.some(u => u.id === tool_use_id)) return res.status(400).json({ error: 'tool_use_id not on this message' });

  if (decision === 'reject') {
    chatAgent.recordToolResult({ threadId: id, userId: req.user.id, message_id: Number(message_id),
      tool_use_id, result: { rejected: true }, is_error: false });
    return res.json({ ok: true, applied: false });
  }

  // Confirm path: dispatch the stored mutation by invoking the matching
  // route handler in-process. We use a small request-scoped fetch against
  // our own server (auth header reused from this request) for simplicity
  // and to keep route logic the single source of truth.
  // Rebuild the mutation from the stored proposal input if the client
  // lost it (e.g., after a reload restored a pending-proposal thread).
  var effMutation = mutation;
  if (!effMutation || !effMutation.method || !effMutation.path) {
    var tools = require('../services/chatTools');
    var stored = tu.find(function(u){ return u.id === tool_use_id; });
    if (!stored) return res.status(400).json({ error: 'mutation missing and tool_use not found' });
    try {
      var rebuilt = tools.buildProposal(stored.name, stored.input, { userId: req.user.id });
      effMutation = rebuilt.mutation;
    } catch (e) { return res.status(400).json({ error: 'Could not rebuild mutation: ' + e.message }); }
  }
  let result, isError = false;
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}${effMutation.path}`, {
      method: effMutation.method,
      headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization || '' },
      body: effMutation.body ? JSON.stringify(effMutation.body) : undefined
    });
    result = await r.json().catch(() => ({}));
    if (!r.ok) { isError = true; result = { error: result.error || `HTTP ${r.status}` }; }
  } catch (e) {
    isError = true; result = { error: e.message };
  }

  chatAgent.recordToolResult({ threadId: id, userId: req.user.id, message_id: Number(message_id),
    tool_use_id, result, is_error: isError });
  res.json({ ok: true, applied: !isError, error: isError ? result.error : undefined });
});

module.exports = router;
