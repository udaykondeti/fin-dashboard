#!/usr/bin/env node
// Idempotently seed holdings extracted from the user's broker exports:
//
//   * InvestRight_portfolio.csv  → 25 Indian equity / ETF holdings (stocks)
//   * InvestRight_MF.csv         → 3 mutual fund holdings        (mutual_funds)
//   * INDmoney US Stocks (UI)    → 2 open US positions            (us_stocks)
//   * NPS_Summary.csv            → Tier I + Tier II totals       (nps_accounts)
//
// Re-running is safe: each row is identified by a natural key
// (UPPER(symbol) / LOWER(fund_name) / tier / etc.) and upserted in place.
//
// Usage:
//   docker exec -i fin-dashboard node /app/scripts/seed-investright-holdings.js \
//     --email kondetiudaykiran@gmail.com
//
//   add --dry-run to preview without writing.

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

// ────────────────────────────── Source data ──────────────────────────────
// Indian equities & ETFs — derived from InvestRight_portfolio.csv. Symbols are
// the closest NSE tickers I could match from each company name; if the
// dashboard's price fetcher reports a stale price, edit the symbol column
// and re-run.
const INDIAN_STOCKS = [
  { symbol: 'AZAD',        company: 'Azad Engineering Limited',                quantity: 35,      avg: 1478.5566 },
  { symbol: 'BCG',         company: 'Brightcom Group Limited',                 quantity: 901,     avg: 95.6373  },
  { symbol: 'CGPOWER',     company: 'CG Power and Industrial Solutions Ltd',   quantity: 115,     avg: 675.9357 },
  { symbol: 'COALINDIA',   company: 'Coal India Limited',                      quantity: 60,      avg: 490.452  },
  { symbol: 'FCSSOFT',     company: 'FCS Software Solutions Limited',          quantity: 1500,    avg: 6.266    },
  { symbol: 'HDFCMFGETF',  company: 'HDFC Gold ETF',                            quantity: 274,     avg: 101.6577 },
  { symbol: 'HAL',         company: 'Hindustan Aeronautics Limited',           quantity: 23,      avg: 4360.7757 },
  { symbol: 'IPGETF',      company: 'ICICI Pru Gold ETF',                       quantity: 546,     avg: 101.6955 },
  { symbol: 'IRFC',        company: 'Indian Railway Finance Corp Ltd',          quantity: 500,     avg: 100.407  },
  { symbol: 'IREDA',       company: 'Indian Renewable Energy Development Agen',quantity: 450,     avg: 173.718  },
  { symbol: 'JIOFIN',      company: 'Jio Financial Services Limited',          quantity: 200,     avg: 268.389  },
  { symbol: 'KPIL',        company: 'Kalpataru Projects International Limited',quantity: 25,      avg: 1073.0004 },
  { symbol: 'LGHL',        company: 'LG Electronics India Limited',            quantity: 13,      avg: 1140.0   },
  { symbol: 'MICEL',       company: 'MIC Electronics Limited',                  quantity: 350,     avg: 104.557  },
  { symbol: 'MINDSPACE',   company: 'Mindspace Business Parks REIT',           quantity: 100,     avg: 340.9    },
  { symbol: 'PAYTM',       company: 'One 97 Communication Ltd',                quantity: 6,       avg: 2150.0   },
  { symbol: 'SBIGETS',     company: 'SBI Gold ETF',                             quantity: 814,     avg: 117.4937 },
  { symbol: 'SUZLON',      company: 'Suzlon Energy Limited',                   quantity: 1000,    avg: 45.1664  },
  { symbol: 'TANLA',       company: 'Tanla Platforms Limited',                 quantity: 419,     avg: 1202.9164 },
  { symbol: 'TATACAP',     company: 'Tata Capital Limited',                    quantity: 46,      avg: 326.0    },
  { symbol: 'TATAMOTORS',  company: 'Tata Motors Limited',                     quantity: 45,      avg: 154.3451 },
  { symbol: 'TATAMTRDVR',  company: 'Tata Motors Passenger Vehicles Ltd',      quantity: 45,      avg: 341.1436 },
  { symbol: 'VISTAR',      company: 'Vista Pharmaceuticals Limited',           quantity: 1999,    avg: 13.036   },
  { symbol: 'YESBANK',     company: 'Yes Bank Ltd',                            quantity: 2000,    avg: 29.357   },
  { symbol: 'ZENTEC',      company: 'Zen Technologies Limited',                quantity: 26,      avg: 1880.705 },
];

