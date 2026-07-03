// Pulse Slack app — /fin slash command handler
// Slack sends application/x-www-form-urlencoded; we need the raw body
// to verify the HMAC-SHA256 signature before touching any data.
const express = require('express');
const crypto = require('crypto');
// database.js exports the better-sqlite3 handle itself (module.exports = db).
// Destructuring `{ db }` here left it undefined and crashed every /fin command.
const db = require('../db/database');

const router = express.Router();

router.use(express.raw({ type: 'application/x-www-form-urlencoded' }));

function parseBody(raw) {
  return Object.fromEntries(new URLSearchParams(raw.toString()));
}

function verify(req) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const base = `v0:${ts}:${req.body.toString()}`;
  const hash = 'v0=' + crypto.createHmac('sha256', secret).update(base).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(sig));
  } catch {
    return false;
  }
}

function fmt(n) {
  return '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// The /fin command answers for the dashboard owner. Without a user_id
// predicate every query aggregated ALL users' rows — a cross-user data leak
// to any workspace member. Map the Slack workspace to the admin account.
function ownerUserId() {
  const row = db.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY id ASC LIMIT 1').get()
    || db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  return row ? row.id : null;
}

// Mirrors services/chatTools.js get_net_worth (book value; includes NPS and
// active hand loans, which the previous copy omitted).
function getNetworth(uid) {
  const USD_INR = 84;
  const stocks   = db.prepare('SELECT SUM(quantity * avg_buy_price) as v FROM stocks WHERE user_id = ?').get(uid)?.v || 0;
  const usRaw    = db.prepare('SELECT SUM(quantity * avg_buy_price_usd) as v FROM us_stocks WHERE user_id = ?').get(uid)?.v || 0;
  const mf       = db.prepare('SELECT SUM(units * avg_nav) as v FROM mutual_funds WHERE user_id = ?').get(uid)?.v || 0;
  const fd       = db.prepare('SELECT SUM(principal) as v FROM fixed_deposits WHERE user_id = ?').get(uid)?.v || 0;
  const savings  = db.prepare('SELECT SUM(balance) as v FROM savings_accounts WHERE user_id = ?').get(uid)?.v || 0;
  const nps      = db.prepare('SELECT SUM(current_value) as v FROM nps_accounts WHERE user_id = ?').get(uid)?.v || 0;
  const handGiven = db.prepare("SELECT SUM(amount) as v FROM hand_loans WHERE user_id = ? AND direction = 'given' AND status != 'settled'").get(uid)?.v || 0;
  const handTaken = db.prepare("SELECT SUM(amount) as v FROM hand_loans WHERE user_id = ? AND direction = 'taken' AND status != 'settled'").get(uid)?.v || 0;
  const cc       = db.prepare('SELECT SUM(outstanding_balance) as v FROM credit_cards WHERE user_id = ?').get(uid)?.v || 0;
  const loans    = db.prepare("SELECT SUM(outstanding_amount) as v FROM loans WHERE user_id = ? AND status != 'settled'").get(uid)?.v || 0;

  const usStocks = usRaw * USD_INR;
  const assets   = stocks + usStocks + mf + fd + savings + nps + handGiven;
  const liabs    = cc + loans + handTaken;
  return { stocks, usStocks, mf, fd, savings, nps, handGiven, handTaken, assets, cc, loans, liabs, net: assets - liabs };
}

function getUpcoming(uid) {
  const ccDue  = db.prepare('SELECT card_name, outstanding_balance, due_date FROM credit_cards WHERE user_id = ? AND outstanding_balance > 0 ORDER BY due_date ASC LIMIT 5').all(uid);
  const emiDue = db.prepare("SELECT loan_type, lender, emi_amount, emi_date FROM loans WHERE user_id = ? AND status != 'settled' AND emi_amount > 0 ORDER BY emi_date ASC LIMIT 5").all(uid);
  return { ccDue, emiDue };
}

router.post('/command', (req, res) => {
  if (!verify(req)) return res.status(401).send('Unauthorized');

  const uid = ownerUserId();
  if (!uid) {
    return res.json({ response_type: 'ephemeral', text: 'No dashboard account found.' });
  }

  const { text = '' } = parseBody(req.body);
  const cmd = text.trim().toLowerCase().split(/\s+/)[0] || 'help';

  if (cmd === 'networth' || cmd === 'nw') {
    const nw = getNetworth(uid);
    return res.json({
      response_type: 'ephemeral',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '📊 Net Worth (book value)' } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*IN Stocks*\n${fmt(nw.stocks)}` },
            { type: 'mrkdwn', text: `*US Stocks*\n${fmt(nw.usStocks)}` },
            { type: 'mrkdwn', text: `*Mutual Funds*\n${fmt(nw.mf)}` },
            { type: 'mrkdwn', text: `*Fixed Deposits*\n${fmt(nw.fd)}` },
            { type: 'mrkdwn', text: `*Savings*\n${fmt(nw.savings)}` },
            { type: 'mrkdwn', text: `*NPS*\n${fmt(nw.nps)}` },
            { type: 'mrkdwn', text: `*Hand Loans (given)*\n${fmt(nw.handGiven)}` },
            { type: 'mrkdwn', text: `*Total Assets*\n${fmt(nw.assets)}` },
          ],
        },
        { type: 'divider' },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Credit Cards*\n${fmt(nw.cc)}` },
            { type: 'mrkdwn', text: `*Loans*\n${fmt(nw.loans)}` },
            { type: 'mrkdwn', text: `*Hand Loans (taken)*\n${fmt(nw.handTaken)}` },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*Net Worth: ${fmt(nw.net)}*` },
        },
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: 'Book value only — no live prices. Open <https://fin.kirakon.com|fin.kirakon.com> for live data.' }],
        },
      ],
    });
  }

  if (cmd === 'upcoming' || cmd === 'due') {
    const { ccDue, emiDue } = getUpcoming(uid);
    const lines = [];
    ccDue.forEach(c  => lines.push(`• *${c.card_name}* — ${fmt(c.outstanding_balance)} due ${c.due_date || '?'}`));
    emiDue.forEach(e => lines.push(`• *${e.lender} ${e.loan_type}* — EMI ${fmt(e.emi_amount)} on day ${e.emi_date || '?'}`));
    return res.json({
      response_type: 'ephemeral',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '📅 Upcoming Payments' } },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: lines.length ? lines.join('\n') : '_No upcoming payments_' },
        },
      ],
    });
  }

  // Default: help
  return res.json({
    response_type: 'ephemeral',
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '💰 Fin Dashboard' } },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '`/fin networth` — assets, liabilities & net worth (book value)',
            '`/fin upcoming` — upcoming credit card & loan payments',
            '`/fin help` — this message',
          ].join('\n'),
        },
      },
    ],
  });
});

module.exports = router;
