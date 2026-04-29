const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');
const { assertProfileOwnership } = require('../middleware/profileGuard');

router.use(authMiddleware);

router.get('/', (req, res) => {
  res.json({ nps_accounts: db.prepare('SELECT * FROM nps_accounts WHERE user_id = ? ORDER BY tier').all(req.user.id) });
});

const VALID_TIERS = ['Tier I', 'Tier II'];

function validateNps(body, { partial } = {}) {
  const { tier, total_invested, current_value, equity_pct, bonds_pct, govt_pct } = body;
  if (!partial && (tier === undefined || tier === null || tier === '')) return 'tier is required';
  if (tier !== undefined && tier !== null && tier !== '' && !VALID_TIERS.includes(tier)) return 'tier must be "Tier I" or "Tier II"';
  for (const [k, v] of [['total_invested', total_invested], ['current_value', current_value]]) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return `${k} must be a non-negative number`;
  }
  for (const [k, v] of [['equity_pct', equity_pct], ['bonds_pct', bonds_pct], ['govt_pct', govt_pct]]) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) return `${k} must be between 0 and 100`;
  }
  if (equity_pct != null && bonds_pct != null && govt_pct != null) {
    const sum = Number(equity_pct) + Number(bonds_pct) + Number(govt_pct);
    if (Math.abs(sum - 100) > 0.01) return 'equity_pct + bonds_pct + govt_pct must sum to 100';
  }
  return null;
}

router.post('/', (req, res) => {
  const err = validateNps(req.body);
  if (err) return res.status(400).json({ error: err });
  const { pran, tier, total_invested, current_value, equity_pct, bonds_pct, govt_pct, profile_id, notes } = req.body;
  if (!assertProfileOwnership(req, res, profile_id)) return;
  const r = db.prepare('INSERT INTO nps_accounts (user_id, profile_id, pran, tier, total_invested, current_value, equity_pct, bonds_pct, govt_pct, notes) VALUES (?,?,?,?,?,?,?,?,?,?)').run(req.user.id, profile_id || null, pran || null, tier, Number(total_invested) || 0, Number(current_value) || 0, equity_pct == null ? 75 : Number(equity_pct), bonds_pct == null ? 15 : Number(bonds_pct), govt_pct == null ? 10 : Number(govt_pct), notes || null);
  res.json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const err = validateNps(req.body, { partial: true });
  if (err) return res.status(400).json({ error: err });
  const { pran, tier, total_invested, current_value, equity_pct, bonds_pct, govt_pct, notes } = req.body;
  db.prepare('UPDATE nps_accounts SET pran=?,tier=?,total_invested=?,current_value=?,equity_pct=?,bonds_pct=?,govt_pct=?,notes=? WHERE id=? AND user_id=?').run(pran || null, tier, total_invested, current_value, equity_pct, bonds_pct, govt_pct, notes || null, req.params.id, req.user.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM nps_accounts WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ success: true });
});

module.exports = router;
