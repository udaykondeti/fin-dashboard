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
  res.json({ thread, messages: chatAgent._listMessages(id) });
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

module.exports = router;
