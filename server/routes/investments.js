const express = require('express');
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');
const { getPrice: fetchYahooPrice, getIndianStockPrice } = require('../services/priceService');
const { getNavByCode } = require('../services/amfiNav');

const router = express.Router();

// All investment routes require authentication
router.use(authMiddleware);

// ─── STOCKS ──────────────────────────────────────────────────────────────────

/**
 * GET /api/investments/stocks
 */
/**
 * GET /api/investments/stocks
 *
 * Returns the user's Indian stock holdings with a freshly-fetched
 * `current_price` merged in (Yahoo via priceService). If Yahoo is
 * unreachable for a symbol, current_price stays null and the frontend
 * falls back to avg_buy_price — better than showing P&L=0 because of a
 * NULL DB column.
 */
router.get('/stocks', async (req, res) => {
  try {
    const stocks = db.prepare('SELECT * FROM stocks WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    if (!stocks.length) return res.json({ stocks });

    // Live prices in parallel. Failures are per-symbol; one bad symbol
    // doesn't block the rest of the table.
    //   - If the row has a manual yahoo_symbol override (e.g. "TATAMOTORS.NS"
    //     for a broker-internal "TMPV" code), use it verbatim — the user
    //     explicitly chose this mapping; bypass the heuristic.
    //   - Otherwise getIndianStockPrice tries .NS, stripped suffix variants,
    //     .BO, and ampersand-removed variants.
    const priceResults = await Promise.all(stocks.map(s => {
      if (s.yahoo_symbol) {
        return fetchYahooPrice(s.yahoo_symbol)
          .then(r => ({ ...r, live: r && r.price != null, resolved_symbol: s.yahoo_symbol, tried: [s.yahoo_symbol] }))
          .catch(() => ({ price: null, live: false, error: 'override_failed', tried: [s.yahoo_symbol] }));
      }
      return getIndianStockPrice(s.symbol).catch(() => ({ price: null, live: false }));
    }));
    const enriched = stocks.map((s, i) => {
      const r = priceResults[i] || {};
      const live = !!r.live;
      return {
        ...s,
        current_price: r.price != null ? r.price : s.current_price,
        live_price: live,
        resolved_symbol: r.resolved_symbol || null,
        // Diagnostics — surfaced in the UI tooltip when live_price is false
        // so the user knows which variants were tried before giving up.
        price_error: live ? null : (r.error || 'no_data'),
        price_tried: r.tried || null
      };
    });
    res.json({ stocks: enriched });
  } catch (err) {
    console.error('Get stocks error:', err);
    res.status(500).json({ error: 'Failed to fetch stocks' });
  }
});

/**
 * POST /api/investments/stocks
 */
router.post('/stocks', (req, res) => {
  try {
    const { symbol, exchange, company_name, quantity, avg_buy_price, notes } = req.body;

    if (!symbol || !company_name || !quantity || !avg_buy_price) {
      return res.status(400).json({ error: 'symbol, company_name, quantity, and avg_buy_price are required' });
    }

    const result = db.prepare(`
      INSERT INTO stocks (user_id, symbol, exchange, company_name, quantity, avg_buy_price, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, symbol.toUpperCase(), exchange || 'NSE', company_name, quantity, avg_buy_price, notes || null);

    const stock = db.prepare('SELECT * FROM stocks WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, stock });
  } catch (err) {
    console.error('Create stock error:', err);
    res.status(500).json({ error: 'Failed to create stock', message: err.message });
  }
});

/**
 * PUT /api/investments/stocks/:id
 */
router.put('/stocks/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM stocks WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Stock not found' });

    const { symbol, exchange, company_name, quantity, avg_buy_price, notes, yahoo_symbol } = req.body;

    db.prepare(`
      UPDATE stocks SET
        symbol = COALESCE(?, symbol),
        exchange = COALESCE(?, exchange),
        company_name = COALESCE(?, company_name),
        quantity = COALESCE(?, quantity),
        avg_buy_price = COALESCE(?, avg_buy_price),
        notes = COALESCE(?, notes),
        yahoo_symbol = ?
      WHERE id = ? AND user_id = ?
    `).run(
      symbol ? symbol.toUpperCase() : null,
      exchange || null, company_name || null,
      quantity || null, avg_buy_price || null,
      notes !== undefined ? notes : existing.notes,
      // yahoo_symbol: empty string clears the override; undefined leaves it
      yahoo_symbol === undefined ? existing.yahoo_symbol : (yahoo_symbol ? String(yahoo_symbol).trim().toUpperCase() : null),
      id, req.user.id
    );

    const updated = db.prepare('SELECT * FROM stocks WHERE id = ?').get(id);
    res.json({ success: true, stock: updated });
  } catch (err) {
    console.error('Update stock error:', err);
    res.status(500).json({ error: 'Failed to update stock', message: err.message });
  }
});

/**
 * DELETE /api/investments/stocks/:id
 */
router.delete('/stocks/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM stocks WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Stock not found' });

    db.prepare('DELETE FROM stocks WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.json({ success: true, message: 'Stock deleted' });
  } catch (err) {
    console.error('Delete stock error:', err);
    res.status(500).json({ error: 'Failed to delete stock', message: err.message });
  }
});

// ─── MUTUAL FUNDS ─────────────────────────────────────────────────────────────

/**
 * GET /api/investments/mutual-funds
 */
router.get('/mutual-funds', async (req, res) => {
  try {
    const funds = db.prepare('SELECT * FROM mutual_funds WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    if (!funds.length) return res.json({ mutual_funds: funds });

    // Live NAV resolution per row:
    //   1. yahoo_symbol set → use Yahoo (for ETFs like GOLDIETF.NS)
    //   2. scheme_code set  → look up AMFI NAVAll.txt
    //   3. otherwise        → no live NAV, fall back to avg_nav
    const enriched = await Promise.all(funds.map(async f => {
      let nav = null, source = 'fallback';
      try {
        if (f.yahoo_symbol) {
          const r = await fetchYahooPrice(f.yahoo_symbol);
          if (r && r.price != null) { nav = r.price; source = 'yahoo'; }
        } else if (f.scheme_code) {
          const r = await getNavByCode(f.scheme_code);
          if (r && r.nav != null)   { nav = r.nav;   source = 'amfi:'+r.date; }
        }
      } catch (_) { /* swallow per-row errors */ }
      return {
        ...f,
        current_nav: nav != null ? nav : f.current_nav,
        live_nav: nav != null,
        nav_source: source
      };
    }));
    res.json({ mutual_funds: enriched });
  } catch (err) {
    console.error('Get MFs error:', err);
    res.status(500).json({ error: 'Failed to fetch mutual funds' });
  }
});

/**
 * POST /api/investments/mutual-funds
 */
router.post('/mutual-funds', (req, res) => {
  try {
    const { fund_name, folio_number, units, avg_nav, fund_type, sip_amount, sip_date, notes } = req.body;

    if (!fund_name || !units || !avg_nav) {
      return res.status(400).json({ error: 'fund_name, units, and avg_nav are required' });
    }

    const result = db.prepare(`
      INSERT INTO mutual_funds (user_id, fund_name, folio_number, units, avg_nav, fund_type, sip_amount, sip_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, fund_name, folio_number || null, units, avg_nav, fund_type || 'Equity', sip_amount || 0, sip_date || null, notes || null);

    const fund = db.prepare('SELECT * FROM mutual_funds WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, mutual_fund: fund });
  } catch (err) {
    console.error('Create MF error:', err);
    res.status(500).json({ error: 'Failed to create mutual fund', message: err.message });
  }
});

/**
 * PUT /api/investments/mutual-funds/:id
 */
router.put('/mutual-funds/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM mutual_funds WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Mutual fund not found' });

    const { fund_name, folio_number, units, avg_nav, fund_type, sip_amount, sip_date, notes,
            scheme_code, yahoo_symbol } = req.body;

    db.prepare(`
      UPDATE mutual_funds SET
        fund_name = COALESCE(?, fund_name),
        folio_number = COALESCE(?, folio_number),
        units = COALESCE(?, units),
        avg_nav = COALESCE(?, avg_nav),
        fund_type = COALESCE(?, fund_type),
        sip_amount = COALESCE(?, sip_amount),
        sip_date = COALESCE(?, sip_date),
        notes = ?,
        scheme_code = ?,
        yahoo_symbol = ?
      WHERE id = ? AND user_id = ?
    `).run(
      fund_name || null, folio_number || null, units || null, avg_nav || null,
      fund_type || null, sip_amount !== undefined ? sip_amount : null,
      sip_date !== undefined ? sip_date : null,
      notes !== undefined ? notes : existing.notes,
      // Empty string clears, undefined leaves untouched
      scheme_code   === undefined ? existing.scheme_code   : (scheme_code   ? String(scheme_code).trim() : null),
      yahoo_symbol  === undefined ? existing.yahoo_symbol  : (yahoo_symbol  ? String(yahoo_symbol).trim().toUpperCase() : null),
      id, req.user.id
    );

    const updated = db.prepare('SELECT * FROM mutual_funds WHERE id = ?').get(id);
    res.json({ success: true, mutual_fund: updated });
  } catch (err) {
    console.error('Update MF error:', err);
    res.status(500).json({ error: 'Failed to update mutual fund', message: err.message });
  }
});

