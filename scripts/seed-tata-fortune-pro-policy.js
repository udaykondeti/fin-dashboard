#!/usr/bin/env node
// Seed the Tata AIA Life Insurance Fortune Pro policy (U216963478) into the
// insurance_policies table so the agent can answer questions about it via
// its query_holdings(category='insurance') tool.
//
// Extracted from the user's policy documents:
//   - Policy_Information_Page.pdf
//   - Premium_Paid_History__U216963478.pdf
//   - PremiumCertificate_*.pdf (FY 2017-18, 2018-19, 2021-22)
//
// Idempotent — re-running upserts on (user_id, policy_name) so the row stays
// in sync if the script is updated later (e.g. to record more premium years).
//
// Usage:
//   node scripts/seed-tata-fortune-pro-policy.js --email kondetiudaykiran@gmail.com
//   node scripts/seed-tata-fortune-pro-policy.js --email <addr> --dry-run

require('dotenv').config();
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const emailIdx = args.indexOf('--email');
const email = emailIdx >= 0 ? args[emailIdx + 1] : null;

if (!email) { console.error('--email <address> is required'); process.exit(1); }

const _envProd = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
const db = require('../server/db/database');
process.env.NODE_ENV = _envProd || '';

// ── Extracted policy data ─────────────────────────────────────────────────
const POLICY_NAME = 'Tata AIA Fortune Pro - U216963478';

// As of 19-May-2026 Unit Linked Statement (ULS):
//   Total fund value:    ₹9,58,735.97
//   Total premium paid:  ₹5,00,000
//   Premium invested:    ₹4,66,370 (after ₹28,500 allocation charge + GST)
//   Implied return:      ~91.7% on amount invested
const POLICY = {
  policy_name: POLICY_NAME,
  insurer: 'Tata AIA Life Insurance Company Ltd.',
  policy_type: 'ULIP',
  premium_amount: 100000,
  premium_frequency: 'Annual',
  cover_amount: 1000000,                // ₹10,00,000 sum assured
  start_date: '2017-12-24',
  maturity_date: '2037-12-24',
  next_due_date: null,                  // Paid Up — 5-Pay PPT complete
  nominee: 'GOPALAKRISHNA KONDETI',
  notes: [
    'Policy Number: U216963478',
    'Plan: Tata AIA Life Insurance Fortune Pro (110L112V02) — ULIP',
    'Plan structure: 5 Pay Limited term, Age Band 30-35',
    'Agent: HDFC BANK (Agency Code 004621612)',
    '',
    '── Insured ─────────────────────────────────────────────',
    'Insured / Owner: KONDETI UDAY KIRAN',
    'DOB: 1984-10-29 · Male · Issue age 33',
    'Nominee: GOPALAKRISHNA KONDETI',
    '',
    '── Policy schedule ─────────────────────────────────────',
    'Policy term:        20 years (2017-12-24 → 2037-12-24)',
    'Premium term (PPT): 5 years (paid up after Dec 2021)',
    'Sum assured:        ₹10,00,000',
    'Annual premium:     ₹1,00,000',
    'Premium mode:       Annual (cheque)',
    'Status:             PAID UP — premium-paying term complete',
    '',
    '── Premium history (5 instalments, all cleared) ────────',
    '  22-Dec-2017  ₹1,00,000  Cheque  (FY 2017-18)',
    '  27-Mar-2019  ₹1,00,000  Cheque  (FY 2018-19)',
    '  10-Jan-2020  ₹1,00,000  Cheque  (FY 2019-20)',
    '  17-Dec-2020  ₹1,00,000  Cheque  (FY 2020-21)',
    '  17-Dec-2021  ₹1,00,000  Cheque  (FY 2021-22)',
    '  ─────────────────────────────',
    '  Total premium paid:     ₹5,00,000',
    '  Total premium invested: ₹4,66,370',
    '  (₹28,500 allocation charge + ₹5,130 GST deducted at entry)',
    '',
    '── Fund value (as of 19-May-2026, from ULS) ────────────',
    'TOTAL SURRENDER VALUE: ₹9,58,735.97',
    '',
    'Current fund portfolio:',
    '  Whole Life Aggressive Growth   ₹3,95,884.78  (3923 units @ ₹100.91)',
    '  Whole Life Short Term Income   ₹2,13,800.13  (5824 units @ ₹36.71)',
    '  Multi Cap Fund                 ₹1,11,313.32  (1723 units @ ₹64.59)',
    '  Large Cap Equity               ₹69,273.27    (978 units @ ₹70.79)',
    '  Top-50 Fund                    ₹63,934.80    (686 units @ ₹93.18)',
    '  Whole Life Mid Cap Equity      ₹21,850.14    (130 units @ ₹168.25)',
    '  Whole Life Income              ₹21,694.19    (528 units @ ₹41.09)',
    '  India Consumption              ₹21,158.83    (341 units @ ₹62.12)',
    '  Top-200 Fund                   ₹20,727.02    (117 units @ ₹177.52)',
    '  Super Select Equity            ₹19,099.49    (249 units @ ₹76.74)',
    '',
    'Current premium allocation instructions (for any future top-ups):',
    '  Whole Life Aggressive Growth:    50%',
    '  Whole Life Short Term Income:    50%',
    '',
    '── Lifetime charges (from ULS) ─────────────────────────',
    '  Premium allocation:          ₹28,500.00 + ₹5,130.00 GST',
    '  Monthly administration:      ₹6,312.50 + ₹1,046.25 GST',
    '  Mortality (death cover):     ₹4,557.05 + ₹811.61 GST',
    '  Fund switch / withdrawal:    ₹0.00',
    '',
    '── Tax ─────────────────────────────────────────────────',
    'Sec 80C eligible (₹1,00,000 in each of the 5 paying years).',
    'GST applicable on premium: nil (individual life insurance).',
    '',
    '── Contact ─────────────────────────────────────────────',
    'Customer care: customercare@tataaia.com · 1860-266-9966',
    'Policy servicing: 1st Flr, Simran Centre, 30/H Parsi Panchayat Marg,',
    '                  Andheri-East, Mumbai 400093'
  ].join('\n')
};

