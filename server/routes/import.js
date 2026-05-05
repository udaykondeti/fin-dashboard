const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// Simple CSV parser — handles quoted fields and common delimiters
function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return [];
  const headers = splitCSVLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitCSVLine(lines[i]);
    if (vals.length < 2 || vals.every(v => !v.trim())) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });
    rows.push(row);
  }
  return { headers, rows };
}

function splitCSVLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; }
    else if ((c === ',' || c === '\t') && !inQ) { result.push(cur.replace(/^"|"$/g, '').trim()); cur = ''; }
    else cur += c;
  }
  result.push(cur.replace(/^"|"$/g, '').trim());
  return result;
}

function numOf(val) {
  if (!val) return null;
  const n = parseFloat(String(val).replace(/[₹,\s]/g, ''));
  return isNaN(n) ? null : n;
}

// Detect format and map rows to a canonical shape
// Returns { type: 'stocks'|'mutual_funds'|'earnings'|'unknown', rows: [...canonical] }
function detectAndMap(parsed) {
  const { headers, rows } = parsed;
  const h = headers.join(',');

  // ── Zerodha Console Holdings export ──────────────────────────────────────
  // Headers: instrument, isin, qty, avg_cost, ltp, cur_val, p_l, net_chng, day_chng
  if (headers.includes('instrument') && headers.includes('qty') && (headers.includes('avg_cost') || headers.includes('average_cost'))) {
    const avgCol = headers.includes('avg_cost') ? 'avg_cost' : 'average_cost';
    return {
      type: 'stocks',
      rows: rows.map(r => ({
        symbol: (r.instrument || '').toUpperCase().trim(),
        company_name: r.instrument || '',
        quantity: numOf(r.qty),
        avg_buy_price: numOf(r[avgCol])
      })).filter(r => r.symbol && r.quantity > 0)
    };
  }

  // ── Groww Console Holdings (stocks) ──────────────────────────────────────
  // Headers: symbol, company_name or company, quantity, avg_buy_price or average_price
  if (headers.includes('symbol') && (headers.includes('quantity') || headers.includes('qty'))) {
    const qtyCol = headers.includes('quantity') ? 'quantity' : 'qty';
    const priceCol = headers.includes('avg_buy_price') ? 'avg_buy_price'
      : headers.includes('average_price') ? 'average_price'
      : headers.includes('avg_price') ? 'avg_price'
      : headers.includes('buy_avg') ? 'buy_avg'
      : headers.includes('avg_cost') ? 'avg_cost' : null;
    const nameCol = headers.includes('company_name') ? 'company_name'
      : headers.includes('company') ? 'company'
      : headers.includes('name') ? 'name' : 'symbol';
    return {
      type: 'stocks',
      rows: rows.map(r => ({
        symbol: (r.symbol || '').toUpperCase().trim(),
        company_name: r[nameCol] || r.symbol || '',
        quantity: numOf(r[qtyCol]),
        avg_buy_price: priceCol ? numOf(r[priceCol]) : null
      })).filter(r => r.symbol && r.quantity > 0)
    };
  }

  // ── Mutual Fund holdings (Groww / CAMS / KFintech) ───────────────────────
  // Headers: scheme_name or fund_name, units, avg_nav or average_nav, fund_type
  if ((headers.includes('scheme_name') || headers.includes('fund_name') || headers.includes('scheme')) &&
      (headers.includes('units') || headers.includes('quantity'))) {
    const nameCol = headers.includes('fund_name') ? 'fund_name'
      : headers.includes('scheme_name') ? 'scheme_name' : 'scheme';
    const unitsCol = headers.includes('units') ? 'units' : 'quantity';
    const navCol = headers.includes('avg_nav') ? 'avg_nav'
      : headers.includes('average_nav') ? 'average_nav'
      : headers.includes('cost_nav') ? 'cost_nav'
      : headers.includes('purchase_nav') ? 'purchase_nav' : null;
    const typeCol = headers.includes('fund_type') ? 'fund_type'
      : headers.includes('type') ? 'type' : null;
    return {
      type: 'mutual_funds',
      rows: rows.map(r => ({
        fund_name: r[nameCol] || '',
        units: numOf(r[unitsCol]),
        avg_nav: navCol ? numOf(r[navCol]) : null,
        fund_type: typeCol ? r[typeCol] : null
      })).filter(r => r.fund_name && r.units > 0)
    };
  }

  // ── Earnings / Income CSV ─────────────────────────────────────────────────
  // Headers: source_name or name, amount, frequency, source_type
  if ((headers.includes('source_name') || headers.includes('name')) &&
      headers.includes('amount') && headers.includes('frequency')) {
    const nameCol = headers.includes('source_name') ? 'source_name' : 'name';
    const typeCol = headers.includes('source_type') ? 'source_type'
      : headers.includes('type') ? 'type' : null;
    return {
      type: 'earnings',
      rows: rows.map(r => ({
        source_name: r[nameCol] || '',
        amount: numOf(r.amount),
        frequency: r.frequency || 'Monthly',
        source_type: typeCol ? r[typeCol] : 'salary'
      })).filter(r => r.source_name && r.amount > 0)
    };
  }

  return { type: 'unknown', rows: [] };
}

