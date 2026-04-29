const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// GET /api/activity?limit=20
// Returns the most recent activity_log entries for the requesting user.
// Each entry was produced by scripts/groq-watcher.js summarising recent
// inserts into the user's data tables.
router.get('/', (req, res) => {
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  try {
    const rows = db.prepare(`
      SELECT id, source, summary, details, created_at
      FROM activity_log
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(req.user.id, limit);
    res.json({ activity: rows });
  } catch (err) {
    console.error('[activity] error:', err);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

module.exports = router;
