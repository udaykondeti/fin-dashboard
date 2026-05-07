#!/usr/bin/env node
// Reset a user's profiles. Deletes all NON-default profiles for the user
// matched by --email (or all users if no email is given), leaving only the
// is_default=1 row. Data referencing the deleted profile_id is reassigned
// to NULL so it stays visible to the user under "(All profiles)".
//
// Usage:
//   node scripts/reset-profiles.js --email kondetiudaykiran@gmail.com
//   node scripts/reset-profiles.js --email kondetiudaykiran@gmail.com --dry-run
//   node scripts/reset-profiles.js                # all users (asks confirm)
//
// Safe to re-run; idempotent. Default profile is never touched.

require('dotenv').config();
const path = require('path');

// Ensure we hit the right DB path even when run from elsewhere.
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const emailIdx = args.indexOf('--email');
const email = emailIdx >= 0 ? args[emailIdx + 1] : null;
const yes = args.includes('--yes');

// Don't auto-seed — we're just reading/writing existing data.
const _envProd = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
const db = require('../server/db/database');
process.env.NODE_ENV = _envProd || '';

// Tables that carry a nullable profile_id and should be reassigned to NULL
// when their profile is removed. Mirrors the list in CLAUDE.md.
const PROFILE_LINKED_TABLES = [
  'savings_accounts',
  'insurance_policies',
  'nps_accounts',
  'scheduled_payments',
  'advance_tax_payments',
  'earnings',
  'vault_files',
  'ca_access_tokens'
];

function listUsers() {
  if (email) {
    const u = db.prepare('SELECT id, email, name FROM users WHERE email = ?').get(email);
    return u ? [u] : [];
  }
  return db.prepare('SELECT id, email, name FROM users ORDER BY id').all();
}

function listProfiles(userId) {
  return db.prepare('SELECT id, name, is_default FROM profiles WHERE user_id = ? ORDER BY is_default DESC, id').all(userId);
}

function countLinked(profileId) {
  const counts = {};
  for (const tbl of PROFILE_LINKED_TABLES) {
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE profile_id = ?`).get(profileId);
      if (r.n) counts[tbl] = r.n;
    } catch (e) { /* table may not exist */ }
  }
  return counts;
}

function reassignAndDelete(profileId) {
  for (const tbl of PROFILE_LINKED_TABLES) {
    try {
      db.prepare(`UPDATE ${tbl} SET profile_id = NULL WHERE profile_id = ?`).run(profileId);
    } catch (e) { /* ignore */ }
  }
  db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
}

function main() {
  const users = listUsers();
  if (!users.length) {
    console.error(email ? `No user with email ${email}` : 'No users in DB');
    process.exit(1);
  }

  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'WRITE'}`);
  console.log(`Users in scope: ${users.length}\n`);

  let toDelete = [];
  for (const u of users) {
    const profiles = listProfiles(u.id);
    const nonDefault = profiles.filter(p => !p.is_default);
    console.log(`User #${u.id} ${u.email}: ${profiles.length} profiles total (${nonDefault.length} non-default)`);
    for (const p of profiles) {
      const tag = p.is_default ? '   keep (default)' : 'DELETE';
      const linked = countLinked(p.id);
      const linkedSummary = Object.keys(linked).length
        ? ' (linked: ' + Object.entries(linked).map(([k, v]) => `${k}×${v}`).join(', ') + ')'
        : '';
      console.log(`  - profile #${p.id} "${p.name}" → ${tag}${linkedSummary}`);
      if (!p.is_default) toDelete.push(p);
    }
  }

  if (!toDelete.length) {
    console.log('\nNothing to do. All users already have only the default profile.');
    return;
  }

  console.log(`\n${toDelete.length} profile(s) marked for deletion.`);
  if (dryRun) {
    console.log('Re-run without --dry-run to apply.');
    return;
  }
  if (!yes && !email) {
    console.error('Refusing to wipe across all users without --yes flag.');
    process.exit(2);
  }

  for (const p of toDelete) {
    reassignAndDelete(p.id);
    console.log(`  deleted profile #${p.id} "${p.name}"`);
  }
  console.log('\nDone.');
}

try { main(); }
catch (e) { console.error('FAIL:', e.message); process.exit(1); }
