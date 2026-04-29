const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { isAgentConfigured } = require('../services/agent');

const DEFAULT_MODEL = 'claude-haiku-4-5';

// ─── GET /api/admin/agent-usage?days=30 ───────────────────────────────────────
// Aggregated agent usage for the requesting user over the last N days.
router.get('/agent-usage', (req, res) => {
  const userId = req.user.id;
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
  const sinceClause = `created_at >= datetime('now', '-' || ? || ' days')`;

  try {
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS calls,
        COALESCE(SUM(tokens_in), 0)   AS tokens_in,
        COALESCE(SUM(tokens_out), 0)  AS tokens_out,
        COALESCE(SUM(cost_usd), 0)    AS cost_usd,
        SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
      FROM agent_calls
      WHERE user_id = ? AND ${sinceClause}
    `).get(userId, days);

    const byTaskType = db.prepare(`
      SELECT
        task_type,
        COUNT(*) AS calls,
        COALESCE(SUM(tokens_in), 0)  AS tokens_in,
        COALESCE(SUM(tokens_out), 0) AS tokens_out,
        COALESCE(SUM(cost_usd), 0)   AS cost_usd
      FROM agent_calls
      WHERE user_id = ? AND ${sinceClause}
      GROUP BY task_type
      ORDER BY calls DESC
    `).all(userId, days);

    const recentErrors = db.prepare(`
      SELECT created_at, task_type, error
      FROM agent_calls
      WHERE user_id = ? AND error IS NOT NULL AND ${sinceClause}
      ORDER BY created_at DESC
      LIMIT 10
    `).all(userId, days);

    res.json({
      configured: isAgentConfigured(),
      model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      window_days: days,
      totals: {
        calls: totals.calls || 0,
        tokens_in: totals.tokens_in || 0,
        tokens_out: totals.tokens_out || 0,
        cost_usd: totals.cost_usd || 0,
        errors: totals.errors || 0
      },
      by_task_type: byTaskType,
      recent_errors: recentErrors
    });
  } catch (err) {
    console.error('[admin] agent-usage error:', err);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

// ─── GET /api/admin/agent-calls?limit=&offset=&task_type=&user_id= ────────────
// Paginated call list. Returns hash + preview only — never full prompts.
router.get('/agent-calls', (req, res) => {
  const userId = req.user.id;
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const taskType = req.query.task_type || null;
  // user_id query param is accepted but currently constrained to the requester's own id
  // (admin role check is a future TODO; for now self-scoped).
  const filterUserId = req.query.user_id ? parseInt(req.query.user_id, 10) : userId;
  const effectiveUserId = filterUserId === userId ? userId : userId;

  let where = 'WHERE user_id = ?';
  const params = [effectiveUserId];
  if (taskType) {
    where += ' AND task_type = ?';
    params.push(taskType);
  }

  try {
    const rows = db.prepare(`
      SELECT id, user_id, task_type, model,
             input_hash, input_preview, output_preview,
             tokens_in, tokens_out, cost_usd, latency_ms,
             error, created_at
      FROM agent_calls
      ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM agent_calls ${where}`).get(...params);

    res.json({
      calls: rows,
      total: totalRow.n,
      limit,
      offset
    });
  } catch (err) {
    console.error('[admin] agent-calls error:', err);
    res.status(500).json({ error: 'Database error', message: err.message });
  }
});

module.exports = router;
