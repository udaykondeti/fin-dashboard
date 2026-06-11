// FileVault → fin-dashboard webhook receiver.
//
// FileVault (separate Mac mini app) processes financial documents with its
// own local AI and POSTs structured items here. This route:
//   1. Verifies the HMAC-SHA256 signature against FILEVAULT_WEBHOOK_SECRET
//   2. Idempotently records the event (event_id UNIQUE) so retries are safe
//   3. Routes each item to its table (stocks / mutual_funds / etc.)
//   4. Reuses server/middleware/dedup#findDuplicate so the same natural-key
//      checks the UI and agent use also apply here
//   5. Returns a per-item summary so FileVault can mark its own state
//
// Payload (POST /api/filevault/webhook):
//   {
//     "event_id":     "fv-2026-06-05T03:00:00Z-abc123",   // REQUIRED, unique
//     "source_file":  "HDFC_statement_2025-05.pdf",        // optional
//     "processed_at": "2026-06-05T03:00:00Z",              // optional
//     "items": [
//       { "kind": "stock",       "symbol":"RELIANCE", "company_name":"Reliance Industries", "quantity":10, "avg_buy_price":2450 },
//       { "kind": "us_stock",    "symbol":"TSLA",     "company_name":"Tesla Inc", "quantity":1.5, "avg_buy_price_usd":250 },
//       { "kind": "mutual_fund", "fund_name":"HDFC Flexi Cap — Growth", "units":85, "avg_nav":1881 },
//       { "kind": "payment",     "name":"Netflix", "amount":649, "frequency":"Monthly", "category":"Subscription" },
//       { "kind": "earning",     "source_name":"Salary", "amount":250000, "frequency":"Monthly" },
//       { "kind": "advance_tax", "assessment_year":"2026-27", "installment":"Q1", "amount":50000, "date_paid":"2025-06-15" }
//       // also supported: nps, hand_loan, credit_card, fixed_deposit, savings, insurance
//     ]
//   }
//
// Headers:
//   X-FileVault-Signature: sha256=<hex-of-HMAC-SHA256(secret, raw-body)>
//   X-FileVault-Event-Id:  <same as body.event_id>   (optional belt-and-braces)
//
// Response:
//   200 { ok: true, event_id, items: [{ kind, status:'applied|duplicate|error', message?, existing? }] }
//   401 if signature missing / bad
//   409 if event_id was already processed (idempotent replay)
//   422 if payload is malformed

const express = require('express');
const crypto  = require('crypto');
const db      = require('../db/database');
const { findDuplicate } = require('../middleware/dedup');
const slack   = require('../services/slack');

const router = express.Router();

// Capture raw body for HMAC. We mount this router with a per-route express.raw
// so this routes' req.body stays a Buffer; standard JSON parsing happens after
// signature verification.
router.use(express.raw({ type: '*/*', limit: '5mb' }));

function _verifySignature(rawBody, header) {
  const secret = process.env.FILEVAULT_WEBHOOK_SECRET;
  if (!secret) return { ok: false, reason: 'FILEVAULT_WEBHOOK_SECRET not set' };
  if (!header || typeof header !== 'string') return { ok: false, reason: 'missing signature header' };
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  // timingSafeEqual requires equal-length buffers; convert with explicit length check.
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };
  return { ok: true };
}

function _getOwnerUserId() {
  const row = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  return row ? row.id : null;
}

