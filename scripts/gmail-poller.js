#!/usr/bin/env node
// Gmail payment poller. Run via PM2 cron daily (see ecosystem.config.js).
// For each user with Gmail connected, fetches recent payment/bill emails,
// sends them to Ollama (mistral) to extract structured payment data, and
// upserts rows into scheduled_payments.
//
// Also exported as runPollForUser(userId) for the manual /api/gmail/poll route.

require('dotenv').config();
const path = require('path');
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'finance.db');
process.env.NODE_ENV = 'production';

const db          = require('../server/db/database');
const gmailSvc    = require('../server/services/gmailService');
const ollamaClient = require('../server/services/ollamaClient');

const MODEL       = process.env.OLLAMA_MODEL || 'mistral';
// Look back 2 days on each run (daily cron + overlap for safety)
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

const SYSTEM_PROMPT = `You are a financial assistant. Given an email about a bill, payment, or subscription,
extract structured payment information if present.

Respond with a JSON object (no markdown, no explanation) in this exact shape:
{
  "name": "short payment name (e.g. Electricity Bill, Netflix, EMI - HDFC)",
  "amount": 0,
  "currency": "INR",
  "frequency": "monthly|quarterly|annual|one-time|weekly",
  "category": "utilities|subscriptions|emi|insurance|rent|taxes|other",
  "due_date": "YYYY-MM-DD or null",
  "payee": "company/merchant name",
  "confidence": 0.0
}

Rules:
- amount must be a number (no currency symbols)
- confidence 0.0–1.0; use < 0.6 if unsure
- If the email is NOT about a payment/bill, respond with: {"skip": true}`;

async function extractPayment(emailText) {
  try {
    const r = await ollamaClient.chatCompletion({
      model: MODEL,
      system: SYSTEM_PROMPT,
      user:   `Email content:\n\n${emailText.slice(0, 4000)}`,
      maxTokens: 300,
      timeoutMs: 30000
    });
    const raw = r.output.trim().replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function upsertPayment(userId, data) {
  // Upsert by (user_id, name) — avoids duplicates across daily runs
  const existing = db.prepare(
    'SELECT id FROM scheduled_payments WHERE user_id = ? AND name = ?'
  ).get(userId, data.name);

  if (existing) {
    db.prepare(`
      UPDATE scheduled_payments
      SET amount = ?, frequency = ?, category = ?, next_due_date = COALESCE(?, next_due_date),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(data.amount, data.frequency, data.category, data.due_date || null, existing.id);
    return { action: 'updated', id: existing.id };
  }

  const r = db.prepare(`
    INSERT INTO scheduled_payments (user_id, name, amount, frequency, category, next_due_date, source)
    VALUES (?, ?, ?, ?, ?, ?, 'gmail')
  `).run(userId, data.name, data.amount, data.frequency, data.category, data.due_date || null);
  return { action: 'inserted', id: r.lastInsertRowid };
}

async function runPollForUser(userId) {
  const since  = new Date(Date.now() - LOOKBACK_MS);
  const emails = await gmailSvc.fetchEmails(userId, { sinceDate: since, maxResults: 30 });
  const results = { processed: 0, inserted: 0, updated: 0, skipped: 0, errors: 0 };

  for (const email of emails) {
    const text = `Subject: ${email.subject}\nFrom: ${email.from}\nDate: ${email.date}\n\n${email.body || email.snippet}`;
    let parsed;
    try {
      parsed = await extractPayment(text);
    } catch (e) {
      results.errors++;
      continue;
    }

    if (!parsed || parsed.skip || parsed.confidence < 0.6) {
      results.skipped++;
      continue;
    }

    try {
      const r = upsertPayment(userId, parsed);
      results[r.action === 'inserted' ? 'inserted' : 'updated']++;
    } catch (e) {
      console.error(`[gmail-poller] upsert failed for user ${userId}:`, e.message);
      results.errors++;
    }
    results.processed++;
  }

  return { emails: emails.length, ...results };
}

async function main() {
  if (!gmailSvc.isGmailConfigured()) {
    console.log('[gmail-poller] GMAIL_CLIENT_ID not set — skipping.');
    process.exit(0);
  }

  const users = db.prepare(`
    SELECT u.id, u.email FROM users u
    INNER JOIN gmail_tokens g ON g.user_id = u.id
  `).all();

  if (!users.length) {
    console.log('[gmail-poller] No users with Gmail connected — skipping.');
    process.exit(0);
  }

  for (const user of users) {
    try {
      const r = await runPollForUser(user.id);
      console.log(`[gmail-poller] user=${user.id} emails=${r.emails} inserted=${r.inserted} updated=${r.updated} skipped=${r.skipped}`);
    } catch (e) {
      console.error(`[gmail-poller] user=${user.id} failed:`, e.message);
    }
  }
  process.exit(0);
}

module.exports = { runPollForUser };

if (require.main === module) {
  main().catch(err => {
    console.error('[gmail-poller] Fatal:', err);
    process.exit(1);
  });
}
