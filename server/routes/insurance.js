const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');
const { assertProfileOwnership } = require('../middleware/profileGuard');

router.use(authMiddleware);

router.get('/', (req, res) => {
  const { profile_id } = req.query;
  if (!assertProfileOwnership(req, res, profile_id)) return;
  let q = 'SELECT * FROM insurance_policies WHERE user_id = ?';
  const p = [req.user.id];
  if (profile_id) { q += ' AND (profile_id = ? OR profile_id IS NULL)'; p.push(profile_id); }
  res.json({ insurance_policies: db.prepare(q + ' ORDER BY next_due_date').all(...p) });
});

router.post('/', (req, res) => {
  const { policy_name, insurer, policy_type, premium_amount, premium_frequency, cover_amount, start_date, maturity_date, next_due_date, nominee, profile_id, notes } = req.body;
  if (!policy_name || !insurer || !premium_amount) return res.status(400).json({ error: 'policy_name, insurer and premium_amount are required' });
  if (!assertProfileOwnership(req, res, profile_id)) return;
  const r = db.prepare('INSERT INTO insurance_policies (user_id, profile_id, policy_name, insurer, policy_type, premium_amount, premium_frequency, cover_amount, start_date, maturity_date, next_due_date, nominee, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(req.user.id, profile_id || null, policy_name, insurer, policy_type || 'Term', premium_amount, premium_frequency || 'Annual', cover_amount || 0, start_date || null, maturity_date || null, next_due_date || null, nominee || null, notes || null);
  res.json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const { policy_name, insurer, policy_type, premium_amount, premium_frequency, cover_amount, start_date, maturity_date, next_due_date, nominee, notes } = req.body;
  db.prepare('UPDATE insurance_policies SET policy_name=?,insurer=?,policy_type=?,premium_amount=?,premium_frequency=?,cover_amount=?,start_date=?,maturity_date=?,next_due_date=?,nominee=?,notes=? WHERE id=? AND user_id=?').run(policy_name, insurer, policy_type, premium_amount, premium_frequency, cover_amount || 0, start_date || null, maturity_date || null, next_due_date || null, nominee || null, notes || null, req.params.id, req.user.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM insurance_policies WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
