const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// Round to 2 decimals so currency split math doesn't drift on the frontend
function round2(n) { return Math.round(n * 100) / 100; }

// Build the shares array (with profile name/color and computed_amount) for a given earning row
function loadSharesForEarning(earning) {
  const rows = db.prepare(`
    SELECT es.id, es.profile_id, es.share_percentage, es.notes, es.created_at,
           p.name AS profile_name, p.color AS profile_color
    FROM earning_shares es
    LEFT JOIN profiles p ON p.id = es.profile_id
    WHERE es.earning_id = ?
    ORDER BY es.id ASC
  `).all(earning.id);
  return rows.map(s => ({
    id: s.id,
    profile_id: s.profile_id,
    profile_name: s.profile_name,
    profile_color: s.profile_color,
    share_percentage: s.share_percentage,
    notes: s.notes,
    computed_amount: round2((earning.amount || 0) * (s.share_percentage || 0) / 100),
    created_at: s.created_at
  }));
}

// Sum of (earnings.share_percentage if non-null) + all earning_shares for that earning,
// optionally excluding a specific share row (for updates) and optionally adding a candidate value.
// Used to enforce "total share <= 100%".
function totalSharePercentage(earningId, { excludeShareId = null, addCandidate = 0 } = {}) {
  const earning = db.prepare('SELECT share_percentage FROM earnings WHERE id = ?').get(earningId);
  const primary = earning && earning.share_percentage != null ? Number(earning.share_percentage) : 0;
  let q = 'SELECT COALESCE(SUM(share_percentage), 0) AS total FROM earning_shares WHERE earning_id = ?';
  const params = [earningId];
  if (excludeShareId) { q += ' AND id != ?'; params.push(excludeShareId); }
  const row = db.prepare(q).get(...params);
  return primary + Number(row.total || 0) + Number(addCandidate || 0);
}

// Confirms the earning belongs to the current user AND is a manual (user-entered) row.
// Auto-derived earnings (savings interest, hand-loan interest) cannot have shares.
function getOwnedManualEarning(earningId, userId) {
  return db.prepare('SELECT * FROM earnings WHERE id = ? AND user_id = ? AND is_auto = 0').get(earningId, userId);
}

