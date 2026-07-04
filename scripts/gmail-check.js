#!/usr/bin/env node
// Quick Gmail connection diagnostic. Prints whether Gmail is configured for the
// server, whether the (seeded admin / lowest-id) user has stored OAuth tokens,
// and whether those tokens still work against Google.
//
// Usage:  npm run gmail:check     (or)  node scripts/gmail-check.js

require('dotenv').config();
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');

const db = require('../server/db/database');
const g  = require('../server/services/gmailService');

(async () => {
  const u = db.prepare('SELECT id, email FROM users ORDER BY id LIMIT 1').get();
  if (!u) { console.log('No users in the database.'); process.exit(1); }

  console.log('account:    ', u.email, '(id ' + u.id + ')');
  console.log('configured: ', g.isGmailConfigured(), '  (GMAIL_CLIENT_ID / SECRET loaded)');
  console.log('has tokens: ', !!g.getTokens(u.id), '  (OAuth consent completed)');

  const check = await g.checkCredentials(u.id);
  console.log('check:      ', JSON.stringify(check), '  (tokens work against Google)');

  const ready = g.isGmailConfigured() && check.connected && check.valid !== false;
  console.log('\n' + (ready
    ? '✅ Gmail is connected and working — the Sync button and MCP can read your inbox.'
    : '❌ Not ready yet — see which line above is false and reconnect via the fin.kirakon.com banner.'));
  process.exit(0);
})();
