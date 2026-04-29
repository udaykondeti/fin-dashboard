#!/usr/bin/env node
// Groq-powered DB-change watcher.
//
// Run via PM2 cron every 5 minutes (see ecosystem.config.js). For each user,
// scans the major user-data tables for rows newer than the last watch tick,
// asks Groq to summarise them into 1-3 plain-English bullets, and inserts
// the result into activity_log. The dashboard's Activity feed reads from
// activity_log (replacing the previous hardcoded mock).
//
// This script is one-shot: it processes a single tick and exits. PM2's
// cron_restart triggers the next run.

require('dotenv').config();

const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');

// Don't auto-seed inside the watcher; it shouldn't ever create users.
const _envProd = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';
const db = require('../server/db/database');
process.env.NODE_ENV = _envProd || '';

const { runTask, isGroqConfigured } = require('../server/services/agent');

// Tables we monitor — each maps to a single column we read for a row label.
// Anything missing a `created_at` column is excluded; updates/deletes are not
// detected in this v1 (would need triggers or audit columns).
const TABLES = [
  { table: 'stocks',                fields: 'symbol, company_name, quantity, avg_buy_price' },
  { table: 'mutual_funds',          fields: 'fund_name, units, avg_nav' },
  { table: 'fixed_deposits',        fields: 'bank_name, principal, interest_rate, maturity_date' },
  { table: 'us_stocks',             fields: 'symbol, company_name, quantity, avg_buy_price_usd' },
  { table: 'credit_cards',          fields: 'card_name, bank, card_limit, outstanding_balance' },
  { table: 'loans',                 fields: 'loan_type, lender, principal_amount, outstanding_amount, emi_amount' },
  { table: 'hand_loans',            fields: 'person_name, direction, amount, status' },
  { table: 'savings_accounts',      fields: 'bank_name, account_type, balance, interest_rate' },
  { table: 'insurance_policies',    fields: 'policy_name, insurer, policy_type, premium_amount, cover_amount' },
  { table: 'nps_accounts',          fields: 'pran, tier, total_invested, current_value' },
  { table: 'scheduled_payments',    fields: 'name, amount, frequency, category, next_due_date' },
  { table: 'advance_tax_payments',  fields: 'assessment_year, installment, amount, date_paid' },
  { table: 'earnings',              fields: 'source_name, source_type, amount, frequency' },
  { table: 'properties',            fields: 'name, property_type, city, current_value' },
  { table: 'vault_files',           fields: 'original_filename, category, subcategory, financial_year' }
];

const WATCHER_NAME = 'groq_db_watcher';
// First run: look at the last 30 minutes so we don't dump the entire DB into Groq.
const FIRST_RUN_LOOKBACK_MS = 30 * 60 * 1000;
// Hard cap on rows per tick per user — protects against a bulk import flooding Groq.
const MAX_ROWS_PER_TICK = 50;

function getActiveUsers() {
  return db.prepare('SELECT id, email FROM users').all();
}

function getLastProcessedAt(userId) {
  const row = db.prepare(
    'SELECT last_processed_at FROM watcher_state WHERE name = ? AND user_id = ?'
  ).get(WATCHER_NAME, userId);
  if (row && row.last_processed_at) return row.last_processed_at;
  // First run: pick a recent floor instead of the epoch.
  return new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString().replace('T', ' ').slice(0, 19);
}

function setLastProcessedAt(userId, isoTs) {
  db.prepare(`
    INSERT INTO watcher_state (name, user_id, last_processed_at, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(name, user_id) DO UPDATE SET
      last_processed_at = excluded.last_processed_at,
      updated_at = CURRENT_TIMESTAMP
  `).run(WATCHER_NAME, userId, isoTs);
}

function collectChanges(userId, sinceTs) {
  const events = [];
  for (const t of TABLES) {
    let rows;
    try {
      rows = db.prepare(
        `SELECT id, ${t.fields}, created_at FROM ${t.table}
         WHERE user_id = ? AND created_at > ?
         ORDER BY created_at ASC LIMIT ${MAX_ROWS_PER_TICK}`
      ).all(userId, sinceTs);
    } catch (err) {
      // Table may not exist on older DBs; skip silently.
      continue;
    }
    rows.forEach(r => events.push({ table: t.table, row: r }));
    if (events.length >= MAX_ROWS_PER_TICK) break;
  }
  // Newest events first into the prompt is fine; we'll just present chronologically.
  events.sort((a, b) => (a.row.created_at || '').localeCompare(b.row.created_at || ''));
  return events.slice(0, MAX_ROWS_PER_TICK);
}

function buildPrompt(events) {
  const SYSTEM = [
    'You watch a personal finance dashboard\'s database.',
    'Given a list of newly-inserted rows from the last few minutes, produce up to 3 short bullet points (one line each) describing in plain English what changed, in chronological order.',
    'Use Indian Rupees (₹) for amounts. Be concrete (include names, banks, amounts) but concise — no preamble, no markdown headers.',
    'If there is nothing meaningful to report, output the single word: NONE.'
  ].join('\n');
  const USER = JSON.stringify(events, null, 2);
  return { SYSTEM, USER };
}

async function processUser(user) {
  const sinceTs = getLastProcessedAt(user.id);
  const events = collectChanges(user.id, sinceTs);
  const newCutoff = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (!events.length) {
    setLastProcessedAt(user.id, newCutoff);
    return { user_id: user.id, events: 0, summary: null };
  }
  const { SYSTEM, USER } = buildPrompt(events);
  let summary = '';
  try {
    const r = await runTask({
      userId: user.id,
      taskType: 'summarise_db_changes',
      provider: 'groq',
      systemPrompt: SYSTEM,
      userInput: USER,
      maxTokens: 400
    });
    summary = (r.output || '').trim();
  } catch (err) {
    console.error(`[groq-watcher] runTask failed for user ${user.id}:`, err.message);
    // Still advance the cutoff to avoid re-summarising the same window forever.
    setLastProcessedAt(user.id, newCutoff);
    return { user_id: user.id, events: events.length, error: err.message };
  }

  if (summary && summary.toUpperCase() !== 'NONE') {
    db.prepare(
      'INSERT INTO activity_log (user_id, source, summary, details) VALUES (?, ?, ?, ?)'
    ).run(user.id, 'groq_watcher', summary, JSON.stringify({ event_count: events.length }));
  }
  setLastProcessedAt(user.id, newCutoff);
  return { user_id: user.id, events: events.length, summary };
}

async function main() {
  if (!isGroqConfigured()) {
    console.log('[groq-watcher] GROQ_API_KEY not set — skipping tick.');
    process.exit(0);
  }
  const users = getActiveUsers();
  if (!users.length) {
    console.log('[groq-watcher] No users — skipping tick.');
    process.exit(0);
  }
  for (const user of users) {
    try {
      const r = await processUser(user);
      console.log(`[groq-watcher] user=${user.id} events=${r.events} ${r.summary ? '✓' : '(no entry)'}`);
    } catch (err) {
      console.error(`[groq-watcher] user=${user.id} failed:`, err.message);
    }
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[groq-watcher] Fatal:', err);
  process.exit(1);
});
