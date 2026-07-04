#!/usr/bin/env node
// Gmail connection diagnostic. Lists every user, shows which one holds Gmail
// OAuth tokens (and whether they still work), and which user the Gmail MCP /
// poller will act for — so an account mismatch (you connected as one user, the
// MCP targets another) is obvious.
//
// Usage:  npm run gmail:check     (or)  node scripts/gmail-check.js

require('dotenv').config();
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');

const db = require('../server/db/database');
const g  = require('../server/services/gmailService');

// Mirrors resolveUserId() in mcp/gmail-mcp.mjs so this reports the same target.
function mcpTargetUserId() {
  if (process.env.MCP_GMAIL_USER_ID) return Number(process.env.MCP_GMAIL_USER_ID);
  const email = process.env.SEED_ADMIN_EMAIL || 'kondetiudaykiran@gmail.com';
  const byEmail = db.prepare('SELECT id FROM users WHERE email = ? ORDER BY id LIMIT 1').get(email);
  if (byEmail) return byEmail.id;
  const first = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  return first ? first.id : null;
}

(async () => {
  console.log('configured:', g.isGmailConfigured(), ' (GMAIL_CLIENT_ID / SECRET loaded)\n');

  const users = db.prepare('SELECT id, email FROM users ORDER BY id').all();
  if (!users.length) { console.log('No users in the database.'); process.exit(1); }

  const target = mcpTargetUserId();
  let connectedUserId = null;

  console.log('users:');
  for (const u of users) {
    const hasTokens = !!g.getTokens(u.id);
    let state = hasTokens ? 'tokens: yes' : 'tokens: no';
    if (hasTokens) {
      const check = await g.checkCredentials(u.id);
      state += check.valid === false ? `  (INVALID: ${check.reason || '?'})` : '  (valid ✓)';
      if (check.valid !== false) connectedUserId = connectedUserId ?? u.id;
    }
    const marks = [];
    if (u.id === target) marks.push('← MCP target');
    console.log(`  id ${u.id}  ${u.email.padEnd(32)} ${state} ${marks.join(' ')}`);
  }

  console.log('\nMCP / poller will act for user id:', target,
    '(override with MCP_GMAIL_USER_ID)');

  if (connectedUserId && connectedUserId !== target) {
    console.log(`\n⚠  MISMATCH: Gmail is connected on user id ${connectedUserId}, but the MCP targets id ${target}.`);
    console.log(`   Fix: set MCP_GMAIL_USER_ID=${connectedUserId} in .env, or connect Gmail while logged in as the target user.`);
  } else if (connectedUserId) {
    console.log('\n✅ Gmail is connected on the MCP target user — Sync button and MCP are good to go.');
  } else {
    console.log('\n❌ No user has valid Gmail tokens yet — connect via the fin.kirakon.com banner.');
  }
  process.exit(0);
})();
