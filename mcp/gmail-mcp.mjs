#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// fin-dashboard Gmail MCP
//
// Exposes the connected Gmail inbox to any MCP client (Claude Desktop,
// Open WebUI, mcphost, …) so an AI can READ finance emails + their ATTACHMENTS
// (PDF / image-OCR / DOCX / XLSX) and WRITE the results straight into
// fin.kirakon.com — as scheduled payments (recurring bills) or one-off
// transactions.
//
// Division of labour (MCP-native): this server does the plumbing — Gmail
// fetch, attachment download + text extraction, and DB writes. The calling
// model does the reasoning — deciding what's a bill, pulling the amount/date,
// choosing a category. That keeps extraction quality tied to the client model
// and needs no local LLM here.
//
// Auth: reuses the OAuth tokens the user already linked in the fin-dashboard
// UI (the "Connect Gmail" banner). Which account it acts for:
//   MCP_GMAIL_USER_ID env  →  else the seeded admin  →  else the lowest user id.
//
// Run:      node mcp/gmail-mcp.mjs        (stdio — an MCP client spawns it)
// Register: bash mcp/setup-gmail-mcp.sh
// ─────────────────────────────────────────────────────────────────────────────

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// stdout is the MCP JSON-RPC channel — nothing else may write to it or the
// framing breaks. Required modules (database.js, etc.) console.log on load, so
// route all stdout logging to stderr before requiring anything.
console.log = (...args) => console.error(...args);

// Resolve the DB before any module that opens it is required (database.js opens
// the handle at load time). Mirrors scripts/gmail-poller.js.
process.env.DB_PATH  = process.env.DB_PATH  || join(__dirname, '..', 'data', 'finance.db');
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
require('dotenv').config({ path: join(__dirname, '..', '.env') });

const db       = require('../server/db/database');
const gmailSvc = require('../server/services/gmailService');

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL || 'kondetiudaykiran@gmail.com';

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveUserId() {
  if (process.env.MCP_GMAIL_USER_ID) return Number(process.env.MCP_GMAIL_USER_ID);
  const byEmail = db.prepare('SELECT id FROM users WHERE email = ? ORDER BY id LIMIT 1').get(ADMIN_EMAIL);
  if (byEmail) return byEmail.id;
  const first = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  return first ? first.id : 1;
}

const jsonText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
const errText  = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

function requireGmailReady() {
  if (!gmailSvc.isGmailConfigured()) {
    throw new Error('Gmail is not configured on the server (set GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET in .env).');
  }
  const userId = resolveUserId();
  if (!gmailSvc.getTokens(userId)) {
    throw new Error('Gmail is not connected for this account. Open fin.kirakon.com and use the "Connect Gmail" banner first.');
  }
  return userId;
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'fin-gmail', version: '1.0.0' });

server.tool(
  'gmail_status',
  'Report whether Gmail is configured, connected, and whether the stored credentials still work for the active fin-dashboard account.',
  {},
  async () => {
    const configured = gmailSvc.isGmailConfigured();
    if (!configured) return jsonText({ configured: false, connected: false, valid: false });
    const userId = resolveUserId();
    const user   = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
    const check  = await gmailSvc.checkCredentials(userId);
    return jsonText({
      configured: true,
      account: user ? user.email : `user#${userId}`,
      connected: !!check.connected,
      valid: check.connected ? check.valid !== false : false,
      reason: check.reason || null,
    });
  }
);

server.tool(
  'search_finance_emails',
  'Search the inbox for bill / payment / statement emails. Returns lightweight metadata (subject, sender, date, snippet, and which attachments each has). Use read_email to pull full content.',
  {
    days: z.number().int().min(1).max(365).optional().describe('How many days back to search (default 14).'),
    query: z.string().optional().describe('Extra Gmail search query, e.g. "from:hdfc" or "subject:electricity". Combined with the default bill/invoice filter when omitted.'),
    maxResults: z.number().int().min(1).max(50).optional().describe('Max emails to return (default 25).'),
  },
  async ({ days = 14, query, maxResults = 25 }) => {
    try {
      const userId = requireGmailReady();
      const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const emails = await gmailSvc.fetchEmails(userId, { query: query || '', sinceDate, maxResults });
      return jsonText({
        count: emails.length,
        emails: emails.map(e => ({
          messageId: e.id,
          subject: e.subject,
          from: e.from,
          date: e.date,
          snippet: e.snippet,
          hasAttachments: e.attachments.length > 0,
          attachments: e.attachments.map(a => ({ filename: a.filename, mimeType: a.mimeType })),
        })),
      });
    } catch (e) { return errText(e.message); }
  }
);