// GET earnings — manual entries + auto-populated interest from savings & hand loans
router.get('/', (req, res) => {
  const userId = req.user.id;
  const { profile_id } = req.query;

  // Manual earnings
  let q = 'SELECT * FROM earnings WHERE user_id = ? AND is_auto = 0';
  const p = [userId];
  if (profile_id) { q += ' AND (profile_id = ? OR profile_id IS NULL)'; p.push(profile_id); }
  const manualRows = db.prepare(q + ' ORDER BY source_type, source_name').all(...p);
  const manual = manualRows.map(e => Object.assign({}, e, { shares: loadSharesForEarning(e) }));

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
  const earningId = Number(req.params.id);
  const earning = getOwnedManualEarning(earningId, req.user.id);
  if (!earning) return res.status(404).json({ error: 'Earning not found' });

  // Sum-check: changing the primary share_percentage must keep the grand total ≤ 100.
  const newPrimary = share_percentage == null ? earning.share_percentage : Number(share_percentage);
  const otherShares = db.prepare('SELECT COALESCE(SUM(share_percentage), 0) AS total FROM earning_shares WHERE earning_id = ?').get(earningId);
  const projectedTotal = (newPrimary || 0) + Number(otherShares.total || 0);
  if (projectedTotal > 100 + 1e-6) {
    return res.status(400).json({ error: 'Share total would be ' + Math.round(projectedTotal) + '% (max 100)' });
  }

  db.prepare('UPDATE earnings SET source_name=?,source_type=?,amount=?,frequency=?,share_percentage=?,financial_year=?,notes=? WHERE id=? AND user_id=? AND is_auto=0').run(source_name, source_type, amount, frequency, share_percentage || 100, financial_year || null, notes || null, earningId, req.user.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM earnings WHERE id=? AND user_id=? AND is_auto=0').run(req.params.id, req.user.id);
  res.json({ success: true });
});

// ─── EARNING SHARES ────────────────────────────────────────────────────
// Cross-profile income sharing: an earning row owned by one user may be
// allocated across multiple profiles (e.g. rental income split 60/40 between
// "Self" and "Mother"). Auto-derived earnings (is_auto=1) are not shareable.

// GET /:earningId/shares — list shares for a manual earning, joined with profile name/color
router.get('/:earningId/shares', (req, res) => {
  const earningId = Number(req.params.earningId);
  const earning = getOwnedManualEarning(earningId, req.user.id);
  if (!earning) return res.status(404).json({ error: 'Earning not found' });
  res.json({ shares: loadSharesForEarning(earning) });
});

// POST /:earningId/shares — add a profile share to an earning
router.post('/:earningId/shares', (req, res) => {
  const earningId = Number(req.params.earningId);
  const earning = getOwnedManualEarning(earningId, req.user.id);
  if (!earning) return res.status(404).json({ error: 'Earning not found' });

  const { profile_id, share_percentage, notes } = req.body || {};
  if (!profile_id) return res.status(400).json({ error: 'profile_id required' });
  const pct = Number(share_percentage);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    return res.status(400).json({ error: 'share_percentage must be a number > 0 and ≤ 100' });
  }

  // Profile must belong to current user.
  const profile = db.prepare('SELECT id FROM profiles WHERE id = ? AND user_id = ?').get(profile_id, req.user.id);
  if (!profile) return res.status(400).json({ error: 'profile_id is not owned by current user' });

  // Sum-check: primary share + existing shares + this new share ≤ 100.
  const projectedTotal = totalSharePercentage(earningId, { addCandidate: pct });
  if (projectedTotal > 100 + 1e-6) {
    return res.status(400).json({ error: 'Share total would be ' + Math.round(projectedTotal) + '% (max 100)' });
  }

  try {
    const r = db.prepare('INSERT INTO earning_shares (earning_id, profile_id, share_percentage, notes) VALUES (?,?,?,?)')
      .run(earningId, profile_id, pct, notes || null);
    const created = db.prepare(`
      SELECT es.id, es.earning_id, es.profile_id, es.share_percentage, es.notes, es.created_at,
             p.name AS profile_name, p.color AS profile_color
      FROM earning_shares es
      LEFT JOIN profiles p ON p.id = es.profile_id
      WHERE es.id = ?
    `).get(r.lastInsertRowid);
    res.json({
      id: created.id,
      earning_id: created.earning_id,
      profile_id: created.profile_id,
      profile_name: created.profile_name,
      profile_color: created.profile_color,
      share_percentage: created.share_percentage,
      notes: created.notes,
      computed_amount: round2((earning.amount || 0) * (created.share_percentage || 0) / 100),
      created_at: created.created_at
    });
  } catch (err) {
    if (err && /UNIQUE/i.test(err.message)) {
      return res.status(409).json({ error: 'This profile already has a share on this earning' });
    }
    throw err;
  }
});

// PUT /:earningId/shares/:shareId — update share_percentage / notes
router.put('/:earningId/shares/:shareId', (req, res) => {
  const earningId = Number(req.params.earningId);
  const shareId = Number(req.params.shareId);
  const earning = getOwnedManualEarning(earningId, req.user.id);
  if (!earning) return res.status(404).json({ error: 'Earning not found' });

  const existing = db.prepare('SELECT * FROM earning_shares WHERE id = ? AND earning_id = ?').get(shareId, earningId);
  if (!existing) return res.status(404).json({ error: 'Share not found' });

  const { share_percentage, notes } = req.body || {};
  const pct = share_percentage == null ? existing.share_percentage : Number(share_percentage);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    return res.status(400).json({ error: 'share_percentage must be a number > 0 and ≤ 100' });
  }

  // Sum-check: exclude this row's old value, then add the new candidate value.
  const projectedTotal = totalSharePercentage(earningId, { excludeShareId: shareId, addCandidate: pct });
  if (projectedTotal > 100 + 1e-6) {
    return res.status(400).json({ error: 'Share total would be ' + Math.round(projectedTotal) + '% (max 100)' });
  }

  db.prepare('UPDATE earning_shares SET share_percentage = ?, notes = ? WHERE id = ? AND earning_id = ?')
    .run(pct, notes !== undefined ? notes : existing.notes, shareId, earningId);
  res.json({ success: true });
});

// DELETE /:earningId/shares/:shareId
router.delete('/:earningId/shares/:shareId', (req, res) => {
  const earningId = Number(req.params.earningId);
  const shareId = Number(req.params.shareId);
  const earning = getOwnedManualEarning(earningId, req.user.id);
  if (!earning) return res.status(404).json({ error: 'Earning not found' });
  db.prepare('DELETE FROM earning_shares WHERE id = ? AND earning_id = ?').run(shareId, earningId);
  res.json({ success: true });
});

module.exports = router;