function main() {
  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (!user) { console.error(`No user with email ${email}`); process.exit(1); }
  console.log(`Target user: #${user.id} ${user.email}`);

  const existing = db.prepare(
    'SELECT id, premium_amount, cover_amount FROM insurance_policies WHERE user_id = ? AND policy_name = ?'
  ).all(user.id, POLICY_NAME);

  console.log(`\nPolicy: ${POLICY.policy_name}`);
  console.log(`  Insurer:    ${POLICY.insurer}`);
  console.log(`  Type:       ${POLICY.policy_type}`);
  console.log(`  Premium:    ₹${POLICY.premium_amount.toLocaleString('en-IN')} ${POLICY.premium_frequency}`);
  console.log(`  Cover:      ₹${POLICY.cover_amount.toLocaleString('en-IN')}`);
  console.log(`  Start:      ${POLICY.start_date}`);
  console.log(`  Maturity:   ${POLICY.maturity_date}`);
  console.log(`  Nominee:    ${POLICY.nominee}`);
  console.log(`  Next Due:   ${POLICY.next_due_date || 'Paid Up'}`);
  console.log(`  Existing rows: ${existing.length} match(es)`);

  if (dryRun) { console.log('\nDry run — re-run without --dry-run to apply.'); return; }

  if (existing.length === 0) {
    const r = db.prepare(`
      INSERT INTO insurance_policies (user_id, policy_name, insurer, policy_type,
        premium_amount, premium_frequency, cover_amount, start_date, maturity_date,
        next_due_date, nominee, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id, POLICY.policy_name, POLICY.insurer, POLICY.policy_type,
      POLICY.premium_amount, POLICY.premium_frequency, POLICY.cover_amount,
      POLICY.start_date, POLICY.maturity_date, POLICY.next_due_date,
      POLICY.nominee, POLICY.notes
    );
    console.log(`\nInserted policy #${r.lastInsertRowid}`);
  } else {
    const keepId = existing[0].id;
    db.prepare(`
      UPDATE insurance_policies SET
        insurer = ?, policy_type = ?, premium_amount = ?, premium_frequency = ?,
        cover_amount = ?, start_date = ?, maturity_date = ?, next_due_date = ?,
        nominee = ?, notes = ?
      WHERE id = ?
    `).run(
      POLICY.insurer, POLICY.policy_type, POLICY.premium_amount, POLICY.premium_frequency,
      POLICY.cover_amount, POLICY.start_date, POLICY.maturity_date, POLICY.next_due_date,
      POLICY.nominee, POLICY.notes, keepId
    );
    for (let i = 1; i < existing.length; i++) {
      db.prepare('DELETE FROM insurance_policies WHERE id = ?').run(existing[i].id);
    }
    console.log(`\nUpdated policy #${keepId}` + (existing.length > 1 ? ` (collapsed ${existing.length - 1} dup row(s))` : ''));
  }

  console.log('\nVerify in the agent: ask "tell me about my Tata AIA policy" or');
  console.log('"what insurance policies do I have" — the agent will query the row above.');
}

try { main(); }
catch (e) { console.error('FAIL:', e.message); process.exit(1); }
