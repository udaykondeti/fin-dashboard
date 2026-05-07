#!/usr/bin/env node
// Move rows from stocks → us_stocks for symbols that were imported into the
// Indian table by mistake (before the import endpoint had a us_stocks
// branch). Copies (qty, avg_buy_price → avg_buy_price_usd, company_name)
// and deletes the source row.
//
// Two modes:
//   --symbols AAPL,GOOG,MSFT   move only these (recommended; explicit)
//   --auto                     heuristic: any symbol that doesn't look
//                              like an Indian NSE ticker (letters-only,
//                              4+ chars, not in HEURISTIC_INDIAN list)
//                              gets moved. Riskier — review --dry-run.
//
// Usage:
//   node scripts/move-misplaced-us-stocks.js --email kondetiudaykiran@gmail.com --symbols AAPL,GOOG --dry-run
//   node scripts/move-misplaced-us-stocks.js --email kondetiudaykiran@gmail.com --symbols AAPL,GOOG
//
// Idempotent in the sense that re-running won't duplicate (the source row
// is gone after the first run); upserts on (user_id, symbol) in us_stocks.

require('dotenv').config();
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const auto = args.includes('--auto');
const emailIdx = args.indexOf('--email');
const symbolsIdx = args.indexOf('--symbols');
const email = emailIdx >= 0 ? args[emailIdx + 1] : null;
const explicitSymbols = symbolsIdx >= 0 ? args[symbolsIdx + 1] : null;

if (!email) { console.error('--email <address> is required'); process.exit(1); }
if (!explicitSymbols && !auto) {
  console.error('Pass either --symbols AAPL,GOOG,... OR --auto (heuristic)');
  process.exit(1);
}

const _envProd = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
const db = require('../server/db/database');
process.env.NODE_ENV = _envProd || '';

// Common well-known Indian-listed companies. Used by --auto only; if the
// symbol doesn't match this list and looks "US-shaped" (3-5 letters all
// caps), it's flagged for moving. List is intentionally conservative.
const KNOWN_INDIAN = new Set([
  'RELIANCE','INFY','TCS','HDFCBANK','HDFC','ICICIBANK','SBIN','AXISBANK',
  'KOTAKBANK','ITC','HINDUNILVR','BHARTIARTL','MARUTI','LT','BAJFINANCE',
  'BAJAJFINSV','ASIANPAINT','TITAN','SUNPHARMA','WIPRO','POWERGRID',
  'NESTLEIND','ULTRACEMCO','ONGC','NTPC','TATASTEEL','TATAMOTORS',
  'TECHM','HCLTECH','M&M','JSWSTEEL','GRASIM','HDFCLIFE','ADANIENT',
  'ADANIPORTS','SBILIFE','BAJAJ-AUTO','EICHERMOT','APOLLOHOSP',
  'INDUSINDBK','HEROMOTOCO','BPCL','IOC','UPL','COALINDIA','HAL',
  'IRFC','IREDA','SUZLON','PAYTM','TANLA','YESBANK','ZENTEC','AZAD',
  'CGPOWER','KPIL','LGEINDIA','MICEL','MINDSPACE','TATACAP','SETFGOLD',
  'GOLDIETF','HDFCGOLD','JIOFIN','VISTAPH','BCG','FCSSOFT','TMCV','TMPV'
]);

function looksUsShaped(symbol) {
  // Pure A-Z, length 1-5, no NSE-style suffix or & character.
  return /^[A-Z]{1,5}$/.test(symbol);
}

function pickCandidates(userId) {
  const all = db.prepare('SELECT * FROM stocks WHERE user_id = ? ORDER BY symbol').all(userId);
  if (explicitSymbols) {
    const wanted = new Set(explicitSymbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
    return all.filter(r => wanted.has((r.symbol || '').toUpperCase()));
  }
  // --auto: anything matching looksUsShaped AND not in KNOWN_INDIAN
  return all.filter(r => {
    const s = (r.symbol || '').toUpperCase();
    return looksUsShaped(s) && !KNOWN_INDIAN.has(s);
  });
}

function move(userId, candidates) {
  const findExisting = db.prepare('SELECT id FROM us_stocks WHERE user_id = ? AND symbol = ? ORDER BY id ASC');
  const updateUS = db.prepare('UPDATE us_stocks SET quantity = ?, avg_buy_price_usd = ?, company_name = COALESCE(?, company_name) WHERE id = ?');
  const insertUS = db.prepare('INSERT INTO us_stocks (user_id, symbol, company_name, quantity, avg_buy_price_usd) VALUES (?,?,?,?,?)');
  const deleteIN = db.prepare('DELETE FROM stocks WHERE id = ?');
  const tx = db.transaction(() => {
    for (const r of candidates) {
      const sym = (r.symbol || '').toUpperCase();
      const existing = findExisting.all(userId, sym);
      if (existing.length === 0) {
        insertUS.run(userId, sym, r.company_name || sym, r.quantity, r.avg_buy_price);
      } else {
        updateUS.run(r.quantity, r.avg_buy_price, r.company_name, existing[0].id);
      }
      deleteIN.run(r.id);
    }
  });
  tx();
}

function main() {
  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (!user) { console.error(`No user with email ${email}`); process.exit(1); }
  const candidates = pickCandidates(user.id);
  console.log(`Mode: ${explicitSymbols ? 'EXPLICIT' : 'AUTO HEURISTIC'}${dryRun ? ' (DRY RUN)' : ''}`);
  console.log(`User: #${user.id} ${user.email}`);
  console.log(`Candidates to move from stocks → us_stocks: ${candidates.length}`);
  for (const c of candidates) {
    console.log(`  ${c.symbol.padEnd(10)} qty ${String(c.quantity).padStart(8)} @ ${c.avg_buy_price}  (${c.company_name || ''})`);
  }
  if (!candidates.length) return;
  if (dryRun) { console.log('\nRe-run without --dry-run to apply.'); return; }
  move(user.id, candidates);
  console.log('\nDone.');
}

try { main(); }
catch (e) { console.error('FAIL:', e.message); process.exit(1); }
