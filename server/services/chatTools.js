// Tool dispatcher for the interactive chat agent. Each read tool's SQL
// mirrors the SELECT in the route file named in its comment — keep them
// in sync if the route's query changes. Write-proposal tools never run
// directly; they build a {summary, mutation} payload that the chat
// route's /confirm endpoint executes against the real route handler.
const db = require('../db/database');

// ────────────────────────────── Read tools ───────────────────────────────

const READ = {
  // Mirrors: routes/networth.js
  get_net_worth(_input, { userId }) {
    const sum = (rows, col) => rows.reduce((s, r) => s + (Number(r[col]) || 0), 0);
    const stocks   = db.prepare('SELECT quantity AS q, avg_buy_price AS p FROM stocks WHERE user_id = ?').all(userId);
    const mfs      = db.prepare('SELECT units AS q, avg_nav AS p FROM mutual_funds WHERE user_id = ?').all(userId);
    const fds      = db.prepare('SELECT principal AS p FROM fixed_deposits WHERE user_id = ?').all(userId);
    const us       = db.prepare('SELECT quantity AS q, avg_buy_price_usd AS p FROM us_stocks WHERE user_id = ?').all(userId);
    const savings  = db.prepare('SELECT balance AS p FROM savings_accounts WHERE user_id = ?').all(userId);
    const npsRows  = db.prepare('SELECT current_value AS p FROM nps_accounts WHERE user_id = ?').all(userId);
    const cards    = db.prepare('SELECT outstanding_balance AS p FROM credit_cards WHERE user_id = ?').all(userId);
    const loans    = db.prepare('SELECT outstanding_amount AS p FROM loans WHERE user_id = ?').all(userId);
    const handTaken = db.prepare("SELECT amount AS p FROM hand_loans WHERE user_id = ? AND direction='taken' AND status != 'settled'").all(userId);
    const handGiven = db.prepare("SELECT amount AS p FROM hand_loans WHERE user_id = ? AND direction='given' AND status != 'settled'").all(userId);

    const assets =
        stocks.reduce((s, r) => s + r.q * r.p, 0) +
        mfs.reduce((s, r) => s + r.q * r.p, 0) +
        sum(fds, 'p') + us.reduce((s, r) => s + r.q * r.p, 0) +
        sum(savings, 'p') + sum(npsRows, 'p') + sum(handGiven, 'p');
    const liabilities = sum(cards, 'p') + sum(loans, 'p') + sum(handTaken, 'p');
    return { assets: Math.round(assets), liabilities: Math.round(liabilities), net_worth: Math.round(assets - liabilities) };
  },

  // Mirrors: routes/investments.js, routes/savings.js, routes/insurance.js, routes/nps.js
  query_holdings({ category }, { userId }) {
    const map = {
      stocks:        'SELECT id, symbol, company_name, quantity, avg_buy_price, current_price, notes FROM stocks WHERE user_id = ?',
      mutual_funds:  'SELECT id, fund_name, fund_type, units, avg_nav, current_nav, sip_amount, notes FROM mutual_funds WHERE user_id = ?',
      fds:           'SELECT id, bank_name, fd_type, principal, interest_rate, start_date, maturity_date, notes FROM fixed_deposits WHERE user_id = ?',
      us_stocks:     'SELECT id, symbol, company_name, quantity, avg_buy_price_usd, current_price_usd, notes FROM us_stocks WHERE user_id = ?',
      savings:       'SELECT id, bank_name, account_type, balance, interest_rate, notes FROM savings_accounts WHERE user_id = ?',
      nps:           'SELECT id, pran, tier, total_invested, current_value, equity_pct, bonds_pct, govt_pct, notes FROM nps_accounts WHERE user_id = ?',
      insurance:     'SELECT id, policy_name, insurer, policy_type, premium_amount, premium_frequency, cover_amount, next_due_date, notes FROM insurance_policies WHERE user_id = ?'
    };
    const sql = map[category];
    if (!sql) throw new Error(`Unknown category: ${category}. Valid: ${Object.keys(map).join(', ')}`);
    return db.prepare(sql).all(userId);
  },

  // Mirrors: routes/liabilities.js
  query_liabilities(_input, { userId }) {
    return {
      credit_cards: db.prepare('SELECT id, card_name, bank, card_limit, outstanding_balance, due_date, last4, notes FROM credit_cards WHERE user_id = ?').all(userId),
      loans:        db.prepare('SELECT id, loan_type, lender, principal_amount, outstanding_amount, interest_rate, emi_amount, end_date, notes FROM loans WHERE user_id = ?').all(userId)
    };
  },

  // Mirrors: routes/loans.js
  query_hand_loans({ direction, status }, { userId }) {
    let sql = 'SELECT id, person_name, phone, direction, amount, date, due_date, interest_rate, status, notes FROM hand_loans WHERE user_id = ?';
    const args = [userId];
    if (direction && ['given', 'taken'].includes(direction)) { sql += ' AND direction = ?'; args.push(direction); }
    if (status && ['active', 'partial', 'settled'].includes(status)) { sql += ' AND status = ?'; args.push(status); }
    return db.prepare(sql).all(...args);
  },

  // Mirrors: routes/earnings.js
  query_earnings(_input, { userId }) {
    return db.prepare('SELECT id, source_name, source_type, amount, frequency, share_percentage, is_auto, notes FROM earnings WHERE user_id = ?').all(userId);
  },

  // Mirrors: routes/payments.js
  query_payments({ filter }, { userId }) {
    let sql = 'SELECT id, name, category, amount, frequency, next_due_date, auto_debit, is_active, notes FROM scheduled_payments WHERE user_id = ?';
    const args = [userId];
    if (filter) { sql += ' AND (frequency = ? OR category = ?)'; args.push(filter, filter); }
    return db.prepare(sql).all(...args);
  },

  // Mirrors: routes/tax.js
  query_tax({ year }, { userId }) {
    const ay = year || '2026-27';
    return db.prepare("SELECT id, assessment_year, installment, amount, date_paid, notes FROM advance_tax_payments WHERE user_id = ? AND assessment_year = ?").all(userId, ay);
  },

  // Mirrors: routes/properties.js
  query_properties(_input, { userId }) {
    return db.prepare('SELECT id, name, property_type, purchase_price, current_value, active_rent, notes FROM properties WHERE user_id = ?').all(userId);
  }
};

