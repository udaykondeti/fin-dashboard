const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// ── Helpers ────────────────────────────────────────────────────────────────

function ownedProperty(userId, propId) {
  return db.prepare('SELECT * FROM properties WHERE id = ? AND user_id = ?').get(propId, userId);
}

// ── Properties CRUD ────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*,
      (SELECT rent_amount FROM rental_agreements WHERE property_id = p.id AND status = 'active' LIMIT 1) AS active_rent,
      (SELECT COUNT(*) FROM rental_agreements WHERE property_id = p.id AND status = 'active') AS active_tenants
    FROM properties p
    WHERE p.user_id = ?
    ORDER BY p.created_at DESC
  `).all(req.user.id);
  res.json({ properties: rows });
});

router.post('/', (req, res) => {
  const {
    name, property_type, address, city, state,
    area, area_unit, purchase_price, purchase_date,
    current_value, ownership_percentage, co_owner_name,
    registration_number, loan_outstanding, loan_interest_rate,
    profile_id, notes
  } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });

  const result = db.prepare(`
    INSERT INTO properties
      (user_id, profile_id, name, property_type, address, city, state,
       area, area_unit, purchase_price, purchase_date, current_value,
       ownership_percentage, co_owner_name, registration_number,
       loan_outstanding, loan_interest_rate, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.user.id, profile_id || null, name,
    property_type || 'Flat', address || null, city || null, state || null,
    area || null, area_unit || 'sqft',
    purchase_price || null, purchase_date || null,
    current_value || null,
    ownership_percentage != null ? ownership_percentage : 100,
    co_owner_name || null, registration_number || null,
    loan_outstanding || 0, loan_interest_rate || 0,
    notes || null
  );
  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const prop = ownedProperty(req.user.id, req.params.id);
  if (!prop) return res.status(404).json({ error: 'Not found' });

  const {
    name, property_type, address, city, state,
    area, area_unit, purchase_price, purchase_date,
    current_value, ownership_percentage, co_owner_name,
    registration_number, loan_outstanding, loan_interest_rate,
    profile_id, notes
  } = req.body;

  db.prepare(`
    UPDATE properties SET
      name=?, property_type=?, address=?, city=?, state=?,
      area=?, area_unit=?, purchase_price=?, purchase_date=?,
      current_value=?, ownership_percentage=?, co_owner_name=?,
      registration_number=?, loan_outstanding=?, loan_interest_rate=?,
      profile_id=?, notes=?
    WHERE id=? AND user_id=?
  `).run(
    name || prop.name,
    property_type || prop.property_type,
    address != null ? address : prop.address,
    city != null ? city : prop.city,
    state != null ? state : prop.state,
    area != null ? area : prop.area,
    area_unit || prop.area_unit,
    purchase_price != null ? purchase_price : prop.purchase_price,
    purchase_date != null ? purchase_date : prop.purchase_date,
    current_value != null ? current_value : prop.current_value,
    ownership_percentage != null ? ownership_percentage : prop.ownership_percentage,
    co_owner_name != null ? co_owner_name : prop.co_owner_name,
    registration_number != null ? registration_number : prop.registration_number,
    loan_outstanding != null ? loan_outstanding : prop.loan_outstanding,
    loan_interest_rate != null ? loan_interest_rate : prop.loan_interest_rate,
    profile_id != null ? profile_id : prop.profile_id,
    notes != null ? notes : prop.notes,
    req.params.id, req.user.id
  );
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const prop = ownedProperty(req.user.id, req.params.id);
  if (!prop) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM properties WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ── Rental Agreements ──────────────────────────────────────────────────────

router.get('/:id/agreements', (req, res) => {
  if (!ownedProperty(req.user.id, req.params.id)) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare(
    'SELECT * FROM rental_agreements WHERE property_id = ? AND user_id = ? ORDER BY start_date DESC'
  ).all(req.params.id, req.user.id);
  res.json({ agreements: rows });
});

