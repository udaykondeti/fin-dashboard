const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', (req, res) => {
  res.json({ nps_accounts: db.prepare('SELECT * FROM nps_accounts WHERE user_id = ? ORDER BY tier').all(req.user.id) });
});

router.post('/', (req, res) => {
  const { pran, tier, total_invested, current_value, equity_pct, bonds_pct, govt_pct, profile_id, notes } = req.body;
  const r = db.prepare('INSERT INTO nps_accounts (user_id, profile_id, pran, tier, total_invested, current_value, equity_pct, bonds_pct, govt_pct, notes) VALUES (?,?,?,?,?,?,?,?,?,?)').run(req.user.id, profile_id || null, pran || null, tier || 'Tier I', total_invested || 0, current_value || 0, equity_pct || 75, bonds_pct || 15, govt_pct || 10, notes || null);
  res.json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const { pran, tier, total_invested, current_value, equity_pct, bonds_pct, govt_pct, notes } = req.body;
  db.prepare('UPDATE nps_accounts SET pran=?,tier=?,total_invested=?,current_value=?,equity_pct=?,bonds_pct=?,govt_pct=?,notes=? WHERE id=? AND user_id=?').run(pran || null, tier, total_invested, current_value, equity_pct, bonds_pct, govt_pct, notes || null, req.params.id, req.user.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM nps_accounts WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
