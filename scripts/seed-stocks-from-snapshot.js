#!/usr/bin/env node
// Seed the stocks table for a user from the screenshots they shared.
// Idempotent: re-running with the same args produces the same final state
// (same upsert semantics as /api/import/commit on (user_id, symbol)).
//
// Usage:
//   node scripts/seed-stocks-from-snapshot.js --email kondetiudaykiran@gmail.com --reset
//   node scripts/seed-stocks-from-snapshot.js --email kondetiudaykiran@gmail.com           # upsert without wiping
//   node scripts/seed-stocks-from-snapshot.js --email ... --dry-run
//
// --reset deletes all existing stocks for that user before inserting.
// Without --reset, behaves like the import endpoint: matches on
// (user_id, symbol), updates qty + avg + yahoo_symbol; leaves unrelated
// rows alone.

require('dotenv').config();
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const reset  = args.includes('--reset');
const emailIdx = args.indexOf('--email');
const email = emailIdx >= 0 ? args[emailIdx + 1] : null;
if (!email) {
  console.error('--email <address> is required');
  process.exit(1);
}

const _envProd = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
const db = require('../server/db/database');
process.env.NODE_ENV = _envProd || '';

// Holdings extracted from the 5 portfolio screenshots. yahoo_symbol is set
// only for the few cases where the broker's ticker differs from Yahoo's
// official NSE/BSE symbol — for the rest, the auto-variant fallback in
// /api/investments/stocks resolves to ${symbol}.NS on its own.
const HOLDINGS = [
  { symbol: 'AZAD',       company: 'Azad Engineering Ltd',                qty: 35,   avg: 1478.56 },
  { symbol: 'BCG',        company: 'Brightcom Group Ltd',                 qty: 901,  avg: 95.64   },
  { symbol: 'CGPOWER',    company: 'CG Power and Industrial Solutions',   qty: 115,  avg: 675.94  },
  { symbol: 'COALINDIA',  company: 'Coal India Ltd',                      qty: 60,   avg: 490.45  },
  { symbol: 'FCSSOFT',    company: 'FCS Software Solutions',              qty: 1500, avg: 6.27    },
  { symbol: 'GOLDIETF',   company: 'Gold ETF',                            qty: 582,  avg: 103.43  },
  { symbol: 'HAL',        company: 'Hindustan Aeronautics Ltd',           qty: 23,   avg: 4360.78 },
  { symbol: 'HDFCGOLD',   company: 'HDFC Gold ETF',                       qty: 292,  avg: 103.37  },
  { symbol: 'IRFC',       company: 'Indian Railway Finance Corp',         qty: 500,  avg: 100.41  },
  { symbol: 'IREDA',      company: 'Indian Renewable Energy Dev Agency',  qty: 450,  avg: 173.72  },
  { symbol: 'JIOFIN',     company: 'Jio Financial Services',              qty: 200,  avg: 268.39  },
  { symbol: 'KPIL',       company: 'Kalpataru Projects International',    qty: 25,   avg: 1073.00 },
  { symbol: 'LGEINDIA',   company: 'LG Electronics India',                qty: 13,   avg: 1140.00 },
  { symbol: 'MICEL',      company: 'MIC Electronics',                     qty: 350,  avg: 104.56  },
  { symbol: 'MINDSPACE',  company: 'Mindspace Business Parks REIT',       qty: 100,  avg: 340.90  },
  { symbol: 'PAYTM',      company: 'One 97 Communications (Paytm)',       qty: 6,    avg: 2150.00 },
  { symbol: 'SETFGOLD',   company: 'SBI Gold ETF',                        qty: 814,  avg: 117.49  },
  { symbol: 'SUZLON',     company: 'Suzlon Energy',                       qty: 1000, avg: 45.17   },
  { symbol: 'TANLA',      company: 'Tanla Platforms',                     qty: 419,  avg: 1202.92 },
  { symbol: 'TATACAP',    company: 'Tata Capital Ltd',                    qty: 46,   avg: 326.00  },
  { symbol: 'TMCV',       company: 'Tata Motors Commercial Vehicles',     qty: 45,   avg: 154.35  },
  { symbol: 'TMPV',       company: 'Tata Motors Passenger Vehicles',      qty: 45,   avg: 341.14, yahoo_symbol: 'TATAMOTORS.NS' },
  { symbol: 'VISTAPH',    company: 'Vistar Pharmacare',                   qty: 1999, avg: 13.04   },
  { symbol: 'YESBANK',    company: 'Yes Bank',                            qty: 2000, avg: 29.36   },
  { symbol: 'ZENTEC',     company: 'Zen Technologies',                    qty: 26,   avg: 1880.70 }
];