router.post('/:id/agreements', (req, res) => {
  if (!ownedProperty(req.user.id, req.params.id)) return res.status(404).json({ error: 'Not found' });
  const { tenant_name, tenant_phone, tenant_email, rent_amount, security_deposit,
          start_date, end_date, lock_in_months, payment_day, status, notes } = req.body;
  if (!tenant_name || !rent_amount || !start_date) {
    return res.status(400).json({ error: 'tenant_name, rent_amount and start_date are required' });
  }
  const result = db.prepare(`
    INSERT INTO rental_agreements
      (property_id, user_id, tenant_name, tenant_phone, tenant_email, rent_amount,
       security_deposit, start_date, end_date, lock_in_months, payment_day, status, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.params.id, req.user.id, tenant_name,
    tenant_phone || null, tenant_email || null, rent_amount,
    security_deposit || 0, start_date, end_date || null,
    lock_in_months || 0, payment_day || 1,
    status || 'active', notes || null
  );
  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/:id/agreements/:aid', (req, res) => {
  const existing = db.prepare(
    'SELECT * FROM rental_agreements WHERE id = ? AND property_id = ? AND user_id = ?'
  ).get(req.params.aid, req.params.id, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { tenant_name, tenant_phone, tenant_email, rent_amount, security_deposit,
          start_date, end_date, lock_in_months, payment_day, status, notes } = req.body;
  db.prepare(`
    UPDATE rental_agreements SET
      tenant_name=?, tenant_phone=?, tenant_email=?, rent_amount=?,
      security_deposit=?, start_date=?, end_date=?, lock_in_months=?,
      payment_day=?, status=?, notes=?
    WHERE id=? AND property_id=? AND user_id=?
  `).run(
    tenant_name || existing.tenant_name,
    tenant_phone != null ? tenant_phone : existing.tenant_phone,
    tenant_email != null ? tenant_email : existing.tenant_email,
    rent_amount != null ? rent_amount : existing.rent_amount,
    security_deposit != null ? security_deposit : existing.security_deposit,
    start_date || existing.start_date,
    end_date != null ? end_date : existing.end_date,
    lock_in_months != null ? lock_in_months : existing.lock_in_months,
    payment_day != null ? payment_day : existing.payment_day,
    status || existing.status,
    notes != null ? notes : existing.notes,
    req.params.aid, req.params.id, req.user.id
  );
  res.json({ ok: true });
});

router.delete('/:id/agreements/:aid', (req, res) => {
  const r = db.prepare(
    'DELETE FROM rental_agreements WHERE id = ? AND property_id = ? AND user_id = ?'
  ).run(req.params.aid, req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Property Tax Payments ──────────────────────────────────────────────────

router.get('/:id/tax-payments', (req, res) => {
  if (!ownedProperty(req.user.id, req.params.id)) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare(
    'SELECT * FROM property_tax_payments WHERE property_id = ? AND user_id = ? ORDER BY payment_date DESC'
  ).all(req.params.id, req.user.id);
  res.json({ tax_payments: rows });
});

router.post('/:id/tax-payments', (req, res) => {
  if (!ownedProperty(req.user.id, req.params.id)) return res.status(404).json({ error: 'Not found' });
  const { assessment_year, amount, payment_date, receipt_number, notes } = req.body;
  if (!assessment_year || !amount || !payment_date) {
    return res.status(400).json({ error: 'assessment_year, amount and payment_date are required' });
  }
  const result = db.prepare(`
    INSERT INTO property_tax_payments
      (property_id, user_id, assessment_year, amount, payment_date, receipt_number, notes)
    VALUES (?,?,?,?,?,?,?)
  `).run(req.params.id, req.user.id, assessment_year, amount, payment_date, receipt_number || null, notes || null);
  res.status(201).json({ id: result.lastInsertRowid });
});

router.delete('/:id/tax-payments/:tid', (req, res) => {
  const r = db.prepare(
    'DELETE FROM property_tax_payments WHERE id = ? AND property_id = ? AND user_id = ?'
  ).run(req.params.tid, req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Property Expenses ──────────────────────────────────────────────────────

router.get('/:id/expenses', (req, res) => {
  if (!ownedProperty(req.user.id, req.params.id)) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare(
    'SELECT * FROM property_expenses WHERE property_id = ? AND user_id = ? ORDER BY date DESC'
  ).all(req.params.id, req.user.id);
  res.json({ expenses: rows });
});

router.post('/:id/expenses', (req, res) => {
  if (!ownedProperty(req.user.id, req.params.id)) return res.status(404).json({ error: 'Not found' });
  const { expense_type, description, amount, date, receipt_number, notes } = req.body;
  if (!description || !amount || !date) {
    return res.status(400).json({ error: 'description, amount and date are required' });
  }
  const result = db.prepare(`
    INSERT INTO property_expenses
      (property_id, user_id, expense_type, description, amount, date, receipt_number, notes)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    req.params.id, req.user.id,
    expense_type || 'Maintenance', description, amount, date,
    receipt_number || null, notes || null
  );
  res.status(201).json({ id: result.lastInsertRowid });
});

