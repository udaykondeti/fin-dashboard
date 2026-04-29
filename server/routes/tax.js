const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// GET advance tax payments (optionally filtered by assessment year)
router.get('/advance', (req, res) => {
  const { year } = req.query;
  let q = 'SELECT * FROM advance_tax_payments WHERE user_id = ?';
  const p = [req.user.id];
  if (year) { q += ' AND assessment_year = ?'; p.push(year); }
  res.json({ advance_tax: db.prepare(q + ' ORDER BY date_paid').all(...p) });
});

router.post('/advance', (req, res) => {
  const { assessment_year, installment, amount, date_paid, profile_id, notes } = req.body;
  if (!assessment_year || !installment || !amount || !date_paid) return res.status(400).json({ error: 'assessment_year, installment, amount and date_paid are required' });
  const r = db.prepare('INSERT INTO advance_tax_payments (user_id, profile_id, assessment_year, installment, amount, date_paid, notes) VALUES (?,?,?,?,?,?,?)').run(req.user.id, profile_id || null, assessment_year, installment, amount, date_paid, notes || null);
  res.json({ id: r.lastInsertRowid });
});

router.put('/advance/:id', (req, res) => {
  const { assessment_year, installment, amount, date_paid, notes } = req.body;
  db.prepare('UPDATE advance_tax_payments SET assessment_year=?,installment=?,amount=?,date_paid=?,notes=? WHERE id=? AND user_id=?').run(assessment_year, installment, amount, date_paid, notes || null, req.params.id, req.user.id);
  res.json({ success: true });
});

router.delete('/advance/:id', (req, res) => {
  db.prepare('DELETE FROM advance_tax_payments WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