async function runReadTool(name, input, ctx) {
  const fn = READ[name];
  if (!fn) throw new Error(`Unknown read tool: ${name}`);
  return fn(input || {}, ctx);
}

// ────────────────────────────── Write proposals ──────────────────────────

const PROPOSE = {
  propose_mark_handloan_status({ loan_id, status }, { userId }) {
    const row = db.prepare('SELECT id, person_name, amount FROM hand_loans WHERE id = ? AND user_id = ?').get(loan_id, userId);
    if (!row) throw new Error(`Hand loan #${loan_id} not found`);
    if (!['active', 'partial', 'settled'].includes(status)) throw new Error(`status must be active|partial|settled`);
    return {
      summary: `Mark loan #${row.id} (${row.person_name}, ₹${row.amount.toLocaleString('en-IN')}) as ${status}`,
      mutation: { method: 'PUT', path: `/api/loans/hand-loans/${row.id}`, body: { status } }
    };
  },

  propose_add_earning(input, { userId }) {
    const { source_name, source_type, amount, frequency, share_percentage, notes } = input || {};
    if (!source_name || !amount || !frequency) throw new Error('source_name, amount, frequency required');
    const existing = db.prepare(
      `SELECT id, amount, frequency FROM earnings WHERE user_id = ? AND LOWER(source_name) = LOWER(?) LIMIT 1`
    ).get(userId, source_name);
    return {
      summary: `Add earning: ${source_name} — ₹${Number(amount).toLocaleString('en-IN')} ${frequency.toLowerCase()}` +
               (share_percentage && share_percentage !== 100 ? ` (${share_percentage}% share)` : ''),
      duplicate: existing ? { id: existing.id, hint: `Existing earning "${source_name}" already on file: ₹${Number(existing.amount).toLocaleString('en-IN')} ${String(existing.frequency).toLowerCase()}.` } : null,
      mutation: { method: 'POST', path: '/api/earnings', body: {
        source_name, source_type: source_type || 'Other', amount: Number(amount),
        frequency, share_percentage: Number(share_percentage) || 100, notes: notes || null
      }}
    };
  },

  propose_add_payment(input, { userId }) {
    const { name, category, amount, frequency, next_due_date, auto_debit, notes } = input || {};
    if (!name || !amount || !frequency) throw new Error('name, amount, frequency required');
    const existing = db.prepare(
      `SELECT id, amount, frequency FROM scheduled_payments WHERE user_id = ? AND LOWER(name) = LOWER(?) LIMIT 1`
    ).get(userId, name);
    return {
      summary: `Add scheduled payment: ${name} — ₹${Number(amount).toLocaleString('en-IN')} ${frequency.toLowerCase()}` +
               (next_due_date ? ` (next due ${next_due_date})` : ''),
      duplicate: existing ? { id: existing.id, hint: `Scheduled payment "${name}" already on file: ₹${Number(existing.amount).toLocaleString('en-IN')} ${String(existing.frequency).toLowerCase()}.` } : null,
      mutation: { method: 'POST', path: '/api/payments', body: {
        name, category: category || 'Other', amount: Number(amount),
        frequency, next_due_date: next_due_date || null,
        auto_debit: !!auto_debit, notes: notes || null
      }}
    };
  },

  propose_record_advance_tax(input, { userId }) {
    const { assessment_year, installment, amount, date_paid, notes } = input || {};
    if (!assessment_year || !installment || !amount || !date_paid) throw new Error('assessment_year, installment, amount, date_paid required');
    const existing = db.prepare(
      `SELECT id, amount, date_paid FROM advance_tax_payments WHERE user_id = ? AND assessment_year = ? AND installment = ? LIMIT 1`
    ).get(userId, assessment_year, installment);
    return {
      summary: `Record advance tax: ${installment} for FY ${assessment_year} — ₹${Number(amount).toLocaleString('en-IN')} on ${date_paid}`,
      duplicate: existing ? { id: existing.id, hint: `${installment} for FY ${assessment_year} already recorded: ₹${Number(existing.amount).toLocaleString('en-IN')} on ${existing.date_paid}.` } : null,
      mutation: { method: 'POST', path: '/api/tax/advance', body: {
        assessment_year, installment, amount: Number(amount),
        date_paid, notes: notes || null
      }}
    };
  },

  propose_add_stock(input, { userId }) {
    const { symbol, company_name, quantity, avg_buy_price, notes } = input || {};
    if (!symbol || !quantity) throw new Error('symbol and quantity required');
    const sym = String(symbol).toUpperCase();
    const existing = db.prepare(
      `SELECT id, quantity, avg_buy_price FROM stocks WHERE user_id = ? AND UPPER(symbol) = ? LIMIT 1`
    ).get(userId, sym);
    return {
      summary: `Add stock: ${sym}` +
               (company_name ? ` (${company_name})` : '') +
               ` — ${quantity} shares` +
               (avg_buy_price ? ` @ ₹${Number(avg_buy_price).toLocaleString('en-IN')}` : ''),
      duplicate: existing ? { id: existing.id, hint: `${sym} already in portfolio: ${existing.quantity} shares @ ₹${Number(existing.avg_buy_price).toLocaleString('en-IN')}.` } : null,
      mutation: { method: 'POST', path: '/api/investments/stocks', body: {
        symbol: sym,
        company_name: company_name || symbol,
        quantity: Number(quantity),
        avg_buy_price: Number(avg_buy_price) || 0,
        notes: notes || null
      }}
    };
  },

  propose_add_mutual_fund(input, { userId }) {
    const { fund_name, units, avg_nav, fund_type, notes } = input || {};
    if (!fund_name || !units) throw new Error('fund_name and units required');
    const existing = db.prepare(
      `SELECT id, units, avg_nav FROM mutual_funds WHERE user_id = ? AND LOWER(fund_name) = LOWER(?) LIMIT 1`
    ).get(userId, fund_name);
    return {
      summary: `Add MF: ${fund_name} — ${units} units` +
               (avg_nav ? ` @ ₹${Number(avg_nav).toLocaleString('en-IN')}` : '') +
               (fund_type ? ` (${fund_type})` : ''),
      duplicate: existing ? { id: existing.id, hint: `${fund_name} already in portfolio: ${existing.units} units @ ₹${Number(existing.avg_nav).toLocaleString('en-IN')}.` } : null,
      mutation: { method: 'POST', path: '/api/investments/mutual-funds', body: {
        fund_name,
        units: Number(units),
        avg_nav: Number(avg_nav) || 0,
        fund_type: fund_type || 'Equity',
        notes: notes || null
      }}
    };
  },

  propose_add_nps(input, { userId }) {
    const { pran, tier, total_invested, current_value, equity_pct, bonds_pct, govt_pct, notes } = input || {};
    if (!tier || total_invested == null || current_value == null) throw new Error('tier, total_invested, current_value required');
    if (!['Tier I', 'Tier II'].includes(tier)) throw new Error("tier must be 'Tier I' or 'Tier II'");
    const existing = pran
      ? db.prepare(`SELECT id, tier, current_value FROM nps_accounts WHERE user_id = ? AND pran = ? LIMIT 1`).get(userId, pran)
      : db.prepare(`SELECT id, tier, current_value FROM nps_accounts WHERE user_id = ? AND tier = ? LIMIT 1`).get(userId, tier);
    const eq = Number(equity_pct) || 75;
    const bd = Number(bonds_pct)  || 15;
    const gv = Number(govt_pct)   || 10;
    return {
      summary: `Add NPS ${tier}` +
               (pran ? ` (PRAN ${pran})` : '') +
               ` — invested ₹${Number(total_invested).toLocaleString('en-IN')}, current ₹${Number(current_value).toLocaleString('en-IN')}` +
               ` (${eq}E/${bd}B/${gv}G)`,
      duplicate: existing ? { id: existing.id, hint: `NPS ${tier} already on file: current value ₹${Number(existing.current_value).toLocaleString('en-IN')}.` } : null,
      mutation: { method: 'POST', path: '/api/investments/nps', body: {
        pran: pran || null,
        tier,
        total_invested: Number(total_invested),
        current_value:  Number(current_value),
        equity_pct: eq,
        bonds_pct:  bd,
        govt_pct:   gv,
        notes: notes || null
      }}
    };
  }
};