// Mutual funds — derived from InvestRight_MF.csv (units = Invested ÷ Avg Cost)
const MUTUAL_FUNDS = [
  { fund_name: 'Axis Midcap Fund — Growth',                units: 490.73,  avg_nav: 112.0777,  fund_type: 'Equity' },
  { fund_name: 'HDFC Flexi Cap Fund — Growth',             units: 85.05,   avg_nav: 1881.244,  fund_type: 'Equity' },
  { fund_name: 'Motilal Oswal Midcap Fund — Regular Growth', units: 511.896, avg_nav: 97.6761, fund_type: 'Equity' },
];

// US stocks — INDmoney "My Stocks" tab. AMD is fully sold (1.819333333 bought,
// 0.9 + 0.919333333 sold = 1.819333333 closed) so it's not seeded as a holding.
const US_STOCKS = [
  { symbol: 'TSLA', company: 'Tesla Inc',           quantity: 1.169344, avg_usd: 331.81 },
  { symbol: 'QCOM', company: 'Qualcomm Incorporated', quantity: 1.176903, avg_usd: 135.95 },
];

// NPS — PRAN 110135717379, as of 30-Apr-2026 per the user's gmail extract.
// Tier I and Tier II are separate accounts (different `tier` rows).
const NPS = {
  pran: '110135717379',
  tiers: [
    { tier: 'Tier I',  invested: 265000, current: 334040.65,
      notes: 'PRAN 110135717379 · 80CCD(1B) ₹2,85,000 eligible · As of 30-Apr-2026' },
    { tier: 'Tier II', invested:  21000, current:  21900.84,
      notes: 'PRAN 110135717379 · Investment account · As of 30-Apr-2026' },
  ]
};

// ────────────────────────────── Upsert helpers ───────────────────────────
function upsertStock(userId, s) {
  const sym = String(s.symbol).toUpperCase();
  const existing = db.prepare(
    `SELECT id FROM stocks WHERE user_id = ? AND UPPER(symbol) = ?`
  ).get(userId, sym);
  if (existing) {
    db.prepare(`UPDATE stocks SET company_name = ?, quantity = ?, avg_buy_price = ?, exchange = 'NSE' WHERE id = ?`)
      .run(s.company, s.quantity, s.avg, existing.id);
    return { action: 'updated', id: existing.id };
  }
  const r = db.prepare(
    `INSERT INTO stocks (user_id, symbol, exchange, company_name, quantity, avg_buy_price)
     VALUES (?, ?, 'NSE', ?, ?, ?)`
  ).run(userId, sym, s.company, s.quantity, s.avg);
  return { action: 'inserted', id: r.lastInsertRowid };
}

