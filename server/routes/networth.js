const express = require('express');
const db = require('../db/database');
const authMiddleware = require('../middleware/auth');
const { getPrice, getUsdInrRate } = require('../services/priceService');

const router = express.Router();

router.use(authMiddleware);

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
    // When a price fetch fails we fall back to avg_buy_price for the running
    // total but record the symbol in `priceWarnings` so the UI can show that
    // the displayed value is partially based on cost basis, not live data.
    const priceWarnings = [];
    let stockValues = 0;
    if (stocks.length > 0) {
      const results = await Promise.all(stocks.map(s => getPrice(`${s.symbol}.NS`)));
      stocks.forEach((s, i) => {
        const r = results[i];
        if (r && r.price) {
          stockValues += s.quantity * r.price;
        } else {
          stockValues += s.quantity * s.avg_buy_price;
          priceWarnings.push({ symbol: s.symbol, error: (r && r.error) || 'unknown', usedFallback: 'avg_buy_price' });
        }
      });
    }

    // ── Fetch live prices for US stocks + live USD/INR rate ──
    let usStockValuesUsd = 0;
    if (usStocks.length > 0) {
      const results = await Promise.all(usStocks.map(s => getPrice(s.symbol)));
      usStocks.forEach((s, i) => {
        const r = results[i];
        if (r && r.price) {
          usStockValuesUsd += s.quantity * r.price;
        } else {
          usStockValuesUsd += s.quantity * s.avg_buy_price_usd;
          priceWarnings.push({ symbol: s.symbol, error: (r && r.error) || 'unknown', usedFallback: 'avg_buy_price_usd' });
        }
      });
    }
    const fx = await getUsdInrRate();
    const usdInrRate = fx.rate;
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
            usd_inr_source: fx.source,
            usd_inr_age_sec: fx.staleSec,
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
      price_warnings: priceWarnings,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Net worth error:', err);
    res.status(500).json({ error: 'Failed to compute net worth', message: err.message });
  }
});

module.exports = router;
