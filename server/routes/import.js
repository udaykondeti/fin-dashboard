const express = require('express');
const router = express.Router();
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

router.use(authMiddleware);

// Simple CSV parser — handles quoted fields and common delimiters
function parseCSV(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (!lines.length) return { headers: [], rows: [] };
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
  try {
    const { content } = req.body || {};
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'No content provided' });
    }
    const parsed = parseCSV(content);
    if (!parsed.rows.length) {
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
  } catch (err) {
    console.error('[import/preview]', err);
    res.status(400).json({ error: 'Could not parse file: ' + err.message });
  }
});

// POST /api/import/commit  — save parsed rows to DB
router.post('/commit', (req, res) => {
  try {
    const { type, rows } = req.body || {};
    if (!type || !Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: 'type and a non-empty rows array are required' });
    }
    const userId = req.user.id;
    let inserted = 0, skipped = 0;
    const errors = [];

    if (type === 'stocks') {
      const stmt = db.prepare(`INSERT INTO stocks (user_id, symbol, company_name, quantity, avg_buy_price) VALUES (?,?,?,?,?)`);
      for (const r of rows) {
        if (!r || !r.symbol) { skipped++; continue; }
        try {
          stmt.run(userId, r.symbol, r.company_name || r.symbol, Number(r.quantity) || 0, Number(r.avg_buy_price) || 0);
          inserted++;
        } catch (e) { errors.push(r.symbol + ': ' + e.message); skipped++; }
      }
    } else if (type === 'mutual_funds') {
      const stmt = db.prepare(`INSERT INTO mutual_funds (user_id, fund_name, units, avg_nav, fund_type) VALUES (?,?,?,?,?)`);
      for (const r of rows) {
        if (!r || !r.fund_name) { skipped++; continue; }
        try {
          stmt.run(userId, r.fund_name, Number(r.units) || 0, Number(r.avg_nav) || 0, r.fund_type || 'Equity');
          inserted++;
        } catch (e) { errors.push(r.fund_name + ': ' + e.message); skipped++; }
      }
    } else if (type === 'earnings') {
      const stmt = db.prepare(`INSERT INTO earnings (user_id, source_name, source_type, amount, frequency) VALUES (?,?,?,?,?)`);
      for (const r of rows) {
        if (!r || !r.source_name) { skipped++; continue; }
        try {
          stmt.run(userId, r.source_name, r.source_type || 'other', Number(r.amount) || 0, r.frequency || 'Monthly');
          inserted++;
        } catch (e) { errors.push(r.source_name + ': ' + e.message); skipped++; }
      }
    } else {
      return res.status(400).json({ error: 'Unsupported import type: ' + type });
    }

    res.json({ inserted, skipped, errors: errors.slice(0, 10) });
  } catch (err) {
    console.error('[import/commit]', err);
    res.status(500).json({ error: 'Import failed', message: err.message });
  }
});

module.exports = router;
