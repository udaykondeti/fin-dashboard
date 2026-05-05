const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { isAgentConfigured } = require('../services/agent');

const DEFAULT_MODEL = 'claude-haiku-4-5';

// ─── GET /api/admin/agent-usage?days=30 ───────────────────────────────────────
// Aggregated agent usage for the requesting user over the last N days.
router.get('/agent-usage', (req, res) => {
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
  const filterUserId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
  // Admins can scope to a specific user via ?user_id=, or aggregate across all.
  const userClause = filterUserId ? 'user_id = ? AND ' : '';
  const sinceClause = `created_at >= datetime('now', '-' || ? || ' days')`;
  const baseParams = filterUserId ? [filterUserId] : [];

  try {
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS calls,
        COALESCE(SUM(tokens_in), 0)   AS tokens_in,
        COALESCE(SUM(tokens_out), 0)  AS tokens_out,
        COALESCE(SUM(cost_usd), 0)    AS cost_usd,
        SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
      FROM agent_calls
      WHERE ${userClause}${sinceClause}
    `).get(...baseParams, days);

    const byTaskType = db.prepare(`
      SELECT
        task_type,
        COUNT(*) AS calls,
        COALESCE(SUM(tokens_in), 0)  AS tokens_in,
        COALESCE(SUM(tokens_out), 0) AS tokens_out,
        COALESCE(SUM(cost_usd), 0)   AS cost_usd
      FROM agent_calls
      WHERE ${userClause}${sinceClause}
      GROUP BY task_type
      ORDER BY calls DESC
    `).all(...baseParams, days);

    const recentErrors = db.prepare(`
      SELECT created_at, task_type, error
      FROM agent_calls
      WHERE ${userClause}error IS NOT NULL AND ${sinceClause}
      ORDER BY created_at DESC
      LIMIT 10
    `).all(...baseParams, days);

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
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── GET /api/admin/agent-calls?limit=&offset=&task_type=&user_id= ────────────
// Paginated call list. Returns hash + preview only — never full prompts.
router.get('/agent-calls', (req, res) => {
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const taskType = req.query.task_type || null;
  // Route is admin-gated, so an admin may filter by any user_id. Omitting it
  // returns calls across all users.
  const filterUserId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;

  let where = 'WHERE 1=1';
  const params = [];
  if (filterUserId) {
    where += ' AND user_id = ?';
    params.push(filterUserId);
  }
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

    // Strip prompt previews unless explicitly requested with ?include_previews=1
    // and limited to a single user — defends against bulk exfil of cross-user
    // prompt content even by an admin token.
    const includePreviews = req.query.include_previews === '1' && filterUserId;
    const sanitised = rows.map(r => {
      const o = Object.assign({}, r);
      if (!includePreviews) { delete o.input_preview; delete o.output_preview; }
      return o;
    });

    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM agent_calls ${where}`).get(...params);

    res.json({
      calls: sanitised,
      total: totalRow.n,
      limit,
      offset
    });
  } catch (err) {
    console.error('[admin] agent-calls error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
