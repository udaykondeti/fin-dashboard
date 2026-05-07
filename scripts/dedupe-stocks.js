#!/usr/bin/env node
// Consolidate duplicate stock holdings per user.
//
// Two modes:
//   --exact    only collapse rows where (symbol, qty, avg_buy_price) all match
//              (safe, no data loss — these are pure CSV-import duplicates)
//   --merge    collapse all rows sharing the same symbol per user, summing
//              quantities and weight-averaging avg_buy_price (use when the
//              same broker exported partial buys as separate rows)
//
// Usage:
//   node scripts/dedupe-stocks.js --email kondetiudaykiran@gmail.com --dry-run
//   node scripts/dedupe-stocks.js --email kondetiudaykiran@gmail.com --exact
//   node scripts/dedupe-stocks.js --email kondetiudaykiran@gmail.com --merge

require('dotenv').config();
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const mode   = args.includes('--merge') ? 'merge' : 'exact';
const emailIdx = args.indexOf('--email');
const email = emailIdx >= 0 ? args[emailIdx + 1] : null;

const _envProd = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
const db = require('../server/db/database');
process.env.NODE_ENV = _envProd || '';

function listUsers() {
  if (email) {
    const u = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
    return u ? [u] : [];
  }
  return db.prepare('SELECT id, email FROM users ORDER BY id').all();
}

function dedupeUser(userId, mode) {
  const stocks = db.prepare(`
    SELECT id, symbol, company_name, quantity, avg_buy_price
    FROM stocks
    WHERE user_id = ?
    ORDER BY symbol, id
  `).all(userId);
  if (!stocks.length) return { groups: [], plannedDeletes: 0, plannedUpdates: 0 };

  // Group by symbol
  const bySymbol = {};
  for (const s of stocks) {
    const k = (s.symbol || '').toUpperCase();
    (bySymbol[k] = bySymbol[k] || []).push(s);
  }

  const plan = []; // { symbol, kept: row, removed: [rows], merged: bool, newQty?, newAvg? }
  for (const [sym, rows] of Object.entries(bySymbol)) {
    if (rows.length < 2) continue;

    if (mode === 'exact') {
      // Group exact duplicates inside this symbol
      const seen = new Map(); // key → first row
      const dupGroups = new Map(); // first.id → [duplicates]
      for (const r of rows) {
        const key = `${r.quantity}|${r.avg_buy_price}`;
        if (!seen.has(key)) seen.set(key, r);
        else {
          const first = seen.get(key);
          if (!dupGroups.has(first.id)) dupGroups.set(first.id, []);
          dupGroups.get(first.id).push(r);
        }
      }
      for (const [keepId, dups] of dupGroups) {
        if (!dups.length) continue;
        plan.push({ symbol: sym, kept: rows.find(r => r.id === keepId), removed: dups, merged: false });
      }
    } else {
      // merge: collapse all rows for this symbol
      const totalQty = rows.reduce((s, r) => s + Number(r.quantity || 0), 0);
      if (totalQty <= 0) continue;
      const weightedSum = rows.reduce((s, r) => s + Number(r.quantity || 0) * Number(r.avg_buy_price || 0), 0);
      const newAvg = weightedSum / totalQty;
      const kept = rows[0];
      const removed = rows.slice(1);
      plan.push({
        symbol: sym, kept, removed, merged: true,
        newQty: totalQty, newAvg: Number(newAvg.toFixed(4)),
        oldQty: kept.quantity, oldAvg: kept.avg_buy_price
      });
    }
  }

  const plannedDeletes = plan.reduce((s, g) => s + g.removed.length, 0);
  const plannedUpdates = plan.filter(g => g.merged).length;
  return { groups: plan, plannedDeletes, plannedUpdates };
}

function applyPlan(userId, plan) {
  const tx = db.transaction(() => {
    for (const g of plan) {
      if (g.merged) {
        db.prepare('UPDATE stocks SET quantity = ?, avg_buy_price = ? WHERE id = ? AND user_id = ?')
          .run(g.newQty, g.newAvg, g.kept.id, userId);
      }
      for (const r of g.removed) {
        db.prepare('DELETE FROM stocks WHERE id = ? AND user_id = ?').run(r.id, userId);
      }
    }
  });
  tx();
}

function main() {
  const users = listUsers();
  if (!users.length) {
    console.error(email ? `No user with email ${email}` : 'No users in DB');
    process.exit(1);
  }
  console.log(`Mode: ${mode.toUpperCase()}${dryRun ? ' (DRY RUN)' : ''}`);
  for (const u of users) {
    const { groups, plannedDeletes, plannedUpdates } = dedupeUser(u.id, mode);
    console.log(`\nUser #${u.id} ${u.email}: ${groups.length} dup group(s), -${plannedDeletes} rows, ${plannedUpdates} update(s)`);
    for (const g of groups) {
      if (g.merged) {
        console.log(`  ${g.symbol}: kept #${g.kept.id} (qty ${g.oldQty}→${g.newQty}, avg ₹${g.oldAvg}→₹${g.newAvg}); deleting ${g.removed.length} rows`);
      } else {
        console.log(`  ${g.symbol}: kept #${g.kept.id}; deleting ${g.removed.length} exact dup row(s) [${g.removed.map(r => r.id).join(', ')}]`);
      }
    }
    if (!dryRun && groups.length) {
      applyPlan(u.id, groups);
      console.log(`  applied`);
    }
  }
  if (dryRun) console.log(`\nRe-run without --dry-run to apply.`);
}

try { main(); }
catch (e) { console.error('FAIL:', e.message); process.exit(1); }
