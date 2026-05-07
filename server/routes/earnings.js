const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');
const { assertProfileOwnership } = require('../middleware/profileGuard');

router.use(authMiddleware);

// Round to 2 decimals so currency split math doesn't drift on the frontend
function round2(n) { return Math.round(n * 100) / 100; }

// ─────────────────────────── Tax computation ─────────────────────────────
//
// New Tax Regime FY2026-27 slabs (default for India). Same as the
// frontend's calcIncomeTax — kept inline to avoid a shared module.
function estimateAnnualSlabTax(annualIncome) {
  if (annualIncome <= 700000) return 0; // Sec 87A rebate (New regime)
  const slabs = [[300000,0],[300000,0.05],[300000,0.10],[300000,0.15],[300000,0.20],[Infinity,0.30]];
  let tax = 0, rem = annualIncome;
  for (const [size, rate] of slabs) {
    const taxable = Math.min(rem, size);
    tax += taxable * rate;
    rem -= taxable;
    if (rem <= 0) break;
  }
  return tax * 1.04; // 4% health & education cess
}

const FREQ_PER_YEAR = { 'Monthly': 12, 'Quarterly': 4, 'Annual': 1, 'Weekly': 52, 'One-time': 1 };

// Returns { gross_per_period, net_per_period, tds_per_period, gross_monthly,
//          net_monthly, tds_monthly, tax_source } for an earning.
//
// Resolution order for net amount:
//   1. actual_received (manual override) — wins
//   2. tds_rate (flat percent) — gross * (1 - tds_rate/100)
//   3. source_type === 'Salary' → estimate annual slab TDS, prorate
//   4. otherwise net = gross (no TDS assumed)
function computeTaxFields(e) {
  const periodsPerYear = FREQ_PER_YEAR[e.frequency] || 12;
  const gross = Number(e.amount) || 0;
  const annualGross = gross * periodsPerYear;
  let net, tdsPer, taxSource;

  if (e.actual_received != null && Number.isFinite(Number(e.actual_received))) {
    net = Number(e.actual_received);
    tdsPer = Math.max(0, gross - net);
    taxSource = 'manual';
  } else if (e.tds_rate != null && Number.isFinite(Number(e.tds_rate))) {
    const rate = Math.max(0, Math.min(100, Number(e.tds_rate)));
    tdsPer = gross * rate / 100;
    net = gross - tdsPer;
    taxSource = 'flat_rate';
  } else if (String(e.source_type || '').toLowerCase() === 'salary') {
    const annualTax = estimateAnnualSlabTax(annualGross);
    tdsPer = annualTax / periodsPerYear;
    net = gross - tdsPer;
    taxSource = 'slab_estimate';
  } else {
    tdsPer = 0;
    net = gross;
    taxSource = 'none';
  }

  return {
    gross_per_period: round2(gross),
    net_per_period:   round2(net),
    tds_per_period:   round2(tdsPer),
    gross_monthly:    round2(annualGross / 12),
    net_monthly:      round2((net * periodsPerYear) / 12),
    tds_monthly:      round2((tdsPer * periodsPerYear) / 12),
    tax_source:       taxSource
  };
}

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
  if (!assertProfileOwnership(req, res, profile_id)) return;

  // Manual earnings
  let q = 'SELECT * FROM earnings WHERE user_id = ? AND is_auto = 0';
  const p = [userId];
  if (profile_id) { q += ' AND (profile_id = ? OR profile_id IS NULL)'; p.push(profile_id); }
  const manualRows = db.prepare(q + ' ORDER BY source_type, source_name').all(...p);
  const manual = manualRows.map(e => {
    const base = Object.assign({}, e, { shares: loadSharesForEarning(e) });
    return Object.assign(base, computeTaxFields(base));
  });

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

  // Auto rows get the same tax-fields shape as manual ones, computed from
  // their amount + frequency + source_type so the dashboard can sum
  // gross_monthly / net_monthly uniformly.
  const enrichAuto = e => Object.assign({}, e, computeTaxFields(e));
  res.json({ earnings: [...manual, ...savingsInt.map(enrichAuto), ...loanInt.map(enrichAuto)] });
});

router.post('/', (req, res) => {
  const { source_name, source_type, amount, frequency, share_percentage, profile_id, financial_year, notes, tds_rate, actual_received } = req.body;
  if (!source_name || !amount) return res.status(400).json({ error: 'source_name and amount required' });
  if (!assertProfileOwnership(req, res, profile_id)) return;
  const r = db.prepare(
    'INSERT INTO earnings (user_id, profile_id, source_name, source_type, amount, frequency, share_percentage, financial_year, notes, tds_rate, actual_received) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    req.user.id, profile_id || null, source_name, source_type || 'Other', amount,
    frequency || 'Monthly', share_percentage || 100, financial_year || null, notes || null,
    tds_rate == null || tds_rate === '' ? null : Number(tds_rate),
    actual_received == null || actual_received === '' ? null : Number(actual_received)
  );
  res.json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const { source_name, source_type, amount, frequency, share_percentage, financial_year, notes, tds_rate, actual_received } = req.body;
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

  db.prepare(
    'UPDATE earnings SET source_name=?,source_type=?,amount=?,frequency=?,share_percentage=?,financial_year=?,notes=?,tds_rate=?,actual_received=? WHERE id=? AND user_id=? AND is_auto=0'
  ).run(
    source_name, source_type, amount, frequency, share_percentage || 100,
    financial_year || null, notes || null,
    tds_rate == null || tds_rate === '' ? null : Number(tds_rate),
    actual_received == null || actual_received === '' ? null : Number(actual_received),
    earningId, req.user.id
  );
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
