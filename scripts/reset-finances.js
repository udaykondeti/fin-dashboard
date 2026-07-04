#!/usr/bin/env node
// Wipe ALL financial data so you can start entering finances from scratch.
//
// CLEARS every holding / transaction / document table (and the net-worth
// snapshot history that drives the chart).
// KEEPS your logins, profiles, household links, and Gmail connection so you
// don't have to set those up again.
//
// Usage:
//   node scripts/reset-finances.js --yes          (or)  npm run finances:reset -- --yes
// Without --yes it only PREVIEWS what would be deleted.

require('dotenv').config();
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');

const db = require('../server/db/database');

// Data tables to empty. Anything not listed here is preserved.
const CLEAR = [
  'stocks', 'mutual_funds', 'fixed_deposits', 'us_stocks',
  'credit_cards', 'loans', 'hand_loans',
  'savings_accounts', 'insurance_policies', 'nps_accounts',
  'scheduled_payments', 'advance_tax_payments', 'earnings', 'earning_shares',
  'transactions',
  'properties', 'rental_agreements', 'property_tax_payments', 'property_expenses',
  'vault_files', 'vault_dedup_keys',
  'networth_snapshots', 'activity_log',
  'agent_threads', 'agent_messages', 'agent_artifacts', 'agent_calls',
  'filevault_events',
];

// Explicitly preserved (shown for reassurance).
const KEEP = ['users', 'profiles', 'user_links', 'gmail_tokens', 'ca_access_tokens', 'schema_migrations', 'watcher_state'];

const apply = process.argv.includes('--yes');

function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function count(name) {
  try { return db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n; } catch { return 0; }
}

const present = CLEAR.filter(tableExists);
const rows = present.map(t => ({ table: t, before: count(t) }));
const totalRows = rows.reduce((s, r) => s + r.before, 0);

console.log(apply ? 'RESETTING financial data…\n' : 'PREVIEW (no changes — pass --yes to apply)\n');
for (const r of rows) if (r.before) console.log(`  ${r.table.padEnd(24)} ${r.before} rows`);
console.log(`\n  ${totalRows} rows across ${rows.filter(r => r.before).length} tables would be cleared.`);
console.log('  Preserved:', KEEP.filter(tableExists).join(', '));

if (!apply) {
  console.log('\nRe-run with --yes to actually wipe.');
  process.exit(0);
}

const tx = db.transaction(() => {
  db.pragma('foreign_keys = OFF');
  for (const t of present) db.prepare(`DELETE FROM ${t}`).run();
  // reset AUTOINCREMENT counters so new entries start at id 1 (best-effort)
  try { for (const t of present) db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(t); } catch {}
  db.pragma('foreign_keys = ON');
});
tx();

console.log('\n✅ Done. All financial data cleared — your login, profiles, links and Gmail connection are intact.');
console.log('   Add your holdings fresh from the dashboard; net worth will reflect only what you enter.');
process.exit(0);