router.delete('/:id/expenses/:eid', (req, res) => {
  const r = db.prepare(
    'DELETE FROM property_expenses WHERE id = ? AND property_id = ? AND user_id = ?'
  ).run(req.params.eid, req.params.id, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Section 24 Tax Summary ─────────────────────────────────────────────────
// GAV = annual rent | NAV = GAV - municipal tax | Sec24a = 30% of NAV | Net = NAV - Sec24a - Sec24b

router.get('/:id/section24', (req, res) => {
  const prop = ownedProperty(req.user.id, req.params.id);
  if (!prop) return res.status(404).json({ error: 'Not found' });

  const { fy = currentFY() } = req.query;

  const activeAgreement = db.prepare(`
    SELECT * FROM rental_agreements
    WHERE property_id = ? AND user_id = ? AND status = 'active'
    ORDER BY start_date DESC LIMIT 1
  `).get(req.params.id, req.user.id);

  const monthlyRent = activeAgreement ? activeAgreement.rent_amount : 0;

  // Property tax paid for the FY (assessment_year = fy e.g. "2025-26")
  const taxRow = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM property_tax_payments
    WHERE property_id = ? AND user_id = ? AND assessment_year = ?
  `).get(req.params.id, req.user.id, fy);
  const municipalTax = taxRow.total;

  // Maintenance expenses (all types) for the FY
  const [fyStart, fyEnd] = fyDateRange(fy);
  const expRow = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM property_expenses
    WHERE property_id = ? AND user_id = ? AND date >= ? AND date <= ?
  `).get(req.params.id, req.user.id, fyStart, fyEnd);
  const totalExpenses = expRow.total;

  const ownershipFraction = (prop.ownership_percentage || 100) / 100;
  const annualRent = monthlyRent * 12 * ownershipFraction;
  const gav = annualRent;
  const nav = Math.max(0, gav - municipalTax);
  const sec24a = nav * 0.30;
  const sec24b = (prop.loan_outstanding || 0) * ((prop.loan_interest_rate || 0) / 100);
  const netHousePropertyIncome = nav - sec24a - sec24b;

  res.json({
    financial_year: fy,
    property_name: prop.name,
    monthly_rent: monthlyRent,
    annual_rent: annualRent,
    gross_annual_value: gav,
    municipal_tax_paid: municipalTax,
    net_annual_value: nav,
    section_24a_deduction: sec24a,
    section_24b_interest: sec24b,
    net_income_from_house_property: netHousePropertyIncome,
    actual_expenses: totalExpenses,
    ownership_percentage: prop.ownership_percentage || 100,
    note: 'Section 24(a) standard deduction is 30% of NAV. Section 24(b) is capped at ₹2L for self-occupied property; no cap for let-out.'
  });
});

function currentFY() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const fyStart = month >= 4 ? year : year - 1;
  return `${fyStart}-${String(fyStart + 1).slice(-2)}`;
}

function fyDateRange(fy) {
  const [startYear] = fy.split('-');
  const sy = parseInt(startYear, 10);
  return [`${sy}-04-01`, `${sy + 1}-03-31`];
}

module.exports = router;