/**
 * DELETE /api/investments/mutual-funds/:id
 */
router.delete('/mutual-funds/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM mutual_funds WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Mutual fund not found' });

    db.prepare('DELETE FROM mutual_funds WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.json({ success: true, message: 'Mutual fund deleted' });
  } catch (err) {
    console.error('Delete MF error:', err);
    res.status(500).json({ error: 'Failed to delete mutual fund', message: err.message });
  }
});

// ─── FIXED DEPOSITS ──────────────────────────────────────────────────────────

/**
 * GET /api/investments/fds
 */
router.get('/fds', (req, res) => {
  try {
    const fds = db.prepare('SELECT * FROM fixed_deposits WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    res.json({ fixed_deposits: fds });
  } catch (err) {
    console.error('Get FDs error:', err);
    res.status(500).json({ error: 'Failed to fetch fixed deposits', message: err.message });
  }
});

/**
 * POST /api/investments/fds
 */
router.post('/fds', (req, res) => {
  try {
    const { bank_name, principal, interest_rate, start_date, maturity_date, fd_type, notes } = req.body;

    if (!bank_name || !principal || !interest_rate || !start_date || !maturity_date) {
      return res.status(400).json({ error: 'bank_name, principal, interest_rate, start_date, and maturity_date are required' });
    }

    const result = db.prepare(`
      INSERT INTO fixed_deposits (user_id, bank_name, principal, interest_rate, start_date, maturity_date, fd_type, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, bank_name, principal, interest_rate, start_date, maturity_date, fd_type || 'Cumulative', notes || null);

    const fd = db.prepare('SELECT * FROM fixed_deposits WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, fixed_deposit: fd });
  } catch (err) {
    console.error('Create FD error:', err);
    res.status(500).json({ error: 'Failed to create fixed deposit', message: err.message });
  }
});

/**
 * PUT /api/investments/fds/:id
 */
router.put('/fds/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM fixed_deposits WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Fixed deposit not found' });

    const { bank_name, principal, interest_rate, start_date, maturity_date, fd_type, notes } = req.body;

    db.prepare(`
      UPDATE fixed_deposits SET
        bank_name = COALESCE(?, bank_name),
        principal = COALESCE(?, principal),
        interest_rate = COALESCE(?, interest_rate),
        start_date = COALESCE(?, start_date),
        maturity_date = COALESCE(?, maturity_date),
        fd_type = COALESCE(?, fd_type),
        notes = ?
      WHERE id = ? AND user_id = ?
    `).run(
      bank_name || null, principal || null, interest_rate || null,
      start_date || null, maturity_date || null, fd_type || null,
      notes !== undefined ? notes : existing.notes,
      id, req.user.id
    );

    const updated = db.prepare('SELECT * FROM fixed_deposits WHERE id = ?').get(id);
    res.json({ success: true, fixed_deposit: updated });
  } catch (err) {
    console.error('Update FD error:', err);
    res.status(500).json({ error: 'Failed to update fixed deposit', message: err.message });
  }
});

/**
 * DELETE /api/investments/fds/:id
 */
router.delete('/fds/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM fixed_deposits WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'Fixed deposit not found' });

    db.prepare('DELETE FROM fixed_deposits WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.json({ success: true, message: 'Fixed deposit deleted' });
  } catch (err) {
    console.error('Delete FD error:', err);
    res.status(500).json({ error: 'Failed to delete fixed deposit', message: err.message });
  }
});

// ─── US STOCKS ────────────────────────────────────────────────────────────────

/**
 * GET /api/investments/us-stocks
 *
 * Same live-price merge as the Indian stocks endpoint. US tickers go
 * straight to Yahoo without a `.NS` suffix.
 */
router.get('/us-stocks', async (req, res) => {
  try {
    const stocks = db.prepare('SELECT * FROM us_stocks WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
    if (!stocks.length) return res.json({ us_stocks: stocks });

    // Honour manual yahoo_symbol override (e.g. "BRK-B" for Berkshire B
     // shares which Yahoo lists as BRK-B not BRK.B). Otherwise just pass
     // the symbol verbatim — US tickers don't carry exchange suffixes.
    const priceResults = await Promise.all(
      stocks.map(s => fetchYahooPrice(s.yahoo_symbol || s.symbol).catch(() => ({ price: null })))
    );
    const enriched = stocks.map((s, i) => {
      const r = priceResults[i] || {};
      const live = r.price != null;
      return {
        ...s,
        current_price_usd: r.price != null ? r.price : s.current_price_usd,
        live_price: live,
        resolved_symbol: live ? (s.yahoo_symbol || s.symbol) : null
      };
    });
    res.json({ us_stocks: enriched });
  } catch (err) {
    console.error('Get US stocks error:', err);
    res.status(500).json({ error: 'Failed to fetch US stocks' });
  }
});

/**
 * POST /api/investments/us-stocks
 */
router.post('/us-stocks', (req, res) => {
  try {
    const { symbol, company_name, quantity, avg_buy_price_usd, notes } = req.body;

    if (!symbol || !company_name || !quantity || !avg_buy_price_usd) {
      return res.status(400).json({ error: 'symbol, company_name, quantity, and avg_buy_price_usd are required' });
    }

    const result = db.prepare(`
      INSERT INTO us_stocks (user_id, symbol, company_name, quantity, avg_buy_price_usd, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.user.id, symbol.toUpperCase(), company_name, quantity, avg_buy_price_usd, notes || null);

    const stock = db.prepare('SELECT * FROM us_stocks WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, us_stock: stock });
  } catch (err) {
    console.error('Create US stock error:', err);
    res.status(500).json({ error: 'Failed to create US stock', message: err.message });
  }
});

/**
 * PUT /api/investments/us-stocks/:id
 */
router.put('/us-stocks/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM us_stocks WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'US stock not found' });

    const { symbol, company_name, quantity, avg_buy_price_usd, notes, yahoo_symbol } = req.body;

    db.prepare(`
      UPDATE us_stocks SET
        symbol = COALESCE(?, symbol),
        company_name = COALESCE(?, company_name),
        quantity = COALESCE(?, quantity),
        avg_buy_price_usd = COALESCE(?, avg_buy_price_usd),
        notes = ?,
        yahoo_symbol = ?
      WHERE id = ? AND user_id = ?
    `).run(
      symbol ? symbol.toUpperCase() : null,
      company_name || null, quantity || null, avg_buy_price_usd || null,
      notes !== undefined ? notes : existing.notes,
      // empty string clears, undefined leaves untouched
      yahoo_symbol === undefined ? existing.yahoo_symbol : (yahoo_symbol ? String(yahoo_symbol).trim().toUpperCase() : null),
      id, req.user.id
    );

    const updated = db.prepare('SELECT * FROM us_stocks WHERE id = ?').get(id);
    res.json({ success: true, us_stock: updated });
  } catch (err) {
    console.error('Update US stock error:', err);
    res.status(500).json({ error: 'Failed to update US stock', message: err.message });
  }
});

/**
 * DELETE /api/investments/us-stocks/:id
 */
router.delete('/us-stocks/:id', (req, res) => {
  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM us_stocks WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!existing) return res.status(404).json({ error: 'US stock not found' });

    db.prepare('DELETE FROM us_stocks WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.json({ success: true, message: 'US stock deleted' });
  } catch (err) {
    console.error('Delete US stock error:', err);
    res.status(500).json({ error: 'Failed to delete US stock', message: err.message });
  }
});

