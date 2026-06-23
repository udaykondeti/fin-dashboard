// Centralised duplicate detection for inserts that can be triggered both
// from the UI (POST routes) and the agent's auto-confirm loop. Returns the
// existing row when a likely-duplicate is found so the route can either
//   (a) 409 with the existing record + a hint, OR
//   (b) merge / no-op (caller's choice).
//
// The natural key per table mirrors what chatTools.js uses for propose_add_*
// dup checks (PR #73), so the agent and the UI agree on what counts as a
// duplicate. Keep these in sync.

const db = require('../db/database');

const NATURAL_KEYS = {
  stocks:                { sql: 'UPPER(symbol) = UPPER(?)',           cols: 'id, symbol, quantity, avg_buy_price' },
  us_stocks:             { sql: 'UPPER(symbol) = UPPER(?)',           cols: 'id, symbol, quantity, avg_buy_price_usd' },
  mutual_funds:          { sql: 'LOWER(fund_name) = LOWER(?)',        cols: 'id, fund_name, units, avg_nav' },
  fixed_deposits:        { sql: 'LOWER(bank_name) = LOWER(?) AND principal = ? AND maturity_date = ?',
                           cols: 'id, bank_name, principal, maturity_date' },
  earnings:              { sql: 'LOWER(source_name) = LOWER(?)',      cols: 'id, source_name, amount, frequency' },
  scheduled_payments:    { sql: 'LOWER(name) = LOWER(?)',             cols: 'id, name, amount, frequency' },
  advance_tax_payments:  { sql: 'assessment_year = ? AND installment = ?',
                           cols: 'id, assessment_year, installment, amount, date_paid' },
  savings_accounts:      { sql: 'LOWER(bank_name) = LOWER(?) AND account_number = ?',
                           cols: 'id, bank_name, account_number, balance' },
  insurance_policies:    { sql: 'LOWER(policy_name) = LOWER(?)',      cols: 'id, policy_name, premium_amount, cover_amount' },
  nps_accounts:          { sql: 'pran = ? AND tier = ?',              cols: 'id, pran, tier, total_invested' },
  credit_cards:          { sql: 'LOWER(card_name) = LOWER(?) AND last_four = ?',
                           cols: 'id, card_name, last_four, credit_limit' },
  loans:                 { sql: 'LOWER(lender_name) = LOWER(?) AND loan_type = ?',
                           cols: 'id, lender_name, loan_type, principal' },
  hand_loans:            { sql: 'LOWER(person_name) = LOWER(?) AND amount = ?',
                           cols: 'id, person_name, amount, direction' }
};

/**
 * Look for an existing row in `table` belonging to `userId` matching the
 * natural-key `params`. Returns the existing row or null.
 *
 *   findDuplicate('stocks', userId, ['RELIANCE'])
 *   findDuplicate('advance_tax_payments', userId, [2026, 'Q1'])
 */
function findDuplicate(table, userId, params) {
  const spec = NATURAL_KEYS[table];
  if (!spec) return null;
  const sql = `SELECT ${spec.cols} FROM ${table} WHERE user_id = ? AND ${spec.sql} LIMIT 1`;
  try { return db.prepare(sql).get(userId, ...params) || null; }
  catch (e) { console.warn(`[dedup] ${table} check failed: ${e.message}`); return null; }
}

/**
 * Express helper: if a duplicate exists and the request didn't pass
 * `?force=1` / `body.force === true`, reply 409 with the existing row and
 * return false (the route should not insert). Otherwise return true so the
 * route can proceed.
 *
 *   if (!assertNoDuplicate(req, res, 'stocks', [symbol])) return;
 */
function assertNoDuplicate(req, res, table, params, label) {
  const force = req.query.force === '1' || req.body?.force === true;
  if (force) return true;
  const existing = findDuplicate(table, req.user.id, params);
  if (!existing) return true;
  res.status(409).json({
    error: 'duplicate',
    message: `${label || table} already exists. Pass force=1 to add anyway.`,
    existing
  });
  return false;
}

module.exports = { findDuplicate, assertNoDuplicate, NATURAL_KEYS };
