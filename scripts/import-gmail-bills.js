#!/usr/bin/env node
// One-shot import of bills extracted from the user's Gmail by the agent
// (Claude MCP Gmail connector, May 2026 sweep). Idempotent — re-running
// upserts on stable keys so you can safely run after every Gmail scan.
//
// Tables touched:
//   - credit_cards          (HDFC / Federal / SBI / Axis pending bills)
//   - scheduled_payments    (utilities, maintenance, recurring subscriptions)
//   - transactions          (paid receipts, with source='gmail')
//
// Usage:
//   node scripts/import-gmail-bills.js --email kondetiudaykiran@gmail.com --dry-run
//   node scripts/import-gmail-bills.js --email kondetiudaykiran@gmail.com

require('dotenv').config();
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const emailIdx = args.indexOf('--email');
const email = emailIdx >= 0 ? args[emailIdx + 1] : null;
if (!email) { console.error('--email <addr> is required'); process.exit(1); }

const _envProd = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
const db = require('../server/db/database');
process.env.NODE_ENV = _envProd || '';

// ─── Hardcoded data extracted from Gmail ─────────────────────────────────
//
// Source: Claude MCP Gmail scan, May 2026.
// Confidence: HIGH for the credit-card aggregator + utility/maintenance
// bills (amount + due date came directly from email body snippets).
// Add more rows as you confirm them.

const CREDIT_CARDS = [
  // card_name, bank, outstanding_balance, due_date (YYYY-MM-DD)
  // Source: GooglePay aggregated bill summaries
  { card_name: 'HDFC Millennia',    bank: 'HDFC Bank',    outstanding_balance: 17365.00, due_date: '2026-05-26' },
  { card_name: 'Federal One',       bank: 'Federal Bank', outstanding_balance: 14627.13, due_date: '2026-05-07' },
  { card_name: 'SBI Card PRIME',    bank: 'SBI Card',     outstanding_balance: 32468.99, due_date: '2026-05-14' },
  { card_name: 'Axis Ikea',         bank: 'Axis Bank',    outstanding_balance:    40.59, due_date: '2026-05-02' }
];

const SCHEDULED_PAYMENTS = [
  // name, amount, frequency, category, next_due_date
  { name: 'Apartment Maintenance (C-632)', amount: 26393.00, frequency: 'Monthly', category: 'Rent',        next_due_date: '2026-06-02' },
  { name: 'TSSPDCL Electricity',           amount:   617.00, frequency: 'Monthly', category: 'Utilities',   next_due_date: '2026-05-17' },
  { name: 'ACT Fibernet',                  amount:  1414.82, frequency: 'Monthly', category: 'Utilities',   next_due_date: '2026-05-15' }
];

const TRANSACTIONS = [
  // date, description, amount, direction, category, source_ref (Gmail msg id — keep stable for idempotency)
  // Paid receipts captured from Gmail
  { date: '2026-05-07', description: 'Airtel mobile payment receipt',                            amount: 0,       direction: 'debit',  category: 'bill_payment', source_ref: 'gmail:19e017bafd505157' },
  { date: '2026-05-02', description: 'Apartment Maintenance (C-632) — payment received',         amount: 26393.0, direction: 'debit',  category: 'bill_payment', source_ref: 'gmail:19de665294a7b656' }
  // Note: Airtel receipt amount needs full-body fetch to confirm; left at 0 so it's
  // visible but you can edit. Add new rows here as you scan more emails.
];

// ─── Helpers ─────────────────────────────────────────────────────────────

function getUser() {
  const u = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (!u) { console.error(`No user with email ${email}`); process.exit(1); }
  return u;
}