// Map item.kind → (table, dupParams(item), insertFn(userId, item))
const KIND_HANDLERS = {
  stock: {
    table: 'stocks',
    dupParams: (i) => [i.symbol],
    require: (i) => i.symbol && i.company_name && i.quantity && i.avg_buy_price,
    insert: (userId, i) => db.prepare(
      `INSERT INTO stocks (user_id, symbol, exchange, company_name, quantity, avg_buy_price, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, String(i.symbol).toUpperCase(), i.exchange || 'NSE', i.company_name,
          Number(i.quantity), Number(i.avg_buy_price), i.notes || null)
  },
  us_stock: {
    table: 'us_stocks',
    dupParams: (i) => [i.symbol],
    require: (i) => i.symbol && i.company_name && i.quantity && i.avg_buy_price_usd,
    insert: (userId, i) => db.prepare(
      `INSERT INTO us_stocks (user_id, symbol, company_name, quantity, avg_buy_price_usd, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, String(i.symbol).toUpperCase(), i.company_name,
          Number(i.quantity), Number(i.avg_buy_price_usd), i.notes || null)
  },
  mutual_fund: {
    table: 'mutual_funds',
    dupParams: (i) => [i.fund_name],
    require: (i) => i.fund_name && i.units && i.avg_nav,
    insert: (userId, i) => db.prepare(
      `INSERT INTO mutual_funds (user_id, fund_name, folio_number, units, avg_nav, fund_type, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, i.fund_name, i.folio_number || null,
          Number(i.units), Number(i.avg_nav), i.fund_type || 'Equity', i.notes || null)
  },
  payment: {
    table: 'scheduled_payments',
    dupParams: (i) => [i.name],
    require: (i) => i.name && i.amount,
    insert: (userId, i) => db.prepare(
      `INSERT INTO scheduled_payments (user_id, name, amount, frequency, category, next_due_date, auto_debit, notes, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'filevault')`
    ).run(userId, i.name, Number(i.amount), i.frequency || 'Monthly',
          i.category || 'Other', i.next_due_date || null,
          i.auto_debit ? 1 : 0, i.notes || null)
  },
  earning: {
    table: 'earnings',
    dupParams: (i) => [i.source_name],
    require: (i) => i.source_name && i.amount,
    insert: (userId, i) => db.prepare(
      `INSERT INTO earnings (user_id, source_name, source_type, amount, frequency, share_percentage, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, i.source_name, i.source_type || 'Other',
          Number(i.amount), i.frequency || 'Monthly',
          Number(i.share_percentage) || 100, i.notes || null)
  },
  advance_tax: {
    table: 'advance_tax_payments',
    dupParams: (i) => [i.assessment_year, i.installment],
    require: (i) => i.assessment_year && i.installment && i.amount && i.date_paid,
    insert: (userId, i) => db.prepare(
      `INSERT INTO advance_tax_payments (user_id, assessment_year, installment, amount, date_paid, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, i.assessment_year, i.installment,
          Number(i.amount), i.date_paid, i.notes || null)
  },
  nps: {
    table: 'nps_accounts',
    dupParams: (i) => [i.pran, i.tier || 'Tier I'],
    require: (i) => i.pran,
    insert: (userId, i) => db.prepare(
      `INSERT INTO nps_accounts (user_id, pran, tier, total_invested, current_value, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, i.pran, i.tier || 'Tier I',
          Number(i.total_invested) || 0, Number(i.current_value) || 0, i.notes || null)
  }
};

// ─── POST /api/filevault/webhook ────────────────────────────────────────────
router.post('/webhook', (req, res) => {
  // 1. Verify signature against the RAW body (req.body is still a Buffer here)
  const raw = req.body;
  if (!Buffer.isBuffer(raw) || raw.length === 0) {
    return res.status(422).json({ error: 'empty body' });
  }
  const sig = _verifySignature(raw, req.header('X-FileVault-Signature') || '');
  if (!sig.ok) return res.status(401).json({ error: 'unauthorized', reason: sig.reason });

  // 2. Parse JSON now that signature is verified
  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch (e) { return res.status(422).json({ error: 'invalid JSON: ' + e.message }); }
  if (!body || typeof body !== 'object') return res.status(422).json({ error: 'body must be a JSON object' });

  const { event_id, source_file, items } = body;
  if (!event_id || typeof event_id !== 'string') return res.status(422).json({ error: 'event_id required' });
  if (!Array.isArray(items)) return res.status(422).json({ error: 'items must be an array' });

  const headerEventId = req.header('X-FileVault-Event-Id');
  if (headerEventId && headerEventId !== event_id) {
    return res.status(422).json({ error: 'event_id header/body mismatch' });
  }

  // 3. Top-level idempotency — replays of the same event_id are a no-op
  try {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO filevault_events (event_id, source_file, payload_json, items_total)
       VALUES (?, ?, ?, ?)`
    ).run(event_id, source_file || null, raw.toString('utf8'), items.length);
    if (ins.changes === 0) {
      const existing = db.prepare('SELECT * FROM filevault_events WHERE event_id = ?').get(event_id);
      return res.status(409).json({
        ok: false, error: 'duplicate event', event_id,
        original: { received_at: existing.received_at, items_applied: existing.items_applied,
                    items_duplicate: existing.items_duplicate, items_error: existing.items_error }
      });
    }
  } catch (e) {
    return res.status(500).json({ error: 'event insert failed', message: e.message });
  }

  // 4. Resolve owner — single-user app, first user wins.
  const userId = _getOwnerUserId();
  if (!userId) return res.status(500).json({ error: 'no users in DB' });

  // 5. Process each item
  let applied = 0, duplicate = 0, errored = 0;
  const results = items.map((item, idx) => {
    if (!item || typeof item !== 'object' || !item.kind) {
      errored++;
      return { index: idx, status: 'error', message: 'item.kind required' };
    }
    const handler = KIND_HANDLERS[item.kind];
    if (!handler) {
      errored++;
      return { index: idx, kind: item.kind, status: 'error', message: `unknown kind '${item.kind}'` };
    }
    if (!handler.require(item)) {
      errored++;
      return { index: idx, kind: item.kind, status: 'error', message: 'required fields missing' };
    }

    const dup = findDuplicate(handler.table, userId, handler.dupParams(item));
    if (dup) {
      duplicate++;
      return { index: idx, kind: item.kind, status: 'duplicate', existing: dup };
    }

    try {
      const r = handler.insert(userId, item);
      applied++;
      return { index: idx, kind: item.kind, status: 'applied', id: Number(r.lastInsertRowid) };
    } catch (e) {
      errored++;
      return { index: idx, kind: item.kind, status: 'error', message: e.message };
    }
  });

  // 6. Update the event row with the tally
  db.prepare(
    `UPDATE filevault_events SET processed_at = CURRENT_TIMESTAMP,
       items_applied = ?, items_duplicate = ?, items_error = ?
     WHERE event_id = ?`
  ).run(applied, duplicate, errored, event_id);

  // 7. Slack notification — best-effort
  const tag = source_file ? `*${source_file}*` : `event \`${event_id}\``;
  const msg = errored > 0
    ? `📨 FileVault ${tag}: ${applied} applied · ${duplicate} duplicate · ⚠️ ${errored} error`
    : (applied > 0
        ? `📨 FileVault ${tag}: ${applied} applied · ${duplicate} duplicate`
        : `📨 FileVault ${tag}: nothing new (${duplicate} duplicate)`);
  slack.notify(msg).catch(() => {});

  res.json({ ok: true, event_id, summary: { applied, duplicate, errored, total: items.length }, items: results });
});

// ─── GET /api/filevault/events (admin observability) ────────────────────────
// Returns the most recent events so the dashboard can show a 'FileVault'
// activity feed. Requires authMiddleware (mounted in index.js).
router.get('/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = db.prepare(
    `SELECT id, event_id, source_file, received_at, processed_at,
            items_total, items_applied, items_duplicate, items_error, error_message
       FROM filevault_events ORDER BY id DESC LIMIT ?`
  ).all(limit);
  res.json({ events: rows, count: rows.length });
});

module.exports = router;