// ─── LIVE PRICES ──────────────────────────────────────────────────────────────

/**
 * GET /api/investments/prices?symbols=TCS.NS,INFY.NS,GOOGL
 * Proxy to Yahoo Finance for live stock prices
 */
router.get('/prices', async (req, res) => {
  try {
    const { symbols } = req.query;

    if (!symbols) {
      return res.status(400).json({ error: 'symbols query param is required (comma-separated)' });
    }

    const symbolList = symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

    if (symbolList.length === 0) {
      return res.status(400).json({ error: 'No valid symbols provided' });
    }

    if (symbolList.length > 30) {
      return res.status(400).json({ error: 'Maximum 30 symbols per request' });
    }

    // Fetch all prices in parallel
    const pricePromises = symbolList.map(symbol => fetchYahooPrice(symbol));
    const prices = await Promise.all(pricePromises);

    const priceMap = {};
    prices.forEach(p => { priceMap[p.symbol] = p; });

    res.json({ prices: priceMap, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('Prices fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch prices', message: err.message });
  }
});

// ─── INVESTMENTS SUMMARY ──────────────────────────────────────────────────────

/**
 * GET /api/investments/summary
 * Returns total invested, current value (using live prices where possible), P&L
 */
router.get('/summary', async (req, res) => {
  try {
    const userId = req.user.id;

    const stocks = db.prepare('SELECT * FROM stocks WHERE user_id = ?').all(userId);
    const mutualFunds = db.prepare('SELECT * FROM mutual_funds WHERE user_id = ?').all(userId);
    const fds = db.prepare('SELECT * FROM fixed_deposits WHERE user_id = ?').all(userId);
    const usStocks = db.prepare('SELECT * FROM us_stocks WHERE user_id = ?').all(userId);

    // Fetch live prices for Indian stocks
    let stockPrices = {};
    if (stocks.length > 0) {
      const symbols = stocks.map(s => `${s.symbol}.NS`);
      try {
        const pricePromises = symbols.map(sym => fetchYahooPrice(sym));
        const prices = await Promise.all(pricePromises);
        prices.forEach((p, i) => {
          stockPrices[stocks[i].symbol] = p.price;
        });
      } catch (e) {
        console.error('Failed to fetch Indian stock prices for summary:', e.message);
      }
    }

    // Fetch live prices for US stocks
    let usStockPrices = {};
    if (usStocks.length > 0) {
      const symbols = usStocks.map(s => s.symbol);
      try {
        const pricePromises = symbols.map(sym => fetchYahooPrice(sym));
        const prices = await Promise.all(pricePromises);
        prices.forEach((p, i) => {
          usStockPrices[usStocks[i].symbol] = p.price;
        });
      } catch (e) {
        console.error('Failed to fetch US stock prices for summary:', e.message);
      }
    }

    // Calculate stock totals (INR)
    let stocksInvested = 0;
    let stocksCurrentValue = 0;
    const stocksDetail = stocks.map(s => {
      const invested = s.quantity * s.avg_buy_price;
      const currentPrice = stockPrices[s.symbol] || s.avg_buy_price;
      const currentValue = s.quantity * currentPrice;
      stocksInvested += invested;
      stocksCurrentValue += currentValue;
      return {
        ...s,
        current_price: currentPrice,
        current_value: currentValue,
        pnl: currentValue - invested,
        pnl_percent: ((currentValue - invested) / invested) * 100
      };
    });

    // Calculate MF totals (use avg_nav as current — no live NAV API in scope)
    let mfInvested = 0;
    let mfCurrentValue = 0;
    mutualFunds.forEach(mf => {
      const invested = mf.units * mf.avg_nav;
      mfInvested += invested;
      mfCurrentValue += invested; // Using cost as proxy; real NAV would need separate API
    });

    // Calculate FD maturity values
    let fdInvested = 0;
    let fdMaturityValue = 0;
    fds.forEach(fd => {
      fdInvested += fd.principal;
      const start = new Date(fd.start_date);
      const maturity = new Date(fd.maturity_date);
      const years = (maturity - start) / (1000 * 60 * 60 * 24 * 365);
      const maturityVal = fd.principal * Math.pow(1 + fd.interest_rate / 100, years);
      fdMaturityValue += maturityVal;
    });

    // Calculate US stock totals (USD — note: not converting to INR here)
    let usStocksInvestedUsd = 0;
    let usStocksCurrentValueUsd = 0;
    usStocks.forEach(s => {
      const invested = s.quantity * s.avg_buy_price_usd;
      const currentPrice = usStockPrices[s.symbol] || s.avg_buy_price_usd;
      const currentValue = s.quantity * currentPrice;
      usStocksInvestedUsd += invested;
      usStocksCurrentValueUsd += currentValue;
    });

    const totalInvestedInr = stocksInvested + mfInvested + fdInvested;
    const totalCurrentValueInr = stocksCurrentValue + mfCurrentValue + fdMaturityValue;
    const totalPnl = totalCurrentValueInr - totalInvestedInr;
    const totalPnlPercent = totalInvestedInr > 0 ? (totalPnl / totalInvestedInr) * 100 : 0;

    res.json({
      summary: {
        total_invested_inr: Math.round(totalInvestedInr),
        total_current_value_inr: Math.round(totalCurrentValueInr),
        total_pnl_inr: Math.round(totalPnl),
        total_pnl_percent: parseFloat(totalPnlPercent.toFixed(2)),
        breakdown: {
          stocks: {
            invested: Math.round(stocksInvested),
            current_value: Math.round(stocksCurrentValue),
            pnl: Math.round(stocksCurrentValue - stocksInvested),
            count: stocks.length
          },
          mutual_funds: {
            invested: Math.round(mfInvested),
            current_value: Math.round(mfCurrentValue),
            count: mutualFunds.length
          },
          fixed_deposits: {
            principal: Math.round(fdInvested),
            maturity_value: Math.round(fdMaturityValue),
            count: fds.length
          },
          us_stocks: {
            invested_usd: parseFloat(usStocksInvestedUsd.toFixed(2)),
            current_value_usd: parseFloat(usStocksCurrentValueUsd.toFixed(2)),
            count: usStocks.length
          }
        }
      },
      stocks_detail: stocksDetail,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Investment summary error:', err);
    res.status(500).json({ error: 'Failed to compute summary', message: err.message });
  }
});

module.exports = router;
