#!/usr/bin/env node
/**
 * One-time cleanup: deletes the originally seeded dummy rows from an
 * existing finance.db, keeping the admin user, real entries, and any
 * additional profile rows the user has created.
 *
 * Run on the EC2 box (or locally) with:
 *   node scripts/clear-dummy-data.js
 *
 * Idempotent — safe to re-run.
 */
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

const adminEmail = 'kondetiudaykiran@gmail.com';
const admin = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
if (!admin) {
  console.log(`No admin user (${adminEmail}) found. Nothing to clean.`);
  process.exit(0);
}
const userId = admin.id;

const SAMPLE_ROWS = [
  { table: 'stocks',                column: 'symbol',     values: ['TCS', 'INFY', 'RELIANCE', 'HDFCBANK', 'WIPRO'] },
  { table: 'mutual_funds',          column: 'folio_number', values: ['MIR123456', 'SBI789012', 'AXS345678'] },
  { table: 'fixed_deposits',        column: 'bank_name',  values: ['State Bank of India', 'HDFC Bank'], extraWhere: "fd_type = 'Cumulative' AND start_date IN ('2023-04-01','2024-01-15')" },
  { table: 'us_stocks',             column: 'symbol',     values: ['GOOGL'], extraWhere: "avg_buy_price_usd = 138.5" },
  { table: 'credit_cards',          column: 'card_name',  values: ['HDFC Millennia Credit Card'], extraWhere: "outstanding_balance = 15000" },
  { table: 'loans',                 column: 'lender',     values: ['State Bank of India'], extraWhere: "principal_amount = 6000000 AND emi_amount = 52000" },
  { table: 'hand_loans',            column: 'person_name', values: ['Ravi', 'Mom'], extraWhere: "amount IN (50000, 20000) AND date IN ('2025-12-01','2026-01-15')" },
  { table: 'profiles',              column: 'name',       values: ['Joint'], extraWhere: "is_default = 0" },
  { table: 'savings_accounts',      column: 'bank_name',  values: ['HDFC Bank', 'State Bank of India'], extraWhere: "balance IN (85000, 45000)" },
  { table: 'insurance_policies',    column: 'policy_name', values: ['Term Plan - 1 Cr', 'Family Floater Health'] },
  { table: 'nps_accounts',          column: 'pran',       values: ['PRAN110000000001'] },
  { table: 'scheduled_payments',    column: 'name',       values: ['Home Loan EMI - SBI', 'Mirae Asset SIP', 'SBI Small Cap SIP', 'Axis Bluechip SIP', 'HDFC Life Term Plan', 'Star Health Insurance', 'Netflix', 'NPS Contribution'] },
  { table: 'advance_tax_payments',  column: 'assessment_year', values: ['2026-27'], extraWhere: "amount = 25000" },
  { table: 'earnings',              column: 'source_name', values: ['Salary', 'Rental Income - Flat'], extraWhere: "amount IN (150000, 25000)" },
];

let totalDeleted = 0;
for (const row of SAMPLE_ROWS) {
  const placeholders = row.values.map(() => '?').join(',');
  let sql = `DELETE FROM ${row.table} WHERE user_id = ? AND ${row.column} IN (${placeholders})`;
  if (row.extraWhere) sql += ` AND ${row.extraWhere}`;
  try {
    const result = db.prepare(sql).run(userId, ...row.values);
    if (result.changes > 0) {
      console.log(`  ${row.table}: removed ${result.changes} sample row(s)`);
      totalDeleted += result.changes;
    }
  } catch (err) {
    console.warn(`  ${row.table}: skipped (${err.message})`);
  }
}

console.log(`\nDone. Removed ${totalDeleted} dummy row(s) for ${adminEmail}.`);
console.log(`Real entries you've added are untouched.`);
db.close();