function buildProposal(name, input, ctx) {
  const fn = PROPOSE[name];
  if (!fn) throw new Error(`Unknown propose tool: ${name}`);
  return fn(input || {}, ctx);
}

// ────────────────────────────── Tool spec for Anthropic ──────────────────

const TOOLS = [
  // Read tools — server auto-executes and feeds result back into the loop
  { name: 'get_net_worth', description: "Compute the user's total assets, total liabilities, and net worth (in INR). No input.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },

  { name: 'query_holdings', description: "Return the user's holdings for one investment category.",
    input_schema: { type: 'object', required: ['category'],
      properties: { category: { type: 'string',
        enum: ['stocks', 'mutual_funds', 'fds', 'us_stocks', 'savings', 'nps', 'insurance'],
        description: 'Which holdings category to fetch.' } },
      additionalProperties: false } },

  { name: 'query_liabilities', description: "Return the user's credit cards and loans.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },

  { name: 'query_hand_loans', description: "Return the user's informal hand loans (lent to or borrowed from people).",
    input_schema: { type: 'object',
      properties: {
        direction: { type: 'string', enum: ['given', 'taken'], description: "Optional: 'given' = money lent, 'taken' = money borrowed." },
        status:    { type: 'string', enum: ['active', 'partial', 'settled'], description: 'Optional status filter.' }
      }, additionalProperties: false } },

  { name: 'query_earnings', description: "Return all of the user's income sources.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },

  { name: 'query_payments', description: "Return the user's scheduled outflows (EMIs, SIPs, insurance premiums, subscriptions, etc.).",
    input_schema: { type: 'object',
      properties: { filter: { type: 'string', description: 'Optional frequency or category to filter on (e.g., "Monthly", "EMI", "SIP").' } },
      additionalProperties: false } },

  { name: 'query_tax', description: "Return advance-tax payments for an assessment year.",
    input_schema: { type: 'object',
      properties: { year: { type: 'string', description: "Assessment year, e.g. '2026-27'. Defaults to current AY." } },
      additionalProperties: false } },

  { name: 'query_properties', description: "Return the user's properties (flats/plots/land) with active rent.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false } },

  // Write proposals — server pauses the loop and shows a confirmation card
  { name: 'propose_mark_handloan_status', description: "Propose flipping a hand loan's status. The user will explicitly confirm before any change is made.",
    input_schema: { type: 'object', required: ['loan_id', 'status'],
      properties: {
        loan_id: { type: 'integer' },
        status:  { type: 'string', enum: ['active', 'partial', 'settled'] }
      }, additionalProperties: false } },

  { name: 'propose_add_earning', description: "Propose adding a new income source (salary, rent, freelance, etc.). The user will explicitly confirm.",
    input_schema: { type: 'object', required: ['source_name', 'amount', 'frequency'],
      properties: {
        source_name:      { type: 'string' },
        source_type:      { type: 'string', enum: ['Salary', 'Rent', 'Interest', 'Dividends', 'Freelance', 'Business', 'Other'] },
        amount:           { type: 'number' },
        frequency:        { type: 'string', enum: ['Monthly', 'Annual', 'One-time'] },
        share_percentage: { type: 'number', minimum: 0, maximum: 100 },
        notes:            { type: 'string' }
      }, additionalProperties: false } },

  { name: 'propose_add_payment', description: "Propose adding a new scheduled outflow. The user will explicitly confirm.",
    input_schema: { type: 'object', required: ['name', 'amount', 'frequency'],
      properties: {
        name:          { type: 'string' },
        category:      { type: 'string', enum: ['EMI', 'SIP', 'Insurance', 'Other'] },
        amount:        { type: 'number' },
        frequency:     { type: 'string', enum: ['Monthly', 'Annual', 'One-time'] },
        next_due_date: { type: 'string', description: 'YYYY-MM-DD' },
        auto_debit:    { type: 'boolean' },
        notes:         { type: 'string' }
      }, additionalProperties: false } },

  { name: 'propose_record_advance_tax', description: "Propose recording an advance-tax installment payment. The user will explicitly confirm.",
    input_schema: { type: 'object', required: ['assessment_year', 'installment', 'amount', 'date_paid'],
      properties: {
        assessment_year: { type: 'string', description: "e.g. '2026-27'" },
        installment:     { type: 'string', description: "e.g. 'Q1 (15 Jun)'" },
        amount:          { type: 'number' },
        date_paid:       { type: 'string', description: 'YYYY-MM-DD' },
        notes:           { type: 'string' }
      }, additionalProperties: false } },

  { name: 'propose_add_stock', description: "Propose adding a new Indian stock holding to the user's portfolio. The user will explicitly confirm.",
    input_schema: { type: 'object', required: ['symbol', 'quantity'],
      properties: {
        symbol:        { type: 'string', description: "NSE/BSE ticker, e.g. 'RELIANCE'." },
        company_name:  { type: 'string' },
        quantity:      { type: 'number', minimum: 0.0001 },
        avg_buy_price: { type: 'number', minimum: 0 },
        notes:         { type: 'string' }
      }, additionalProperties: false } },

  { name: 'propose_add_mutual_fund', description: "Propose adding a new mutual fund holding. The user will explicitly confirm.",
    input_schema: { type: 'object', required: ['fund_name', 'units'],
      properties: {
        fund_name: { type: 'string' },
        units:     { type: 'number', minimum: 0.0001 },
        avg_nav:   { type: 'number', minimum: 0 },
        fund_type: { type: 'string', enum: ['Equity', 'Debt', 'Hybrid', 'ELSS', 'Index', 'ETF', 'Other'] },
        notes:     { type: 'string' }
      }, additionalProperties: false } },

  { name: 'propose_add_nps', description: "Propose adding an NPS (National Pension System) account holding. The user will explicitly confirm.",
    input_schema: { type: 'object', required: ['tier', 'total_invested', 'current_value'],
      properties: {
        pran:           { type: 'string', description: 'Permanent Retirement Account Number (optional).' },
        tier:           { type: 'string', enum: ['Tier I', 'Tier II'], description: "Account tier." },
        total_invested: { type: 'number', minimum: 0, description: 'Total amount invested so far (₹).' },
        current_value:  { type: 'number', minimum: 0, description: 'Current corpus value (₹).' },
        equity_pct:     { type: 'number', minimum: 0, maximum: 100, description: 'Equity allocation %. Defaults to 75.' },
        bonds_pct:      { type: 'number', minimum: 0, maximum: 100, description: 'Corporate bonds %. Defaults to 15.' },
        govt_pct:       { type: 'number', minimum: 0, maximum: 100, description: 'Government securities %. Defaults to 10.' },
        notes:          { type: 'string' }
      }, additionalProperties: false } }
];

// Tool name => kind. Used by the chat loop to decide auto-run vs proposal.
const TOOL_KIND = {};
for (const k of Object.keys(READ))    TOOL_KIND[k] = 'read';
for (const k of Object.keys(PROPOSE)) TOOL_KIND[k] = 'propose';

module.exports = { TOOLS, TOOL_KIND, runReadTool, buildProposal };