server.tool(
  'read_email',
  'Read a single email in full: body text plus the extracted text of every attachment (PDF, image via OCR, DOCX, XLSX, CSV). This is how you inspect a bill before recording it.',
  {
    messageId: z.string().describe('The Gmail message id returned by search_finance_emails.'),
    includeAttachments: z.boolean().optional().describe('Download + extract attachment text (default true). Set false for a fast body-only read.'),
  },
  async ({ messageId, includeAttachments = true }) => {
    try {
      const userId = requireGmailReady();
      const email = await gmailSvc.getMessageById(userId, messageId);
      const out = {
        messageId,
        subject: email.subject,
        from: email.from,
        date: email.date,
        body: email.body,
        attachments: [],
      };
      if (includeAttachments && email.attachments?.length) {
        for (const att of email.attachments) {
          const extracted = await gmailSvc.downloadAttachmentText(userId, {
            messageId, attachmentId: att.attachmentId, mimeType: att.mimeType, filename: att.filename,
          }).catch(err => ({ text: '', kind: 'error', warnings: [err.message] }));
          out.attachments.push({
            filename: att.filename,
            mimeType: att.mimeType,
            kind: extracted.kind,
            text: extracted.text,
            warnings: extracted.warnings,
          });
        }
      }
      return jsonText(out);
    } catch (e) { return errText(e.message); }
  }
);

server.tool(
  'add_scheduled_payment',
  'Record a recurring bill / payment on the fin-dashboard (scheduled_payments). Upserts by name so re-running does not duplicate. Use for anything that repeats: utilities, EMIs, subscriptions, insurance, rent.',
  {
    name: z.string().describe('Short payment name, e.g. "Electricity Bill", "Netflix", "EMI - HDFC".'),
    amount: z.number().describe('Amount as a number (no currency symbol).'),
    frequency: z.enum(['Monthly', 'Quarterly', 'Annual', 'Weekly', 'One-time']).optional().describe('Default Monthly.'),
    category: z.string().optional().describe('utilities | subscriptions | emi | insurance | rent | taxes | other (default other).'),
    due_date: z.string().optional().describe('Next due date as YYYY-MM-DD, if known.'),
    notes: z.string().optional().describe('Free text, e.g. the source email subject.'),
  },
  async ({ name, amount, frequency = 'Monthly', category = 'other', due_date = null, notes = null }) => {
    try {
      const userId = requireGmailReady();
      const existing = db.prepare('SELECT id FROM scheduled_payments WHERE user_id = ? AND name = ?').get(userId, name);
      if (existing) {
        db.prepare(`UPDATE scheduled_payments
          SET amount = ?, frequency = ?, category = ?, next_due_date = COALESCE(?, next_due_date),
              notes = COALESCE(?, notes), source = 'gmail-mcp', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`).run(amount, frequency, category, due_date, notes, existing.id);
        return jsonText({ action: 'updated', id: existing.id, name, amount });
      }
      const r = db.prepare(`INSERT INTO scheduled_payments
        (user_id, name, amount, frequency, category, next_due_date, notes, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'gmail-mcp')`)
        .run(userId, name, amount, frequency, category, due_date, notes);
      return jsonText({ action: 'inserted', id: r.lastInsertRowid, name, amount });
    } catch (e) { return errText(e.message); }
  }
);

server.tool(
  'add_transaction',
  'Record a one-off transaction on the fin-dashboard (transactions table). Use for a single dated payment/receipt (a specific bill paid, a purchase). Deduplicated by source_ref — pass the Gmail messageId so the same email is never recorded twice.',
  {
    date: z.string().describe('Transaction date as YYYY-MM-DD.'),
    description: z.string().describe('What it was, e.g. "Amazon order 1234" or "Electricity — Aug".'),
    amount: z.number().describe('Amount as a positive number.'),
    direction: z.enum(['debit', 'credit']).optional().describe('debit = money out (default), credit = money in.'),
    category: z.string().optional().describe('Free-form category, e.g. utilities, shopping, salary.'),
    source_ref: z.string().optional().describe('Dedup key — pass the Gmail messageId so re-imports are idempotent.'),
    notes: z.string().optional(),
  },
  async ({ date, description, amount, direction = 'debit', category = null, source_ref = null, notes = null }) => {
    try {
      const userId = requireGmailReady();
      const ref = source_ref || null;
      if (ref) {
        const dup = db.prepare("SELECT id FROM transactions WHERE user_id = ? AND source = 'gmail-mcp' AND source_ref = ?").get(userId, ref);
        if (dup) return jsonText({ action: 'skipped_duplicate', id: dup.id, source_ref: ref });
      }
      const r = db.prepare(`INSERT INTO transactions
        (user_id, date, description, amount, direction, category, source, source_ref, notes)
        VALUES (?, ?, ?, ?, ?, ?, 'gmail-mcp', ?, ?)`)
        .run(userId, date, description, amount, direction, category, ref, notes);
      return jsonText({ action: 'inserted', id: r.lastInsertRowid, description, amount, direction });
    } catch (e) { return errText(e.message); }
  }
);

server.tool(
  'list_scheduled_payments',
  'List recurring payments already on the fin-dashboard, so you can check what exists before adding. Newest first.',
  {
    limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 50).'),
  },
  async ({ limit = 50 }) => {
    try {
      const userId = resolveUserId();
      const rows = db.prepare(`SELECT id, name, amount, frequency, category, next_due_date, source
        FROM scheduled_payments WHERE user_id = ? ORDER BY id DESC LIMIT ?`).all(userId, limit);
      return jsonText({ count: rows.length, payments: rows });
    } catch (e) { return errText(e.message); }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
