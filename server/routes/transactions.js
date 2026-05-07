const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// GET /api/transactions?limit=100&offset=0&category=&source=
router.get('/', (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const where = ['user_id = ?'];
    const params = [userId];
    if (req.query.category) { where.push('category = ?'); params.push(req.query.category); }
    if (req.query.source)   { where.push('source = ?');   params.push(req.query.source);   }
    const rows = db.prepare(
      `SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);
    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where.join(' AND ')}`).get(...params);
    res.json({ transactions: rows, total: totalRow.n, limit, offset });
  } catch (err) {
    console.error('[transactions] list error:', err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// POST /api/transactions
router.post('/', (req, res) => {
  try {
    const userId = req.user.id;
    const { date, description, amount, direction, category, source, source_ref, linked_table, linked_id, notes, profile_id } = req.body || {};
    if (!date || !description || amount == null) {
      return res.status(400).json({ error: 'date, description, amount required' });
    }
    const dir = direction === 'credit' ? 'credit' : 'debit';
    const src = source || 'manual';
    const r = db.prepare(`
      INSERT INTO transactions (user_id, profile_id, date, description, amount, direction, category, source, source_ref, linked_table, linked_id, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      userId, profile_id || null, date, String(description).slice(0, 300),
      Number(amount), dir, category || null, src,
      source_ref || null, linked_table || null, linked_id || null, notes || null
    );
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Duplicate transaction (same source_ref already exists)' });
    }
    console.error('[transactions] create error:', err);
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

// DELETE /api/transactions/:id
router.delete('/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete' });
  }
});

module.exports = router;
