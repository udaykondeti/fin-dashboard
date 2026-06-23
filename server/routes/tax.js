const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');
const { assertProfileOwnership } = require('../middleware/profileGuard');

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
  if (!assertProfileOwnership(req, res, profile_id)) return;
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

// ─── ITR Filing Summary ────────────────────────────────────────────────────────
// Aggregates all financial data into an ITR-ready breakdown for a given FY.
// Default FY: the most recently completed Indian financial year.

const FREQ_MULT = { Monthly: 12, Quarterly: 4, Annual: 1, Weekly: 52, 'One-time': 1, 'Half-Yearly': 2, 'Semi-Annual': 2 };

function annualize(amount, frequency, sharePct) {
  return (Number(amount) || 0) * (FREQ_MULT[frequency] || 12) * ((Number(sharePct) || 100) / 100);
}

// New regime slabs (same as frontend calcIncomeTax, valid from FY2024-25 onwards)
function taxNew(income) {
  if (income <= 700000) return 0;
  const slabs = [[300000,0],[300000,0.05],[300000,0.10],[300000,0.15],[300000,0.20],[Infinity,0.30]];
  let tax = 0, rem = income;
  for (const [sz, r] of slabs) { const c = Math.min(rem, sz); tax += c * r; rem -= c; if (rem <= 0) break; }
  return Math.round(tax * 1.04);
}

// Old regime slabs (FY2024-25 onwards)
function taxOld(income) {
  if (income <= 250000) return 0;
  const slabs = [[250000,0],[250000,0.05],[500000,0.20],[Infinity,0.30]];
  let tax = 0, rem = income;
  for (const [sz, r] of slabs) { const c = Math.min(rem, sz); tax += c * r; rem -= c; if (rem <= 0) break; }
  if (income <= 500000) tax = Math.max(0, tax - 12500); // 87A rebate
  return Math.round(tax * 1.04);
}

