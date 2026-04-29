const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');
const { assertProfileOwnership } = require('../middleware/profileGuard');

router.use(authMiddleware);

router.get('/', (req, res) => {
  const { profile_id } = req.query;
  if (!assertProfileOwnership(req, res, profile_id)) return;
  let q = 'SELECT * FROM savings_accounts WHERE user_id = ?';
  const p = [req.user.id];
  if (profile_id) { q += ' AND (profile_id = ? OR profile_id IS NULL)'; p.push(profile_id); }
  res.json({ savings_accounts: db.prepare(q + ' ORDER BY bank_name').all(...p) });
});

router.post('/', (req, res) => {
  const { bank_name, account_type, account_number, balance, interest_rate, profile_id, notes } = req.body;
  if (!bank_name) return res.status(400).json({ error: 'Bank name required' });
  if (!assertProfileOwnership(req, res, profile_id)) return;
  const r = db.prepare('INSERT INTO savings_accounts (user_id, profile_id, bank_name, account_type, account_number, balance, interest_rate, notes) VALUES (?,?,?,?,?,?,?,?)').run(req.user.id, profile_id || null, bank_name, account_type || 'Savings', account_number || null, balance || 0, interest_rate || 3.5, notes || null);
  res.json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const { bank_name, account_type, account_number, balance, interest_rate, notes } = req.body;
  db.prepare('UPDATE savings_accounts SET bank_name=?,account_type=?,account_number=?,balance=?,interest_rate=?,notes=? WHERE id=? AND user_id=?').run(bank_name, account_type, account_number || null, balance, interest_rate, notes || null, req.params.id, req.user.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM savings_accounts WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
