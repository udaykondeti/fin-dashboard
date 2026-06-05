// Sends a daily net-worth summary to Slack (#fin) at a configurable IST time.
// No external cron dependency — a 60-second tick loop checks the clock.
// Configure: DAILY_REPORT_TIME=HH:MM (IST, default 08:30)

const db    = require('../db/database');
const slack = require('./slack');
const { getPrice, getUsdInrRate } = require('./priceService');

const INR = n => '₹' + Math.round(n).toLocaleString('en-IN');

async function buildReport(userId) {
  const stocks      = db.prepare('SELECT * FROM stocks WHERE user_id = ?').all(userId);
  const mfs         = db.prepare('SELECT * FROM mutual_funds WHERE user_id = ?').all(userId);
  const fds         = db.prepare('SELECT * FROM fixed_deposits WHERE user_id = ?').all(userId);
  const usStocks    = db.prepare('SELECT * FROM us_stocks WHERE user_id = ?').all(userId);
  const cards       = db.prepare('SELECT * FROM credit_cards WHERE user_id = ?').all(userId);
  const loans       = db.prepare('SELECT * FROM loans WHERE user_id = ?').all(userId);
  const handLoans   = db.prepare('SELECT * FROM hand_loans WHERE user_id = ? AND status = "active"').all(userId);
  const savings     = db.prepare('SELECT * FROM savings_accounts WHERE user_id = ?').all(userId);
  const nps         = db.prepare('SELECT * FROM nps_accounts WHERE user_id = ?').all(userId);
  const properties  = db.prepare('SELECT * FROM properties WHERE user_id = ?').all(userId);

  // Live prices
  let stockVal = 0;
  if (stocks.length) {
    const results = await Promise.all(stocks.map(s => getPrice(`${s.symbol}.NS`)));
    stocks.forEach((s, i) => {
      const r = results[i];
      stockVal += s.quantity * (r && r.price ? r.price : s.avg_buy_price);
    });
  }
  let usUsd = 0;
  if (usStocks.length) {
    const results = await Promise.all(usStocks.map(s => getPrice(s.symbol)));
    usStocks.forEach((s, i) => {
      const r = results[i];
      usUsd += s.quantity * (r && r.price ? r.price : s.avg_buy_price_usd);
    });
  }
  const fx   = await getUsdInrRate();
  const usInr = usUsd * fx.rate;

  const mfVal   = mfs.reduce((s, m) => s + m.units * m.avg_nav, 0);
  const fdVal   = fds.reduce((s, fd) => {
    const years = Math.max(0, (Date.now() - new Date(fd.start_date)) / (1000 * 60 * 60 * 24 * 365));
    return s + fd.principal * Math.pow(1 + fd.interest_rate / 100, years);
  }, 0);
  const handGiven  = handLoans.filter(l => l.direction === 'given').reduce((s, l) => s + l.amount, 0);
  const savingsVal = savings.reduce((s, a) => s + (Number(a.balance) || 0), 0);
  const npsVal     = nps.reduce((s, n) => s + (Number(n.current_value) || 0), 0);
  const propVal    = properties.reduce((s, p) => {
    const v = Number(p.current_value) || Number(p.purchase_price) || 0;
    return s + v * ((Number(p.ownership_percentage) || 100) / 100);
  }, 0);

  const totalAssets = stockVal + mfVal + fdVal + usInr + handGiven + savingsVal + npsVal + propVal;
  const ccDebt      = cards.reduce((s, c) => s + (c.outstanding_balance || 0), 0);
  const loanDebt    = loans.reduce((s, l) => s + (l.outstanding_amount || 0), 0);
  const handTaken   = handLoans.filter(l => l.direction === 'taken').reduce((s, l) => s + l.amount, 0);
  const totalLiab   = ccDebt + loanDebt + handTaken;
  const netWorth    = totalAssets - totalLiab;

  // Yesterday's snapshot for trend arrow
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yRow = db.prepare(
    'SELECT net_worth FROM networth_snapshots WHERE user_id = ? AND snapshot_date = ?'
  ).get(userId, yesterday.toISOString().slice(0, 10));

  let trendStr = '';
  if (yRow) {
    const diff = netWorth - yRow.net_worth;
    trendStr = diff >= 0
      ? ` _(▲ ${INR(diff)} vs yesterday)_`
      : ` _(▼ ${INR(Math.abs(diff))} vs yesterday)_`;
  }

  const pct = v => totalAssets > 0 ? ` _(${((v / totalAssets) * 100).toFixed(1)}%)_` : '';
  const dateLabel = new Date().toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'
  });

  const lines = [
    `📊 *Daily Net Worth — ${dateLabel}*`,
    ``,
    `💰 *Net Worth: ${INR(netWorth)}*${trendStr}`,
    ``,
    `*Assets: ${INR(totalAssets)}*`,
    `  • Indian Stocks: ${INR(stockVal)}${pct(stockVal)}`,
    `  • Mutual Funds: ${INR(mfVal)}${pct(mfVal)}`,
    `  • Fixed Deposits: ${INR(fdVal)}${pct(fdVal)}`,
    `  • US Stocks: $${usUsd.toFixed(0)} / ${INR(usInr)}${pct(usInr)}`,
    `  • NPS: ${INR(npsVal)}${pct(npsVal)}`,
    `  • Savings: ${INR(savingsVal)}${pct(savingsVal)}`,
    `  • Properties: ${INR(propVal)}${pct(propVal)}`,
    ``,
    `*Liabilities: ${INR(totalLiab)}*`,
    `  • Credit Cards: ${INR(ccDebt)}`,
    `  • Loans: ${INR(loanDebt)}`,
  ];
  if (handTaken > 0) lines.push(`  • Hand Loans: ${INR(handTaken)}`);
  lines.push(``, `🔗 <${process.env.BASE_URL || 'https://fin.kirakon.com'}|View dashboard>`);

  return lines.join('\n');
}

async function sendDailyReport() {
  if (!slack.isSlackConfigured()) return;
  const users = db.prepare('SELECT id, email FROM users').all();
  for (const user of users) {
    try {
      const text = await buildReport(user.id);
      await slack.notify(text);
      console.log(`[dailyReport] Sent for ${user.email}`);
    } catch (e) {
      console.error(`[dailyReport] Failed for user ${user.id}:`, e.message);
    }
  }
}

function startScheduler() {
  const [hh, mm] = (process.env.DAILY_REPORT_TIME || '08:30').split(':').map(Number);
  const targetH = isNaN(hh) ? 8  : hh;
  const targetM = isNaN(mm) ? 30 : mm;

  let lastFiredDate = null;

  function tick() {
    // Compute current time in IST (UTC+5:30)
    const ist     = new Date(Date.now() + (5 * 60 + 30) * 60 * 1000);
    const dateKey = ist.toISOString().slice(0, 10);

    if (ist.getUTCHours() === targetH && ist.getUTCMinutes() === targetM && lastFiredDate !== dateKey) {
      lastFiredDate = dateKey;
      sendDailyReport().catch(e => console.error('[dailyReport] error:', e.message));
    }
    setTimeout(tick, 60 * 1000);
  }

  // Align start to the next full minute so ticks land close to :00 seconds
  const msToNext = (60 - new Date().getSeconds()) * 1000 - new Date().getMilliseconds() + 200;
  setTimeout(tick, msToNext);
  console.log(`[dailyReport] Scheduled at ${String(targetH).padStart(2,'0')}:${String(targetM).padStart(2,'0')} IST`);
}

module.exports = { startScheduler, sendDailyReport };
