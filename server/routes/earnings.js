const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// GET earnings — manual entries + auto-populated interest from savings & hand loans
router.get('/', (req, res) => {
  const userId = req.user.id;
  const { profile_id } = req.query;

  // Manual earnings
  let q = 'SELECT * FROM earnings WHERE user_id = ? AND is_auto = 0';
  const p = [userId];
  if (profile_id) { q += ' AND (profile_id = ? OR profile_id IS NULL)'; p.push(profile_id); }
  const manual = db.prepare(q + ' ORDER BY source_type, source_name').all(...p);

  // Auto: savings account interest
  const savings = db.prepare('SELECT * FROM savings_accounts WHERE user_id = ?').all(userId);
  const savingsInt = savings.map(s => ({
    id: 'sav_' + s.id,
    source_name: s.bank_name + ' Interest',
    source_type: 'Interest',
    amount: Math.round(s.balance * s.interest_rate / 100),
    frequency: 'Annual',
    share_percentage: 100,
    is_auto: 1,
    linked_type: 'savings_account',
    linked_id: s.id,
    notes: s.interest_rate + '% p.a. on ₹' + s.balance.toLocaleString('en-IN')
  }));

  // Auto: hand loans given with interest > 0
  const handLoans = db.prepare("SELECT * FROM hand_loans WHERE user_id = ? AND direction='given' AND interest_rate > 0 AND status='active'").all(userId);
  const loanInt = handLoans.map(l => ({
    id: 'hl_' + l.id,
    source_name: 'Interest from ' + l.person_name,
    source_type: 'Interest',
    amount: Math.round(l.amount * l.interest_rate / 100),
    frequency: 'Annual',
    share_percentage: 100,
    is_auto: 1,
    linked_type: 'hand_loan',
    linked_id: l.id,
    notes: l.interest_rate + '% p.a. on ₹' + l.amount.toLocaleString('en-IN') + ' lent to ' + l.person_name
  }));

  res.json({ earnings: [...manual, ...savingsInt, ...loanInt] });
});

router.post('/', (req, res) => {
  const { source_name, source_type, amount, frequency, share_percentage, profile_id, financial_year, notes } = req.body;
  if (!source_name || !amount) return res.status(400).json({ error: 'source_name and amount required' });
  const r = db.prepare('INSERT INTO earnings (user_id, profile_id, source_name, source_type, amount, frequency, share_percentage, financial_year, notes) VALUES (?,?,?,?,?,?,?,?,?)').run(req.user.id, profile_id || null, source_name, source_type || 'Other', amount, frequency || 'Monthly', share_percentage || 100, financial_year || null, notes || null);
  res.json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const { source_name, source_type, amount, frequency, share_percentage, financial_year, notes } = req.body;
  db.prepare('UPDATE earnings SET source_name=?,source_type=?,amount=?,frequency=?,share_percentage=?,financial_year=?,notes=? WHERE id=? AND user_id=? AND is_auto=0').run(source_name, source_type, amount, frequency, share_percentage || 100, financial_year || null, notes || null, req.params.id, req.user.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM earnings WHERE id=? AND user_id=? AND is_auto=0').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