router.get('/itr-summary', (req, res) => {
  const userId = req.user.id;

  // Determine default FY: last completed Indian financial year
  const ist = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000);
  const istMonth = ist.getUTCMonth() + 1;
  const istYear  = ist.getUTCFullYear();
  const fyStart  = istMonth >= 4 ? istYear - 1 : istYear - 2; // month<4 = we're in fyStart+1 year still
  const defaultFY = `${fyStart}-${String(fyStart + 1).slice(-2)}`;

  const fy  = req.query.fy || defaultFY;          // "2025-26"
  const [s]  = fy.split('-').map(Number);          // 2025
  const ay   = `${s + 1}-${String(s + 2).slice(-2)}`; // "2026-27"

  // ── Income ────────────────────────────────────────────────────────────────
  // Salary
  const salaryRows = db.prepare(`SELECT * FROM earnings WHERE user_id = ? AND source_type = 'Salary' AND is_auto = 0`).all(userId);
  let salaryGross = 0, salaryTDS = 0;
  salaryRows.forEach(e => {
    const gross = annualize(e.amount, e.frequency, e.share_percentage);
    salaryGross += gross;
    if (e.actual_received != null) salaryTDS += Math.max(0, annualize(e.amount, e.frequency, e.share_percentage) - annualize(e.actual_received, e.frequency, e.share_percentage));
    else if (e.tds_rate != null) salaryTDS += gross * (Number(e.tds_rate) / 100);
  });

  // Other earnings (business, freelance, interest, dividend, etc.)
  const otherRows = db.prepare(`SELECT * FROM earnings WHERE user_id = ? AND source_type != 'Salary' AND is_auto = 0`).all(userId);
  let otherIncome = 0, otherTDS = 0;
  otherRows.forEach(e => {
    const gross = annualize(e.amount, e.frequency, e.share_percentage);
    otherIncome += gross;
    if (e.tds_rate != null) otherTDS += gross * (Number(e.tds_rate) / 100);
  });

  // Rental income (active agreements)
  const rentals = db.prepare(`SELECT ra.rent_amount FROM rental_agreements ra WHERE ra.user_id = ? AND ra.status = 'active'`).all(userId);
  const rentalGross = rentals.reduce((s, r) => s + (Number(r.rent_amount) || 0) * 12, 0);
  const rentalDeduction24a = Math.round(rentalGross * 0.30); // Sec 24(a) standard deduction
  const rentalNetIncome    = rentalGross - rentalDeduction24a;

  // FD interest (annual interest on principal)
  const fds = db.prepare('SELECT principal, interest_rate FROM fixed_deposits WHERE user_id = ?').all(userId);
  const fdInterest = Math.round(fds.reduce((s, fd) => s + (Number(fd.principal) || 0) * (Number(fd.interest_rate) || 0) / 100, 0));
  const fdTDS      = fdInterest > 40000 ? Math.round(fdInterest * 0.10) : 0;

  // Savings account interest
  const savAcc = db.prepare('SELECT balance, interest_rate FROM savings_accounts WHERE user_id = ?').all(userId);
  const savingsInterest = Math.round(savAcc.reduce((s, a) => s + (Number(a.balance) || 0) * (Number(a.interest_rate) || 3.5) / 100, 0));

  const grossTotalIncome = Math.round(salaryGross + otherIncome + rentalNetIncome + fdInterest + savingsInterest);
  const totalTDS         = Math.round(salaryTDS + otherTDS + fdTDS);

  // ── Deductions (Old Regime, Chapter VI-A) ─────────────────────────────────
  // 80C: ELSS SIP + life insurance premium + NPS Tier-I invested (max ₹1.5L)
  const elssMFs = db.prepare(`SELECT sip_amount FROM mutual_funds WHERE user_id = ? AND (fund_type = 'ELSS' OR LOWER(fund_name) LIKE '%elss%' OR LOWER(fund_name) LIKE '%tax sav%')`).all(userId);
  const elss80C = Math.round(elssMFs.reduce((s, m) => s + (Number(m.sip_amount) || 0) * 12, 0));

  const lifeIns = db.prepare(`SELECT premium_amount, premium_frequency FROM insurance_policies WHERE user_id = ? AND policy_type IN ('Term','Life','Endowment','ULIP','Whole Life')`).all(userId);
  const lifePremium = Math.round(lifeIns.reduce((s, p) => s + annualize(p.premium_amount, p.premium_frequency, 100), 0));

  const npsT1 = db.prepare(`SELECT total_invested FROM nps_accounts WHERE user_id = ? AND tier = 'Tier I'`).all(userId);
  const npsInvested = Math.round(npsT1.reduce((s, n) => s + (Number(n.total_invested) || 0), 0));

  const sec80C_raw     = elss80C + lifePremium + npsInvested;
  const sec80C_allowed = Math.min(sec80C_raw, 150000);

  // 80CCD(1B): NPS above 80C limit, up to ₹50K additional
  const nps80CCD1B = Math.min(Math.max(0, npsInvested - 150000), 50000);

  // 80D: health insurance premium (self + family, max ₹25K; not distinguishing senior parents here)
  const healthIns = db.prepare(`SELECT premium_amount, premium_frequency FROM insurance_policies WHERE user_id = ? AND policy_type IN ('Health','Mediclaim')`).all(userId);
  const healthPremium  = Math.round(healthIns.reduce((s, p) => s + annualize(p.premium_amount, p.premium_frequency, 100), 0));
  const sec80D_allowed = Math.min(healthPremium, 25000);

  // Sec 24(b): home loan interest (max ₹2L for self-occupied)
  const homeLoans = db.prepare(`SELECT outstanding_amount, interest_rate FROM loans WHERE user_id = ? AND loan_type = 'Home Loan'`).all(userId);
  const homeLoanInterest = Math.round(homeLoans.reduce((s, l) => s + (Number(l.outstanding_amount) || 0) * (Number(l.interest_rate) || 0) / 100, 0));
  const sec24b_allowed   = Math.min(homeLoanInterest, 200000);

  // 80TTA: savings interest deduction (max ₹10K)
  const sec80TTA = Math.min(savingsInterest, 10000);

  const totalDeductionsOld = sec80C_allowed + nps80CCD1B + sec80D_allowed + sec24b_allowed + sec80TTA;

  // ── Tax computation ────────────────────────────────────────────────────────
  const stdDedNew  = Math.min(75000, salaryGross);  // Sec 16(ia) new regime
  const stdDedOld  = Math.min(50000, salaryGross);  // Sec 16(ia) old regime
  const taxableNew = Math.max(0, grossTotalIncome - stdDedNew);
  const taxableOld = Math.max(0, grossTotalIncome - stdDedOld - totalDeductionsOld);

  const taxLiabilityNew = taxNew(taxableNew);
  const taxLiabilityOld = taxOld(taxableOld);
  const betterRegime    = taxLiabilityNew <= taxLiabilityOld ? 'new' : 'old';
  const recommendedTax  = Math.min(taxLiabilityNew, taxLiabilityOld);

  // TDS + advance tax already paid
  const advRows     = db.prepare(`SELECT amount FROM advance_tax_payments WHERE user_id = ? AND assessment_year = ?`).all(userId, ay);
  const advanceTaxPaid = Math.round(advRows.reduce((s, r) => s + (Number(r.amount) || 0), 0));
  const totalCredits   = totalTDS + advanceTaxPaid;

  const balanceDue = Math.max(0, recommendedTax - totalCredits);
  const refundDue  = Math.max(0, totalCredits - recommendedTax);

  res.json({
    fy, ay,
    income: {
      salary:           Math.round(salaryGross),
      other:            Math.round(otherIncome),
      rental_gross:     Math.round(rentalGross),
      rental_deduction: rentalDeduction24a,
      rental_net:       Math.round(rentalNetIncome),
      fd_interest:      fdInterest,
      savings_interest: savingsInterest,
      gross_total:      grossTotalIncome
    },
    deductions: {
      std_deduction_new: stdDedNew,
      std_deduction_old: stdDedOld,
      sec80C: {
        total: sec80C_raw,
        allowed: sec80C_allowed,
        elss: elss80C,
        life_insurance: lifePremium,
        nps_tier1: npsInvested
      },
      sec80CCD1B: nps80CCD1B,
      sec80D: { total: healthPremium, allowed: sec80D_allowed },
      sec24b: { interest: homeLoanInterest, allowed: sec24b_allowed },
      sec80TTA,
      total_old_regime: totalDeductionsOld
    },
    tax: {
      taxable_new:        taxableNew,
      taxable_old:        taxableOld,
      liability_new:      taxLiabilityNew,
      liability_old:      taxLiabilityOld,
      better_regime:      betterRegime,
      recommended:        recommendedTax,
      tds_deducted:       totalTDS,
      advance_tax_paid:   advanceTaxPaid,
      total_credits:      totalCredits,
      balance_due:        balanceDue,
      refund_due:         refundDue
    }
  });
});

module.exports = router;
