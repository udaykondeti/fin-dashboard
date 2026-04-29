const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { isSlackConfigured, notify } = require('../services/slack');

router.use(authMiddleware);

router.get('/slack/status', (req, res) => {
  res.json({ configured: isSlackConfigured() });
});

router.post('/slack/test', async (req, res) => {
  const message = (req.body && typeof req.body.message === 'string')
    ? req.body.message
    : 'fin-dashboard test message';
  if (message.length > 1000) {
    return res.status(400).json({ error: 'message exceeds 1000 character limit' });
  }
  const result = await notify(message);
  res.json(result);
});

module.exports = router;