function upsertUSStock(userId, s) {
  const sym = String(s.symbol).toUpperCase();
  const existing = db.prepare(
    `SELECT id FROM us_stocks WHERE user_id = ? AND UPPER(symbol) = ?`
  ).get(userId, sym);
  if (existing) {
    db.prepare(`UPDATE us_stocks SET company_name = ?, quantity = ?, avg_buy_price_usd = ? WHERE id = ?`)
      .run(s.company, s.quantity, s.avg_usd, existing.id);
    return { action: 'updated', id: existing.id };
  }
  const r = db.prepare(
    `INSERT INTO us_stocks (user_id, symbol, company_name, quantity, avg_buy_price_usd)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, sym, s.company, s.quantity, s.avg_usd);
  return { action: 'inserted', id: r.lastInsertRowid };
}

function upsertMF(userId, m) {
  const existing = db.prepare(
    `SELECT id FROM mutual_funds WHERE user_id = ? AND LOWER(fund_name) = LOWER(?)`
  ).get(userId, m.fund_name);
  if (existing) {
    db.prepare(`UPDATE mutual_funds SET units = ?, avg_nav = ?, fund_type = ? WHERE id = ?`)
      .run(m.units, m.avg_nav, m.fund_type, existing.id);
    return { action: 'updated', id: existing.id };
  }
  const r = db.prepare(
    `INSERT INTO mutual_funds (user_id, fund_name, units, avg_nav, fund_type)
     VALUES (?, ?, ?, ?, ?)`
  ).run(userId, m.fund_name, m.units, m.avg_nav, m.fund_type);
  return { action: 'inserted', id: r.lastInsertRowid };
}

function upsertNPS(userId, pran, t) {
  const existing = db.prepare(
    `SELECT id FROM nps_accounts WHERE user_id = ? AND pran = ? AND tier = ?`
  ).get(userId, pran, t.tier);
  if (existing) {
    db.prepare(`UPDATE nps_accounts SET total_invested = ?, current_value = ?, notes = ? WHERE id = ?`)
      .run(t.invested, t.current, t.notes, existing.id);
    return { action: 'updated', id: existing.id };
  }
  const r = db.prepare(
    `INSERT INTO nps_accounts (user_id, pran, tier, total_invested, current_value, notes)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, pran, t.tier, t.invested, t.current, t.notes);
  return { action: 'inserted', id: r.lastInsertRowid };
}

// ────────────────────────────── Driver ───────────────────────────────────
function main() {
  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (!user) { console.error(`No user with email ${email}`); process.exit(1); }
  console.log(`Target user: #${user.id} ${user.email}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'WRITE'}\n`);

  if (dryRun) {
    console.log(`Would upsert ${INDIAN_STOCKS.length} Indian stocks, ${MUTUAL_FUNDS.length} MFs, ${US_STOCKS.length} US stocks, ${NPS.tiers.length} NPS tiers.`);
    return;
  }

  const tally = { inserted: 0, updated: 0 };
  const bump = (r) => { tally[r.action]++; };

  console.log('── Indian stocks (stocks) ─────────────────────────────────');
  for (const s of INDIAN_STOCKS) {
    const r = upsertStock(user.id, s);
    bump(r);
    console.log(`  [${r.action}] #${r.id}  ${s.symbol.padEnd(12)} ${s.quantity} @ ₹${s.avg}`);
  }

  console.log('\n── Mutual funds (mutual_funds) ────────────────────────────');
  for (const m of MUTUAL_FUNDS) {
    const r = upsertMF(user.id, m);
    bump(r);
    console.log(`  [${r.action}] #${r.id}  ${m.fund_name}: ${m.units} units @ ₹${m.avg_nav}`);
  }

  console.log('\n── US stocks (us_stocks) ──────────────────────────────────');
  for (const s of US_STOCKS) {
    const r = upsertUSStock(user.id, s);
    bump(r);
    console.log(`  [${r.action}] #${r.id}  ${s.symbol.padEnd(6)} ${s.quantity} @ $${s.avg_usd}`);
  }

  console.log('\n── NPS (nps_accounts) ─────────────────────────────────────');
  for (const t of NPS.tiers) {
    const r = upsertNPS(user.id, NPS.pran, t);
    bump(r);
    console.log(`  [${r.action}] #${r.id}  ${t.tier}: ₹${t.invested.toLocaleString('en-IN')} → ₹${t.current.toLocaleString('en-IN')}`);
  }

  console.log(`\nDone. inserted=${tally.inserted}  updated=${tally.updated}`);
}

try { main(); }
catch (e) { console.error('FAIL:', e.message); process.exit(1); }
