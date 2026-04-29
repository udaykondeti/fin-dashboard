const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', (req, res) => {
  const { profile_id } = req.query;
  let q = 'SELECT * FROM scheduled_payments WHERE user_id = ?';
  const p = [req.user.id];
  if (profile_id) { q += ' AND (profile_id = ? OR profile_id IS NULL)'; p.push(profile_id); }
  res.json({ scheduled_payments: db.prepare(q + ' ORDER BY next_due_date, name').all(...p) });
});

router.post('/', (req, res) => {
  const { name, amount, frequency, category, next_due_date, auto_debit, profile_id, notes } = req.body;
  if (!name || !amount) return res.status(400).json({ error: 'Name and amount are required' });
  const r = db.prepare('INSERT INTO scheduled_payments (user_id, profile_id, name, amount, frequency, category, next_due_date, auto_debit, notes) VALUES (?,?,?,?,?,?,?,?,?)').run(req.user.id, profile_id || null, name, amount, frequency || 'Monthly', category || 'Other', next_due_date || null, auto_debit ? 1 : 0, notes || null);
  res.json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const { name, amount, frequency, category, next_due_date, auto_debit, is_active, notes } = req.body;
  db.prepare('UPDATE scheduled_payments SET name=?,amount=?,frequency=?,category=?,next_due_date=?,auto_debit=?,is_active=?,notes=? WHERE id=? AND user_id=?').run(name, amount, frequency, category, next_due_date || null, auto_debit ? 1 : 0, is_active !== false ? 1 : 0, notes || null, req.params.id, req.user.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM scheduled_payments WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