function upsertCreditCards(userId, cards) {
  const existing = db.prepare('SELECT id, card_name, bank FROM credit_cards WHERE user_id = ?').all(userId);
  const findOne  = (cn, bk) => existing.find(e => (e.card_name || '').toLowerCase() === cn.toLowerCase() && (e.bank || '').toLowerCase() === bk.toLowerCase());
  const update   = db.prepare('UPDATE credit_cards SET outstanding_balance = ?, due_date = ? WHERE id = ?');
  const insert   = db.prepare('INSERT INTO credit_cards (user_id, card_name, bank, card_limit, outstanding_balance, due_date) VALUES (?,?,?,?,?,?)');
  let inserted = 0, updated = 0;
  for (const c of cards) {
    const hit = findOne(c.card_name, c.bank);
    if (hit) {
      console.log(`  CC update  ${c.card_name.padEnd(22)} → ₹${c.outstanding_balance.toLocaleString('en-IN').padStart(10)}, due ${c.due_date}`);
      if (!dryRun) update.run(c.outstanding_balance, c.due_date, hit.id);
      updated++;
    } else {
      console.log(`  CC insert  ${c.card_name.padEnd(22)} → ₹${c.outstanding_balance.toLocaleString('en-IN').padStart(10)}, due ${c.due_date}`);
      if (!dryRun) insert.run(userId, c.card_name, c.bank, 0, c.outstanding_balance, c.due_date);
      inserted++;
    }
  }
  return { inserted, updated };
}

function upsertScheduled(userId, items) {
  const existing = db.prepare('SELECT id, name FROM scheduled_payments WHERE user_id = ?').all(userId);
  const findOne  = (n) => existing.find(e => (e.name || '').toLowerCase() === n.toLowerCase());
  const update   = db.prepare('UPDATE scheduled_payments SET amount = ?, frequency = ?, category = ?, next_due_date = ? WHERE id = ?');
  const insert   = db.prepare('INSERT INTO scheduled_payments (user_id, name, amount, frequency, category, next_due_date, is_active) VALUES (?,?,?,?,?,?,1)');
  let inserted = 0, updated = 0;
  for (const p of items) {
    const hit = findOne(p.name);
    if (hit) {
      console.log(`  SP update  ${p.name.padEnd(38)} → ₹${p.amount.toLocaleString('en-IN').padStart(10)} ${p.frequency} due ${p.next_due_date}`);
      if (!dryRun) update.run(p.amount, p.frequency, p.category, p.next_due_date, hit.id);
      updated++;
    } else {
      console.log(`  SP insert  ${p.name.padEnd(38)} → ₹${p.amount.toLocaleString('en-IN').padStart(10)} ${p.frequency} due ${p.next_due_date}`);
      if (!dryRun) insert.run(userId, p.name, p.amount, p.frequency, p.category, p.next_due_date);
      inserted++;
    }
  }
  return { inserted, updated };
}

function upsertTransactions(userId, txns) {
  // UNIQUE(user_id, source, source_ref) makes this idempotent — INSERT OR IGNORE
  // skips dupes. Re-running with the same Gmail message id is a no-op.
  const insert = db.prepare(`
    INSERT OR IGNORE INTO transactions (user_id, date, description, amount, direction, category, source, source_ref)
    VALUES (?,?,?,?,?,?,'gmail',?)
  `);
  let inserted = 0, skipped = 0;
  for (const t of txns) {
    console.log(`  TX insert  ${t.date}  ${t.description.padEnd(50)} ₹${t.amount.toLocaleString('en-IN').padStart(10)}`);
    if (!dryRun) {
      const r = insert.run(userId, t.date, t.description, t.amount, t.direction, t.category, t.source_ref);
      if (r.changes > 0) inserted++; else skipped++;
    }
  }
  return { inserted, skipped };
}

function main() {
  const u = getUser();
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'WRITE'}`);
  console.log(`User: #${u.id} ${u.email}\n`);

  console.log('Credit cards:');
  const cc = upsertCreditCards(u.id, CREDIT_CARDS);

  console.log('\nScheduled payments:');
  const sp = upsertScheduled(u.id, SCHEDULED_PAYMENTS);

  console.log('\nTransactions:');
  const tx = upsertTransactions(u.id, TRANSACTIONS);

  console.log('\nSummary:');
  console.log(`  credit_cards:        ${cc.inserted} inserted, ${cc.updated} updated`);
  console.log(`  scheduled_payments:  ${sp.inserted} inserted, ${sp.updated} updated`);
  console.log(`  transactions:        ${tx.inserted} inserted, ${tx.skipped} duplicates skipped`);

  if (dryRun) console.log('\nRe-run without --dry-run to apply.');
}

try { main(); }
catch (e) { console.error('FAIL:', e.message); process.exit(1); }
