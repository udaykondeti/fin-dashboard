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

// Pick the first header in `candidates` that exists in `headers`, or null.
function pickCol(headers, candidates) {
  for (const c of candidates) if (headers.includes(c)) return c;
  return null;
}

// Detect format and map rows to a canonical shape. Permissive — broker
// exports vary wildly in column casing and naming, so try every common
// variant before giving up.
// Returns { type: 'stocks'|'mutual_funds'|'earnings'|'unknown', rows: [...canonical] }
function detectAndMap(parsed) {
  const { headers, rows } = parsed;

  // ── Indian broker holdings export (Tata Securities / HDFC Securities /
  //    similar) — single CSV that mixes stocks and MFs, distinguished by
  //    `portfolio_holdings`. Identifying signature: stock_name +
  //    company_name + average_cost_value + (long_term_qty | short_term_qty).
  //    Quantity = long_term + short_term. Avg price = average_cost_value.
  //    portfolio_holdings of "Mutual Fund" / "ETF" / "Index Fund" routes
  //    to mutual_funds; "Equity" or absent routes to stocks.
  if (
    headers.includes('stock_name') && headers.includes('company_name') &&
    headers.includes('average_cost_value') &&
    (headers.includes('long_term_qty') || headers.includes('short_term_qty'))
  ) {
    const qtyOf = r => (numOf(r.long_term_qty) || 0) + (numOf(r.short_term_qty) || 0);
    const avgOf = r => numOf(r.average_cost_value);
    const ph    = r => String(r.portfolio_holdings || '').trim().toLowerCase();
    const isMF  = r => /mutual fund|etf|index fund|liquid fund|debt fund/.test(ph(r));

    const mfRows = rows.filter(r => isMF(r) && r.company_name && qtyOf(r) > 0).map(r => {
      const phl = ph(r);
      let fund_type;
      if (phl.includes('etf')) fund_type = 'ETF';
      else if (phl.includes('index')) fund_type = 'Index';
      else if (phl.includes('debt') || phl.includes('liquid')) fund_type = 'Debt';
      else fund_type = 'Equity';
      return {
        fund_name: r.company_name,
        units: qtyOf(r),
        avg_nav: avgOf(r),
        fund_type
      };
    });

    const stockRows = rows.filter(r => !isMF(r) && r.stock_name && qtyOf(r) > 0).map(r => ({
      symbol: String(r.stock_name).toUpperCase().trim(),
      company_name: r.company_name || r.stock_name,
      quantity: qtyOf(r),
      avg_buy_price: avgOf(r)
    }));

    // Single CSV is usually one type or the other; pick whichever majority.
    // The frontend has a type override so the user can switch if needed.
    if (mfRows.length || stockRows.length) {
      if (mfRows.length >= stockRows.length) return { type: 'mutual_funds', rows: mfRows };
      return { type: 'stocks', rows: stockRows };
    }
  }

  // ── Stocks ───────────────────────────────────────────────────────────────
  // Symbol/instrument column variants (Zerodha Console, Groww, generic).
  const symCol = pickCol(headers, ['symbol', 'instrument', 'stock', 'stock_name', 'ticker', 'tradingsymbol', 'scrip', 'security']);
  const qtyCol = pickCol(headers, [
    'quantity', 'qty', 'quantity_available', 'available_qty', 'available_quantity', 'shares', 'units_held'
  ]);
  const stockPriceCol = pickCol(headers, [
    'avg_buy_price', 'average_buy_price', 'avg_cost', 'average_cost', 'average_price', 'avg_price',
    'buy_avg', 'buy_average', 'avg_buy_value', 'cost_price', 'purchase_price', 'buy_price',
    'average_cost_value'
  ]);
  if (symCol && qtyCol) {
    const nameCol = pickCol(headers, ['company_name', 'company', 'name', 'instrument_name', 'security_name']) || symCol;
    const mapped = rows.map(r => ({
      symbol: String(r[symCol] || '').toUpperCase().trim(),
      company_name: r[nameCol] || r[symCol] || '',
      quantity: numOf(r[qtyCol]),
      avg_buy_price: stockPriceCol ? numOf(r[stockPriceCol]) : null
    })).filter(r => r.symbol && r.quantity > 0);
    if (mapped.length) return { type: 'stocks', rows: mapped };
  }

  // ── Mutual Funds (Groww / CAMS / KFintech / generic) ─────────────────────
  const mfNameCol = pickCol(headers, ['fund_name', 'scheme_name', 'scheme', 'mf_name', 'fund', 'company_name']);
  const mfUnitsCol = pickCol(headers, ['units', 'unit_balance', 'closing_units', 'quantity']);
  if (mfNameCol && mfUnitsCol) {
    const navCol = pickCol(headers, ['avg_nav', 'average_nav', 'cost_nav', 'purchase_nav', 'nav', 'unit_cost', 'average_cost_value']);
    const typeCol = pickCol(headers, ['fund_type', 'type', 'category', 'scheme_category', 'portfolio_holdings']);
    const mapped = rows.map(r => ({
      fund_name: r[mfNameCol] || '',
      units: numOf(r[mfUnitsCol]),
      avg_nav: navCol ? numOf(r[navCol]) : null,
      fund_type: typeCol ? r[typeCol] : null
    })).filter(r => r.fund_name && r.units > 0);
    if (mapped.length) return { type: 'mutual_funds', rows: mapped };
  }

  // ── Earnings / Income ────────────────────────────────────────────────────
  const earnNameCol = pickCol(headers, ['source_name', 'name', 'source', 'description', 'particulars']);
  const earnAmtCol  = pickCol(headers, ['amount', 'value', 'income', 'salary', 'amt']);
  if (earnNameCol && earnAmtCol) {
    const freqCol = pickCol(headers, ['frequency', 'freq', 'period']);
    const typeCol = pickCol(headers, ['source_type', 'type', 'category']);
    const mapped = rows.map(r => ({
      source_name: r[earnNameCol] || '',
      amount: numOf(r[earnAmtCol]),
      frequency: (freqCol && r[freqCol]) || 'Monthly',
      source_type: (typeCol && r[typeCol]) || 'Salary'
    })).filter(r => r.source_name && r.amount > 0);
    if (mapped.length) return { type: 'earnings', rows: mapped };
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

// Hardening: cap row count, validate field types/ranges, run inserts in a
// single transaction so a malformed row late in the file doesn't leave the
// table half-populated.
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
//
// Upsert semantics: a broker holdings export is a *snapshot* of the current
// portfolio, not a list of new transactions. Re-uploading the same CSV
// should refresh the existing rows (qty + avg) rather than create
// duplicates. So:
//   - stocks         — match on (user_id, symbol)         → UPDATE, else INSERT
//   - mutual_funds   — match on (user_id, fund_name)      → UPDATE, else INSERT
//   - earnings       — match on (user_id, source_name)    → UPDATE, else INSERT
// If multiple existing rows match (legacy duplicates), the lowest-id row is
// kept and updated; the rest are deleted in the same transaction.
router.post('/commit', (req, res) => {
  try {
    const { type, rows } = req.body || {};
    if (!type || !Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ error: 'type and a non-empty rows array are required' });
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      return res.status(413).json({ error: `Too many rows. Max ${MAX_IMPORT_ROWS} per import.` });
    }
    const userId = req.user.id;
    const result = { inserted: 0, updated: 0, skipped: 0, errors: [] };

    if (type === 'stocks') {
      const findExisting = db.prepare('SELECT id FROM stocks WHERE user_id = ? AND symbol = ? ORDER BY id ASC');
      const updateStmt   = db.prepare('UPDATE stocks SET quantity = ?, avg_buy_price = ?, company_name = COALESCE(?, company_name) WHERE id = ?');
      const insertStmt   = db.prepare('INSERT INTO stocks (user_id, symbol, company_name, quantity, avg_buy_price) VALUES (?,?,?,?,?)');
      const deleteDup    = db.prepare('DELETE FROM stocks WHERE id = ?');
      const tx = db.transaction((rs) => {
        for (const r of rs) {
          const symbol = safeStr(r && r.symbol, 32);
          const name = safeStr((r && (r.company_name || r.symbol)) || '', 200);
          const qty = safeNum(r && r.quantity, { min: 0, max: 1e9 });
          const price = safeNum(r && r.avg_buy_price, { min: 0, max: 1e9 });
          if (!symbol || qty == null || qty <= 0) {
            result.skipped++; result.errors.push((symbol || '<row>') + ': invalid symbol or quantity');
            continue;
          }
          const existing = findExisting.all(userId, symbol);
          if (existing.length === 0) {
            insertStmt.run(userId, symbol, name || symbol, qty, price || 0);
            result.inserted++;
          } else {
            // Update first; if there were legacy duplicates, drop the rest
            updateStmt.run(qty, price || 0, name || symbol, existing[0].id);
            for (let i = 1; i < existing.length; i++) deleteDup.run(existing[i].id);
            result.updated++;
          }
        }
      });
      tx(rows);
    } else if (type === 'mutual_funds') {
      const findExisting = db.prepare('SELECT id FROM mutual_funds WHERE user_id = ? AND fund_name = ? ORDER BY id ASC');
      const updateStmt   = db.prepare('UPDATE mutual_funds SET units = ?, avg_nav = ?, fund_type = ? WHERE id = ?');
      const insertStmt   = db.prepare('INSERT INTO mutual_funds (user_id, fund_name, units, avg_nav, fund_type) VALUES (?,?,?,?,?)');
      const deleteDup    = db.prepare('DELETE FROM mutual_funds WHERE id = ?');
      const tx = db.transaction((rs) => {
        for (const r of rs) {
          const name = safeStr(r && r.fund_name, 300);
          const units = safeNum(r && r.units, { min: 0, max: 1e12 });
          const nav = safeNum(r && r.avg_nav, { min: 0, max: 1e9 });
          const ftype = safeStr(r && r.fund_type, 50) || 'Equity';
          if (!name || units == null || units <= 0) {
            result.skipped++; result.errors.push((name || '<row>') + ': invalid fund_name or units');
            continue;
          }
          const existing = findExisting.all(userId, name);
          if (existing.length === 0) {
            insertStmt.run(userId, name, units, nav || 0, ftype);
            result.inserted++;
          } else {
            updateStmt.run(units, nav || 0, ftype, existing[0].id);
            for (let i = 1; i < existing.length; i++) deleteDup.run(existing[i].id);
            result.updated++;
          }
        }
      });
      tx(rows);
    } else if (type === 'earnings') {
      const findExisting = db.prepare('SELECT id FROM earnings WHERE user_id = ? AND source_name = ? ORDER BY id ASC');
      const updateStmt   = db.prepare('UPDATE earnings SET amount = ?, frequency = ?, source_type = ? WHERE id = ?');
      const insertStmt   = db.prepare('INSERT INTO earnings (user_id, source_name, source_type, amount, frequency) VALUES (?,?,?,?,?)');
      const deleteDup    = db.prepare('DELETE FROM earnings WHERE id = ?');
      const tx = db.transaction((rs) => {
        for (const r of rs) {
          const name = safeStr(r && r.source_name, 200);
          const amount = safeNum(r && r.amount, { min: 0, max: 1e10 });
          const freq = ALLOWED_FREQUENCIES.has(r && r.frequency) ? r.frequency : 'Monthly';
          const stype = safeStr(r && r.source_type, 50) || 'other';
          if (!name || amount == null || amount <= 0) {
            result.skipped++; result.errors.push((name || '<row>') + ': invalid source_name or amount');
            continue;
          }
          const existing = findExisting.all(userId, name);
          if (existing.length === 0) {
            insertStmt.run(userId, name, stype, amount, freq);
            result.inserted++;
          } else {
            updateStmt.run(amount, freq, stype, existing[0].id);
            for (let i = 1; i < existing.length; i++) deleteDup.run(existing[i].id);
            result.updated++;
          }
        }
      });
      tx(rows);
    } else {
      return res.status(400).json({ error: 'Unsupported import type: ' + type });
    }

    res.json({ inserted: result.inserted, updated: result.updated, skipped: result.skipped, errors: result.errors.slice(0, 10) });
  } catch (err) {
    console.error('[import/commit]', err);
    res.status(500).json({ error: 'Import failed' });
  }
});

module.exports = router;