// POST /api/import/preview  — parse only, return rows without saving
router.post('/preview', (req, res) => {
  const { content, filename } = req.body;
  if (!content) return res.status(400).json({ error: 'No content provided' });
  const parsed = parseCSV(content);
  if (!parsed || !parsed.rows || !parsed.rows.length) {
    return res.status(400).json({ error: 'No rows found in file. Check that the file is a valid CSV.' });
  }
  const mapped = detectAndMap(parsed);
  res.json({
    detected_type: mapped.type,
    headers: parsed.headers,
    row_count: parsed.rows.length,
    sample: mapped.rows.slice(0, 5),
    all_rows: mapped.rows
  });
});

const MAX_IMPORT_ROWS = 5000;
const ALLOWED_FREQUENCIES = new Set(['Monthly','Annual','Quarterly','Weekly','One-time']);

function safeStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function safeNum(v, opts) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return null;
  if (opts && opts.min != null && n < opts.min) return null;
  if (opts && opts.max != null && n > opts.max) return null;
  return n;
}

// POST /api/import/commit  — save parsed rows to DB
router.post('/commit', (req, res) => {
  const { type, rows } = req.body;
  if (!type || !Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'type and rows required' });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return res.status(413).json({ error: `Too many rows. Max ${MAX_IMPORT_ROWS} per import.` });
  }
  const userId = req.user.id;

  const result = { inserted: 0, skipped: 0, errors: [] };

  try {
    if (type === 'stocks') {
      const stmt = db.prepare(`INSERT INTO stocks (user_id, symbol, company_name, quantity, avg_buy_price) VALUES (?,?,?,?,?)`);
      const tx = db.transaction((rs) => {
        for (const r of rs) {
          const symbol = safeStr(r.symbol, 32);
          const name = safeStr(r.company_name || r.symbol, 200);
          const qty = safeNum(r.quantity, { min: 0, max: 1e9 });
          const price = safeNum(r.avg_buy_price, { min: 0, max: 1e9 });
          if (!symbol || qty == null || qty <= 0) {
            result.skipped++; result.errors.push((symbol || '<row>') + ': invalid symbol or quantity');
            continue;
          }
          stmt.run(userId, symbol, name || symbol, qty, price || 0);
          result.inserted++;
        }
      });
      tx(rows);
    } else if (type === 'mutual_funds') {
      const stmt = db.prepare(`INSERT INTO mutual_funds (user_id, fund_name, units, avg_nav, fund_type) VALUES (?,?,?,?,?)`);
      const tx = db.transaction((rs) => {
        for (const r of rs) {
          const name = safeStr(r.fund_name, 300);
          const units = safeNum(r.units, { min: 0, max: 1e12 });
          const nav = safeNum(r.avg_nav, { min: 0, max: 1e9 });
          const ftype = safeStr(r.fund_type, 50) || 'Equity';
          if (!name || units == null || units <= 0) {
            result.skipped++; result.errors.push((name || '<row>') + ': invalid fund_name or units');
            continue;
          }
          stmt.run(userId, name, units, nav || 0, ftype);
          result.inserted++;
        }
      });
      tx(rows);
    } else if (type === 'earnings') {
      const stmt = db.prepare(`INSERT INTO earnings (user_id, source_name, source_type, amount, frequency) VALUES (?,?,?,?,?)`);
      const tx = db.transaction((rs) => {
        for (const r of rs) {
          const name = safeStr(r.source_name, 200);
          const amount = safeNum(r.amount, { min: 0, max: 1e10 });
          const freq = ALLOWED_FREQUENCIES.has(r.frequency) ? r.frequency : 'Monthly';
          const stype = safeStr(r.source_type, 50) || 'other';
          if (!name || amount == null || amount <= 0) {
            result.skipped++; result.errors.push((name || '<row>') + ': invalid source_name or amount');
            continue;
          }
          stmt.run(userId, name, stype, amount, freq);
          result.inserted++;
        }
      });
      tx(rows);
    } else {
      return res.status(400).json({ error: 'Unsupported import type: ' + type });
    }
  } catch (err) {
    console.error('[import] commit error:', err);
    return res.status(500).json({ error: 'Import failed' });
  }

  res.json({ inserted: result.inserted, skipped: result.skipped, errors: result.errors.slice(0, 10) });
});

module.exports = router;
