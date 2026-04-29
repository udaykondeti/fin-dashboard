const express = require('express');
const fetch = require('node-fetch');
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

/**
 * Fetch Yahoo Finance price for a symbol
 */
async function fetchPrice(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; fin-dashboard/1.0)' },
      timeout: 8000
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
  } catch {
    return null;
  }
}

/**
 * GET /api/networth
 * Returns comprehensive net worth breakdown:
 * - Total assets (investments + FDs)
 * - Total liabilities (loans + credit cards + hand loans taken)
 * - Net worth
 * - Asset breakdown by category
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user.id;

    // Fetch all data
    const stocks = db.prepare('SELECT * FROM stocks WHERE user_id = ?').all(userId);
    const mutualFunds = db.prepare('SELECT * FROM mutual_funds WHERE user_id = ?').all(userId);
    const fds = db.prepare('SELECT * FROM fixed_deposits WHERE user_id = ?').all(userId);
    const usStocks = db.prepare('SELECT * FROM us_stocks WHERE user_id = ?').all(userId);
    const creditCards = db.prepare('SELECT * FROM credit_cards WHERE user_id = ?').all(userId);
    const loans = db.prepare('SELECT * FROM loans WHERE user_id = ?').all(userId);
    const handLoans = db.prepare('SELECT * FROM hand_loans WHERE user_id = ? AND status = "active"').all(userId);

    // ── Fetch live prices for Indian stocks ──
    let stockValues = 0;
    if (stocks.length > 0) {
      const pricePromises = stocks.map(s => fetchPrice(`${s.symbol}.NS`));
      const prices = await Promise.all(pricePromises);
      stocks.forEach((s, i) => {
        const price = prices[i] || s.avg_buy_price;
        stockValues += s.quantity * price;
      });
    }

    // ── Fetch live prices for US stocks ──
    let usStockValuesUsd = 0;
    // Default USD/INR rate fallback (approximate); ideally fetch live
    const usdInrRate = 84.0;
    if (usStocks.length > 0) {
      const pricePromises = usStocks.map(s => fetchPrice(s.symbol));
      const prices = await Promise.all(pricePromises);
      usStocks.forEach((s, i) => {
        const price = prices[i] || s.avg_buy_price_usd;
        usStockValuesUsd += s.quantity * price;
      });
    }
    const usStockValuesInr = usStockValuesUsd * usdInrRate;

    // ── Mutual funds (at cost — NAV not fetched) ──
    const mfValue = mutualFunds.reduce((sum, mf) => sum + (mf.units * mf.avg_nav), 0);

    // ── Fixed deposits (principal value; use principal as conservative estimate) ──
    const fdValue = fds.reduce((sum, fd) => sum + fd.principal, 0);
    // Accrued interest estimate
    const fdAccruedValue = fds.reduce((sum, fd) => {
      const start = new Date(fd.start_date);
      const now = new Date();
      const yearsElapsed = Math.max(0, (now - start) / (1000 * 60 * 60 * 24 * 365));
      return sum + fd.principal * Math.pow(1 + fd.interest_rate / 100, yearsElapsed);
    }, 0);

    // ── Hand loans given (receivable = asset) ──
    const handLoansGiven = handLoans
      .filter(l => l.direction === 'given')
      .reduce((sum, l) => sum + l.amount, 0);

    // ── Total Assets ──
    const totalAssets = stockValues + mfValue + fdAccruedValue + usStockValuesInr + handLoansGiven;

    // ── Liabilities ──
    const totalCreditCardDebt = creditCards.reduce((sum, c) => sum + (c.outstanding_balance || 0), 0);
    const totalLoanOutstanding = loans.reduce((sum, l) => sum + (l.outstanding_amount || 0), 0);
    const handLoansTaken = handLoans
      .filter(l => l.direction === 'taken')
      .reduce((sum, l) => sum + l.amount, 0);

    const totalLiabilities = totalCreditCardDebt + totalLoanOutstanding + handLoansTaken;

    // ── Net Worth ──
    const netWorth = totalAssets - totalLiabilities;

    res.json({
      net_worth: {
        total_assets: Math.round(totalAssets),
        total_liabilities: Math.round(totalLiabilities),
        net_worth: Math.round(netWorth),
        currency: 'INR',
        asset_breakdown: {
          indian_stocks: {
            value: Math.round(stockValues),
            percent: totalAssets > 0 ? parseFloat(((stockValues / totalAssets) * 100).toFixed(1)) : 0,
            count: stocks.length
          },
          mutual_funds: {
            value: Math.round(mfValue),
            percent: totalAssets > 0 ? parseFloat(((mfValue / totalAssets) * 100).toFixed(1)) : 0,
            count: mutualFunds.length
          },
          fixed_deposits: {
            value: Math.round(fdAccruedValue),
            principal: Math.round(fdValue),
            percent: totalAssets > 0 ? parseFloat(((fdAccruedValue / totalAssets) * 100).toFixed(1)) : 0,
            count: fds.length
          },
          us_stocks: {
            value_inr: Math.round(usStockValuesInr),
            value_usd: parseFloat(usStockValuesUsd.toFixed(2)),
            usd_inr_rate: usdInrRate,
            percent: totalAssets > 0 ? parseFloat(((usStockValuesInr / totalAssets) * 100).toFixed(1)) : 0,
            count: usStocks.length
          },
          receivables: {
            value: Math.round(handLoansGiven),
            percent: totalAssets > 0 ? parseFloat(((handLoansGiven / totalAssets) * 100).toFixed(1)) : 0
          }
        },
        liability_breakdown: {
          home_and_other_loans: {
            value: Math.round(totalLoanOutstanding),
            count: loans.length
          },
          credit_cards: {
            value: Math.round(totalCreditCardDebt),
            count: creditCards.length
          },
          informal_loans_taken: {
            value: Math.round(handLoansTaken),
            count: handLoans.filter(l => l.direction === 'taken').length
          }
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Net worth error:', err);
    res.status(500).json({ error: 'Failed to compute net worth', message: err.message });
  }
});

module.exports = router;