function main() {
  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
  if (!user) { console.error(`No user with email ${email}`); process.exit(1); }
  console.log(`Target user: #${user.id} ${user.email}`);
  console.log(`Holdings to seed: ${HOLDINGS.length}`);
  console.log(`Mode: ${reset ? 'RESET (wipes all existing stocks first)' : 'UPSERT (matches on symbol)'}${dryRun ? ' — DRY RUN' : ''}`);

  const before = db.prepare('SELECT COUNT(*) AS n FROM stocks WHERE user_id = ?').get(user.id).n;
  console.log(`Before: ${before} row(s) in stocks for this user`);

  if (dryRun) {
    console.log('\nWould seed:');
    for (const h of HOLDINGS) {
      const tag = h.yahoo_symbol ? ` (→ ${h.yahoo_symbol})` : '';
      console.log(`  ${h.symbol.padEnd(10)} qty ${String(h.qty).padStart(5)}  avg ₹${String(h.avg).padStart(9)}  ${h.company}${tag}`);
    }
    console.log('\nRe-run without --dry-run to apply.');
    return;
  }

  const findExisting = db.prepare('SELECT id FROM stocks WHERE user_id = ? AND symbol = ? ORDER BY id ASC');
  const updateStmt   = db.prepare('UPDATE stocks SET quantity = ?, avg_buy_price = ?, company_name = ?, yahoo_symbol = ? WHERE id = ?');
  const insertStmt   = db.prepare('INSERT INTO stocks (user_id, symbol, company_name, quantity, avg_buy_price, yahoo_symbol) VALUES (?,?,?,?,?,?)');
  const deleteAll    = db.prepare('DELETE FROM stocks WHERE user_id = ?');
  const deleteOne    = db.prepare('DELETE FROM stocks WHERE id = ?');

  const tx = db.transaction(() => {
    if (reset) {
      const r = deleteAll.run(user.id);
      console.log(`  reset: deleted ${r.changes} existing row(s)`);
    }
    let inserted = 0, updated = 0;
    for (const h of HOLDINGS) {
      const yahoo = h.yahoo_symbol || null;
      const existing = reset ? [] : findExisting.all(user.id, h.symbol);
      if (existing.length === 0) {
        insertStmt.run(user.id, h.symbol, h.company, h.qty, h.avg, yahoo);
        inserted++;
      } else {
        updateStmt.run(h.qty, h.avg, h.company, yahoo, existing[0].id);
        for (let i = 1; i < existing.length; i++) deleteOne.run(existing[i].id);
        updated++;
      }
    }
    console.log(`  inserted: ${inserted}, updated: ${updated}`);
  });
  tx();

  const after = db.prepare('SELECT COUNT(*) AS n FROM stocks WHERE user_id = ?').get(user.id).n;
  console.log(`After:  ${after} row(s) in stocks for this user`);
  console.log('\nLive prices fetch automatically on the next /api/investments/stocks call.');
  console.log('TMPV is mapped to TATAMOTORS.NS. If TMCV (Commercial Vehicles) shows N/A,');
  console.log('click the badge in the UI and enter the correct Yahoo symbol once it lists.');
}

try { main(); }
catch (e) { console.error('FAIL:', e.message); process.exit(1); }
