# Agent Chat Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-thread agent chat page where the user talks to a Financial Advisor grounded in their own data, with streaming responses, server-auto-executed read tools, and inline write-proposal cards that the user explicitly confirms.

**Architecture:** New `/api/chat` REST + SSE module backed by a new `services/chatAgent.js` that owns the multi-turn streaming tool loop. Reuses the Anthropic SDK client and `PRICE_TABLE` from `services/agent.js` but does not extend it (single-shot dispatcher stays untouched). Frontend lives in the existing single-file `public/index.html` with a new `#page-agent` block, sidebar of threads, and `EventSource`-based streaming renderer.

**Tech Stack:** Express, better-sqlite3, `@anthropic-ai/sdk` ^0.91.1, vanilla JS frontend, Server-Sent Events. No bundler, no test framework — verification is via small Node smoke scripts run with `node scripts/<name>.js`.

**Spec:** `docs/superpowers/specs/2026-04-30-agent-chat-page-design.md`

**Implementation note on read tools.** The spec called for "thin wrappers over existing route handlers, invoked programmatically." On reflection this would force every consumed route file (~11 of them) to refactor handlers into named exports just so we can synthesize a fake req/res. For v1 we use the simpler pragmatic path: **inline DB queries inside the chat tool dispatcher**, with a comment per tool naming the route file whose query it mirrors. Each is 1–3 lines of SQL; if the underlying route's query changes, update the matching tool. This is documented at the top of the tool file. Future iteration can refactor to programmatic invocation if drift becomes a real problem.

---

## File map

**Create:**
- `server/services/chatAgent.js` — multi-turn streaming loop, tool dispatch, audit
- `server/services/chatTools.js` — read-tool dispatchers + write-proposal registry (mutation map + summary builders)
- `server/routes/chat.js` — REST + SSE endpoints
- `scripts/test-chat.js` — manual smoke harness

**Modify:**
- `server/db/database.js` — add `agent_threads`, `agent_messages`; ALTER `agent_calls` to add `thread_id`
- `server/index.js` — mount `/api/chat`
- `public/index.html` — new page block, CSS rules, JS module, nav tab buttons, navigateTo hook

---

## Task 1: DB schema for threads, messages, and the audit-link column

**Files:**
- Modify: `server/db/database.js` (the `CREATE TABLE IF NOT EXISTS` block ending around line 372)

- [ ] **Step 1.1: Add the two new tables and the ALTER**

In `server/db/database.js`, immediately after the existing `agent_calls` index lines (the two `CREATE INDEX ... idx_agent_calls_*` lines), and inside the same `db.exec(\`...\`)` block, append:

```sql
    CREATE TABLE IF NOT EXISTS agent_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT 'New chat',
      agent_kind TEXT NOT NULL DEFAULT 'financial_advisor',
      model TEXT NOT NULL DEFAULT 'claude-haiku-4-5',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_threads_user ON agent_threads(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
      content TEXT,
      tool_uses TEXT,
      status TEXT NOT NULL DEFAULT 'final' CHECK(status IN ('streaming','final')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(thread_id, id);
```

- [ ] **Step 1.2: Add the ALTER for `agent_calls.thread_id` outside the CREATE block**

`ALTER TABLE` does not support `IF NOT EXISTS` in SQLite, so it must run separately with a try/catch that swallows the "duplicate column" error. After the closing `\`)` of `db.exec`, before the `console.log('Database tables initialized.');` line, add:

```js
  // Add thread_id link column for chat-driven calls. Idempotent: a second
  // run throws "duplicate column name", which we swallow.
  try { db.exec('ALTER TABLE agent_calls ADD COLUMN thread_id INTEGER'); }
  catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
```

- [ ] **Step 1.3: Restart the server to apply the migration, verify**

Run:
```bash
rm -f /tmp/fin-dashboard.log
NODE_ENV=development npm start > /tmp/fin-dashboard.log 2>&1 &
sleep 2
grep -i "Database tables initialized" /tmp/fin-dashboard.log && echo "DB OK"
sqlite3 server/db/data.db ".schema agent_threads"
sqlite3 server/db/data.db ".schema agent_messages"
sqlite3 server/db/data.db "PRAGMA table_info(agent_calls);" | grep thread_id
kill %1
```

Expected: each command prints schema/column rows; `thread_id|INTEGER|0||0` appears in the agent_calls listing.

- [ ] **Step 1.4: Commit**

```bash
git add server/db/database.js
git commit -m "feat(db): add agent_threads, agent_messages, thread_id link on agent_calls"
```

---

## Task 2: Tool dispatcher module — read tools + write-proposal registry

**Files:**
- Create: `server/services/chatTools.js`
- Create: `scripts/test-chat-tools.js`

The chatTools module exports three things:

- `TOOLS` — the JSON-schema tool definitions sent to Anthropic.
- `runReadTool(name, input, { userId })` — executes a read tool against the DB and returns the JSON shape the agent will see.
- `buildProposal(name, input, { userId })` — for write-proposal tools, builds the `{ tool_use_id, name, input, summary, mutation }` object shown to the user. The actual mutation runs later in `routes/chat.js` when the user confirms.

Each read tool's SQL mirrors the corresponding route handler. A comment above each block names the route whose query it duplicates.

- [ ] **Step 2.1: Write the failing smoke test**

Create `scripts/test-chat-tools.js`:

```js
// Manual smoke harness for server/services/chatTools.js. Run:
//   node scripts/test-chat-tools.js
// Expects a real DB at server/db/data.db with at least one user (id=1) and
// some seeded data; uses the seeded admin from seedData().
const tools = require('../server/services/chatTools');

function eq(label, actual, predicate) {
  const ok = predicate(actual);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log('  got:', JSON.stringify(actual).slice(0, 200)); process.exitCode = 1; }
}

(async () => {
  // TOOLS array is well-formed
  eq('TOOLS array has both read + propose tools',
    tools.TOOLS,
    t => Array.isArray(t) && t.some(x => x.name === 'get_net_worth') && t.some(x => x.name.startsWith('propose_')));

  // get_net_worth returns object with assets/liabilities/net keys
  const nw = await tools.runReadTool('get_net_worth', {}, { userId: 1 });
  eq('get_net_worth returns numeric net_worth',
    nw,
    r => typeof r === 'object' && typeof r.net_worth === 'number');

  // query_holdings({category:'stocks'}) returns an array
  const stocks = await tools.runReadTool('query_holdings', { category: 'stocks' }, { userId: 1 });
  eq('query_holdings stocks returns array',
    stocks,
    r => Array.isArray(r));

  // Unknown tool throws
  let threw = false;
  try { await tools.runReadTool('does_not_exist', {}, { userId: 1 }); }
  catch (e) { threw = true; }
  eq('unknown read tool throws', threw, x => x === true);

  // propose_mark_handloan_status builds a proposal payload
  const prop = tools.buildProposal('propose_mark_handloan_status',
    { loan_id: 1, status: 'settled' }, { userId: 1 });
  eq('propose_mark_handloan_status builds mutation',
    prop,
    r => r && r.mutation && r.mutation.method === 'PUT' && typeof r.summary === 'string');

  console.log('Done.');
})();
```

- [ ] **Step 2.2: Run the test, confirm it fails**

Run:
```bash
node scripts/test-chat-tools.js
```

Expected: `Cannot find module '../server/services/chatTools'`.

- [ ] **Step 2.3: Implement `chatTools.js`**

Create `server/services/chatTools.js`:

```js
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

  propose_add_earning(input, _ctx) {
    const { source_name, source_type, amount, frequency, share_percentage, notes } = input || {};
    if (!source_name || !amount || !frequency) throw new Error('source_name, amount, frequency required');
    return {
      summary: `Add earning: ${source_name} — ₹${Number(amount).toLocaleString('en-IN')} ${frequency.toLowerCase()}` +
               (share_percentage && share_percentage !== 100 ? ` (${share_percentage}% share)` : ''),
      mutation: { method: 'POST', path: '/api/earnings', body: {
        source_name, source_type: source_type || 'Other', amount: Number(amount),
        frequency, share_percentage: Number(share_percentage) || 100, notes: notes || null
      }}
    };
  },

  propose_add_payment(input, _ctx) {
    const { name, category, amount, frequency, next_due_date, auto_debit, notes } = input || {};
    if (!name || !amount || !frequency) throw new Error('name, amount, frequency required');
    return {
      summary: `Add scheduled payment: ${name} — ₹${Number(amount).toLocaleString('en-IN')} ${frequency.toLowerCase()}` +
               (next_due_date ? ` (next due ${next_due_date})` : ''),
      mutation: { method: 'POST', path: '/api/payments', body: {
        name, category: category || 'Other', amount: Number(amount),
        frequency, next_due_date: next_due_date || null,
        auto_debit: !!auto_debit, notes: notes || null
      }}
    };
  },

  propose_record_advance_tax(input, _ctx) {
    const { assessment_year, installment, amount, date_paid, notes } = input || {};
    if (!assessment_year || !installment || !amount || !date_paid) throw new Error('assessment_year, installment, amount, date_paid required');
    return {
      summary: `Record advance tax: ${installment} for FY ${assessment_year} — ₹${Number(amount).toLocaleString('en-IN')} on ${date_paid}`,
      mutation: { method: 'POST', path: '/api/tax/advance', body: {
        assessment_year, installment, amount: Number(amount),
        date_paid, notes: notes || null
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
      }, additionalProperties: false } }
];

// Tool name => kind. Used by the chat loop to decide auto-run vs proposal.
const TOOL_KIND = {};
for (const k of Object.keys(READ))    TOOL_KIND[k] = 'read';
for (const k of Object.keys(PROPOSE)) TOOL_KIND[k] = 'propose';

module.exports = { TOOLS, TOOL_KIND, runReadTool, buildProposal };
```

- [ ] **Step 2.4: Run the smoke test, confirm all 5 PASS**

```bash
node scripts/test-chat-tools.js
```

Expected: 5 lines starting with `PASS`, then `Done.`. If any FAIL, fix the cause and re-run.

- [ ] **Step 2.5: Commit**

```bash
git add server/services/chatTools.js scripts/test-chat-tools.js
git commit -m "feat(chat): tool dispatcher with read tools + write-proposal registry"
```

---

## Task 3: chatAgent service core (non-streaming, with tools, with audit)

This task gets the agent loop working end-to-end **without** SSE streaming. We collect the full Anthropic response, run the tool loop synchronously, persist messages, and return the final text. Streaming gets layered on in Task 4.

**Files:**
- Create: `server/services/chatAgent.js`
- Modify: `scripts/test-chat-tools.js` → rename to `scripts/test-chat.js` and extend

- [ ] **Step 3.1: Rename the smoke harness and add a chatAgent test**

Rename and extend in one go:
```bash
git mv scripts/test-chat-tools.js scripts/test-chat.js
```

Append to `scripts/test-chat.js`:

```js
// chatAgent integration smoke (requires ANTHROPIC_API_KEY)
const chatAgent = require('../server/services/chatAgent');

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('SKIP chatAgent — no ANTHROPIC_API_KEY in env');
    return;
  }

  // Create a thread, send a message, expect a final assistant text and an audit row.
  const threadId = chatAgent.createThread({ userId: 1 });
  eq('createThread returns numeric id', threadId, x => Number.isInteger(x) && x > 0);

  const result = await chatAgent.sendMessage({
    threadId, userId: 1,
    content: 'In one short sentence, what number do I get if I add 2 and 3?'
  });
  eq('sendMessage returns final text',
    result,
    r => r && r.status === 'final' && typeof r.text === 'string' && r.text.length > 0);

  // Tool round-trip: ask a question that should trigger get_net_worth
  const result2 = await chatAgent.sendMessage({
    threadId, userId: 1,
    content: 'Use the get_net_worth tool and tell me the net worth number.'
  });
  eq('tool round-trip returns final text',
    result2,
    r => r && r.status === 'final');
})();
```

- [ ] **Step 3.2: Run the test to confirm it fails before we implement**

```bash
node scripts/test-chat.js
```

Expected: read-tool tests still PASS, then `Cannot find module '../server/services/chatAgent'`.

- [ ] **Step 3.3: Implement `chatAgent.js` (non-streaming first)**

Create `server/services/chatAgent.js`:

```js
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../db/database');
const tools = require('./chatTools');

// USD per 1M tokens. Mirrors PRICE_TABLE in services/agent.js — kept in sync
// manually because the chat module can't import from services/agent.js
// without pulling in its single-shot machinery.
const PRICE_TABLE = {
  'claude-haiku-4-5':  { input: 1.0,  output: 5.0  },
  'claude-sonnet-4-5': { input: 3.0,  output: 15.0 },
  'claude-opus-4-5':   { input: 15.0, output: 75.0 }
};
const DEFAULT_MODEL = 'claude-haiku-4-5';

function isAgentConfigured() { return !!process.env.ANTHROPIC_API_KEY; }
function getClient() {
  if (!isAgentConfigured()) throw new Error('Anthropic agent is not configured. Set ANTHROPIC_API_KEY.');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ────────────────────────────── Thread + message persistence ──────────────

const insertThread = db.prepare(`
  INSERT INTO agent_threads (user_id, agent_kind, model) VALUES (?, ?, ?)
`);
const updateThreadTouch = db.prepare(`UPDATE agent_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`);
const updateThreadTitle = db.prepare(`UPDATE agent_threads SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`);
const getThread = db.prepare(`SELECT * FROM agent_threads WHERE id = ? AND user_id = ?`);
const insertMessage = db.prepare(`
  INSERT INTO agent_messages (thread_id, role, content, tool_uses, status)
  VALUES (?, ?, ?, ?, ?)
`);
const updateMessageStatus = db.prepare(`UPDATE agent_messages SET status = ?, content = COALESCE(?, content), tool_uses = COALESCE(?, tool_uses) WHERE id = ?`);
const listMessages = db.prepare(`SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY id ASC`);
const insertCall = db.prepare(`
  INSERT INTO agent_calls (user_id, task_type, model, input_hash, input_preview, output_preview,
    tokens_in, tokens_out, cost_usd, latency_ms, error, thread_id)
  VALUES (?, 'interactive_chat', ?, '', ?, ?, ?, ?, ?, ?, ?, ?)
`);

function createThread({ userId, agentKind = 'financial_advisor', model = DEFAULT_MODEL } = {}) {
  return Number(insertThread.run(userId, agentKind, model).lastInsertRowid);
}

// ────────────────────────────── System prompt ─────────────────────────────

function systemPromptFor(agentKind) {
  if (agentKind === 'financial_advisor') {
    return [
      "You are a financial advisor agent embedded in the user's personal-finance dashboard (fin.kirakon.com).",
      "Currency is INR (₹) unless stated otherwise. The user is an Indian taxpayer; default to Indian tax rules and the New Tax Regime unless they say otherwise.",
      "Use the read tools (get_net_worth, query_holdings, query_liabilities, query_hand_loans, query_earnings, query_payments, query_tax, query_properties) whenever the answer depends on the user's actual data — do not guess.",
      "When the user asks you to make a change to their data, use a propose_* tool. NEVER claim a change has been made until the user confirms the proposal — the system will execute the mutation only after explicit user approval.",
      "Be concise. Bullet lists for >2 items. Numbers should be formatted with Indian commas (e.g. ₹1,50,000)."
    ].join('\n');
  }
  return 'You are a helpful assistant.';
}

// ────────────────────────────── Conversation construction ────────────────

// Convert agent_messages rows into the Anthropic Messages API shape.
function rowsToMessages(rows) {
  const out = [];
  for (const r of rows) {
    if (r.status !== 'final') continue;            // skip half-written rows
    if (r.role === 'user') {
      out.push({ role: 'user', content: r.content });
    } else if (r.role === 'assistant') {
      const blocks = [];
      if (r.content) blocks.push({ type: 'text', text: r.content });
      const tu = r.tool_uses ? JSON.parse(r.tool_uses) : [];
      for (const t of tu) blocks.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
      out.push({ role: 'assistant', content: blocks });
    } else if (r.role === 'tool') {
      // tool_result blocks are user-role per Anthropic API
      const parsed = JSON.parse(r.content);
      out.push({ role: 'user', content: [
        { type: 'tool_result', tool_use_id: parsed.tool_use_id, content: JSON.stringify(parsed.result), is_error: !!parsed.is_error }
      ]});
    }
  }
  return out;
}

// ────────────────────────────── Main entry: sendMessage ──────────────────

async function sendMessage({ threadId, userId, content }) {
  const t = getThread.get(threadId, userId);
  if (!t) throw new Error(`Thread ${threadId} not found for user ${userId}`);
  if (!isAgentConfigured()) throw new Error('Anthropic agent is not configured. Set ANTHROPIC_API_KEY.');

  // Persist user message
  const userMsgId = Number(insertMessage.run(threadId, 'user', content, null, 'final').lastInsertRowid);
  // Auto-title on first user message
  const msgCountRow = db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE thread_id = ? AND role = "user"').get(threadId);
  if (msgCountRow.n === 1) {
    updateThreadTitle.run(content.slice(0, 40).trim() || 'New chat', threadId, userId);
  } else {
    updateThreadTouch.run(threadId, userId);
  }

  // Multi-turn loop. On each iteration we send the conversation, examine
  // the response: if it ended with stop_reason === 'tool_use' and ALL the
  // tool calls are read tools, run them, append tool_result blocks, and
  // loop. If a propose_* tool appears, persist the assistant message in
  // 'streaming' state and return a 'paused' result for the caller to
  // surface as a proposal card.

  const client = getClient();
  let totalIn = 0, totalOut = 0;
  const t0 = Date.now();
  let lastError = null;

  for (let iter = 0; iter < 8; iter++) {
    const messages = rowsToMessages(listMessages.all(threadId));
    let resp;
    try {
      resp = await client.messages.create({
        model: t.model,
        max_tokens: 1024,
        system: systemPromptFor(t.agent_kind),
        tools: tools.TOOLS,
        messages
      });
    } catch (e) {
      lastError = e.message;
      break;
    }
    totalIn  += resp.usage?.input_tokens  || 0;
    totalOut += resp.usage?.output_tokens || 0;

    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const toolUses = resp.content.filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input }));

    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
      // Final assistant turn
      Number(insertMessage.run(threadId, 'assistant', text, toolUses.length ? JSON.stringify(toolUses) : null, 'final').lastInsertRowid);
      auditCall({ userId, threadId, model: t.model, content, text, totalIn, totalOut, t0, error: null });
      return { status: 'final', text };
    }

    // tool_use stop. Decide kind for each.
    const proposals = toolUses.filter(u => tools.TOOL_KIND[u.name] === 'propose');
    if (proposals.length > 0) {
      // Persist assistant message (with text + tool_uses) as streaming.
      // It stays "streaming" until /confirm finalises it.
      const asstId = Number(insertMessage.run(threadId, 'assistant', text, JSON.stringify(toolUses), 'streaming').lastInsertRowid);
      // Build a proposal payload per propose_* tool. (We send only the
      // first one back to the caller; multiple proposals in one turn are
      // rare and would require a UI for batch-confirmation.)
      const first = proposals[0];
      const payload = tools.buildProposal(first.name, first.input, { userId });
      auditCall({ userId, threadId, model: t.model, content, text, totalIn, totalOut, t0, error: null });
      return { status: 'paused', text, message_id: asstId, proposal: { tool_use_id: first.id, name: first.name, input: first.input, ...payload } };
    }

    // All read tools — run them and append tool_result rows, then loop.
    Number(insertMessage.run(threadId, 'assistant', text, JSON.stringify(toolUses), 'final').lastInsertRowid);
    for (const u of toolUses) {
      let result, isError = false;
      try { result = await tools.runReadTool(u.name, u.input, { userId }); }
      catch (e) { result = { error: e.message }; isError = true; }
      insertMessage.run(threadId, 'tool',
        JSON.stringify({ tool_use_id: u.id, name: u.name, result, is_error: isError }), null, 'final');
    }
  }

  if (lastError) {
    auditCall({ userId, threadId, model: t.model, content, text: '', totalIn, totalOut, t0, error: lastError });
    throw new Error(lastError);
  }
  // Hit iteration cap without final — treat as error for now.
  auditCall({ userId, threadId, model: t.model, content, text: '', totalIn, totalOut, t0, error: 'iteration_cap' });
  throw new Error('Tool loop did not converge in 8 iterations');
}

function auditCall({ userId, threadId, model, content, text, totalIn, totalOut, t0, error }) {
  const prices = PRICE_TABLE[model] || PRICE_TABLE[DEFAULT_MODEL];
  const cost = (totalIn / 1_000_000) * prices.input + (totalOut / 1_000_000) * prices.output;
  insertCall.run(userId, model, content.slice(0, 200), (text || '').slice(0, 200),
    totalIn, totalOut, cost, Date.now() - t0, error, threadId);
}

// Confirm/reject a pending proposal. Called from the chat route after the
// user clicks a button. If decision === 'confirm', the caller must dispatch
// the stored mutation against the real route handler and pass the result
// in here so we can write a tool_result row and finalize the assistant
// message.
function recordToolResult({ threadId, userId, message_id, tool_use_id, result, is_error }) {
  const t = getThread.get(threadId, userId);
  if (!t) throw new Error(`Thread ${threadId} not found`);
  // Append tool result row
  insertMessage.run(threadId, 'tool',
    JSON.stringify({ tool_use_id, name: 'proposal_result', result, is_error: !!is_error }), null, 'final');
  // Finalize the assistant row
  updateMessageStatus.run('final', null, null, message_id);
  updateThreadTouch.run(threadId, userId);
}

module.exports = {
  isAgentConfigured,
  createThread,
  sendMessage,
  recordToolResult,
  // exposed for routes:
  _getThread: (id, userId) => getThread.get(id, userId),
  _listMessages: (threadId) => listMessages.all(threadId),
  _updateThread: (id, userId, fields) => {
    const cols = []; const vals = [];
    for (const k of ['title', 'agent_kind', 'model']) if (fields[k] != null) { cols.push(`${k} = ?`); vals.push(fields[k]); }
    if (!cols.length) return;
    db.prepare(`UPDATE agent_threads SET ${cols.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`).run(...vals, id, userId);
  },
  _deleteThread: (id, userId) => db.prepare('DELETE FROM agent_threads WHERE id = ? AND user_id = ?').run(id, userId),
  _listThreads: (userId) => db.prepare('SELECT id, title, agent_kind, model, updated_at FROM agent_threads WHERE user_id = ? ORDER BY updated_at DESC').all(userId)
};
```

- [ ] **Step 3.4: Run the smoke test**

```bash
node scripts/test-chat.js
```

Expected: all read-tool PASSes, then either:
- `SKIP chatAgent — no ANTHROPIC_API_KEY in env` (if you don't have the key locally), or
- two `PASS` lines from chatAgent if you do.

- [ ] **Step 3.5: Commit**

```bash
git add server/services/chatAgent.js scripts/test-chat.js
git commit -m "feat(chat): chatAgent service with multi-turn tool loop and audit"
```

---

## Task 4: Add streaming variant via SSE

The non-streaming `sendMessage` is the algorithmic backbone. The streaming variant is a thin shell around it that uses `client.messages.stream()` instead of `messages.create()` and emits SSE events per text delta and tool boundary.

**Files:**
- Modify: `server/services/chatAgent.js` — add `streamMessage(opts, emit)`

- [ ] **Step 4.1: Add `streamMessage` to chatAgent.js**

Append before the `module.exports = { ... }` block:

```js
// Streaming variant. `emit(event, data)` is invoked for each SSE-shaped
// event. Returns the same shape as sendMessage — the route module
// translates {status, ...} into the final SSE event so the client knows
// the stream is done.
async function streamMessage({ threadId, userId, content }, emit) {
  const t = getThread.get(threadId, userId);
  if (!t) throw new Error(`Thread ${threadId} not found for user ${userId}`);
  if (!isAgentConfigured()) throw new Error('Anthropic agent is not configured. Set ANTHROPIC_API_KEY.');

  const userMsgId = Number(insertMessage.run(threadId, 'user', content, null, 'final').lastInsertRowid);
  emit('thread_meta', { user_message_id: userMsgId });

  const msgCountRow = db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE thread_id = ? AND role = "user"').get(threadId);
  if (msgCountRow.n === 1) updateThreadTitle.run(content.slice(0, 40).trim() || 'New chat', threadId, userId);
  else updateThreadTouch.run(threadId, userId);

  const client = getClient();
  let totalIn = 0, totalOut = 0;
  const t0 = Date.now();

  for (let iter = 0; iter < 8; iter++) {
    const messages = rowsToMessages(listMessages.all(threadId));
    const stream = client.messages.stream({
      model: t.model, max_tokens: 1024,
      system: systemPromptFor(t.agent_kind),
      tools: tools.TOOLS, messages
    });

    let textBuf = '';
    let asstId = null;
    const toolUses = [];

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        if (event.content_block.type === 'text' && asstId == null) {
          asstId = Number(insertMessage.run(threadId, 'assistant', '', null, 'streaming').lastInsertRowid);
          emit('assistant_start', { message_id: asstId });
        }
        if (event.content_block.type === 'tool_use') {
          toolUses.push({ id: event.content_block.id, name: event.content_block.name, input_buf: '' });
        }
      } else if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          textBuf += event.delta.text;
          emit('text', { delta: event.delta.text });
        } else if (event.delta.type === 'input_json_delta') {
          toolUses[toolUses.length - 1].input_buf += event.delta.partial_json;
        }
      }
    }

    const final = await stream.finalMessage();
    totalIn  += final.usage?.input_tokens  || 0;
    totalOut += final.usage?.output_tokens || 0;

    // Resolve tool_use inputs (input_buf is a JSON string; the SDK also
    // exposes parsed input on the final block, prefer that).
    const finalToolUses = final.content.filter(b => b.type === 'tool_use')
      .map(b => ({ id: b.id, name: b.name, input: b.input }));

    if (final.stop_reason !== 'tool_use' || finalToolUses.length === 0) {
      // Finalize the assistant row with the buffered text
      if (asstId == null) asstId = Number(insertMessage.run(threadId, 'assistant', textBuf, null, 'final').lastInsertRowid);
      else updateMessageStatus.run('final', textBuf, null, asstId);
      const cost = auditAndCost({ userId, threadId, model: t.model, content, text: textBuf, totalIn, totalOut, t0, error: null });
      emit('done', { message_id: asstId, usage: { in: totalIn, out: totalOut, cost_usd: cost } });
      return;
    }

    const proposals = finalToolUses.filter(u => tools.TOOL_KIND[u.name] === 'propose');
    if (proposals.length > 0) {
      // Persist assistant message with text + tool_uses, status streaming
      if (asstId == null) {
        asstId = Number(insertMessage.run(threadId, 'assistant', textBuf, JSON.stringify(finalToolUses), 'streaming').lastInsertRowid);
      } else {
        updateMessageStatus.run('streaming', textBuf, JSON.stringify(finalToolUses), asstId);
      }
      const first = proposals[0];
      let payload;
      try { payload = tools.buildProposal(first.name, first.input, { userId }); }
      catch (e) { emit('error', { message: e.message }); return; }
      emit('proposal', {
        tool_use_id: first.id, name: first.name, input: first.input,
        message_id: asstId, summary: payload.summary, mutation: payload.mutation
      });
      auditAndCost({ userId, threadId, model: t.model, content, text: textBuf, totalIn, totalOut, t0, error: null });
      return;
    }

    // All read tools — finalize the assistant row, run them, loop.
    if (asstId == null) asstId = Number(insertMessage.run(threadId, 'assistant', textBuf, JSON.stringify(finalToolUses), 'final').lastInsertRowid);
    else updateMessageStatus.run('final', textBuf, JSON.stringify(finalToolUses), asstId);
    for (const u of finalToolUses) {
      emit('tool_use', { id: u.id, name: u.name, input: u.input });
      let result, isError = false;
      try { result = await tools.runReadTool(u.name, u.input, { userId }); }
      catch (e) { result = { error: e.message }; isError = true; }
      insertMessage.run(threadId, 'tool',
        JSON.stringify({ tool_use_id: u.id, name: u.name, result, is_error: isError }), null, 'final');
      emit('tool_result', { tool_use_id: u.id, status: isError ? 'error' : 'ok', result });
    }
  }

  emit('error', { message: 'Tool loop did not converge in 8 iterations' });
}

function auditAndCost({ userId, threadId, model, content, text, totalIn, totalOut, t0, error }) {
  const prices = PRICE_TABLE[model] || PRICE_TABLE[DEFAULT_MODEL];
  const cost = (totalIn / 1_000_000) * prices.input + (totalOut / 1_000_000) * prices.output;
  insertCall.run(userId, model, content.slice(0, 200), (text || '').slice(0, 200),
    totalIn, totalOut, cost, Date.now() - t0, error, threadId);
  return cost;
}
```

Replace the `module.exports` block with:

```js
module.exports = {
  isAgentConfigured,
  createThread,
  sendMessage,       // non-streaming, used by smoke test
  streamMessage,     // SSE-streaming, used by routes
  recordToolResult,
  _getThread: (id, userId) => getThread.get(id, userId),
  _listMessages: (threadId) => listMessages.all(threadId),
  _updateThread: (id, userId, fields) => {
    const cols = []; const vals = [];
    for (const k of ['title', 'agent_kind', 'model']) if (fields[k] != null) { cols.push(`${k} = ?`); vals.push(fields[k]); }
    if (!cols.length) return;
    db.prepare(`UPDATE agent_threads SET ${cols.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`).run(...vals, id, userId);
  },
  _deleteThread: (id, userId) => db.prepare('DELETE FROM agent_threads WHERE id = ? AND user_id = ?').run(id, userId),
  _listThreads: (userId) => db.prepare('SELECT id, title, agent_kind, model, updated_at FROM agent_threads WHERE user_id = ? ORDER BY updated_at DESC').all(userId)
};
```

- [ ] **Step 4.2: Add a streaming smoke test**

Append to `scripts/test-chat.js`:

```js
(async () => {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const threadId = chatAgent.createThread({ userId: 1 });
  const events = [];
  await chatAgent.streamMessage(
    { threadId, userId: 1, content: 'Say hi in 3 words.' },
    (event, data) => events.push({ event, data })
  );
  eq('streamMessage emits assistant_start',
    events,
    e => e.some(x => x.event === 'assistant_start'));
  eq('streamMessage emits text deltas',
    events,
    e => e.some(x => x.event === 'text'));
  eq('streamMessage emits done',
    events,
    e => e.some(x => x.event === 'done'));
})();
```

- [ ] **Step 4.3: Run the smoke test**

```bash
node scripts/test-chat.js
```

Expected: all earlier PASSes + 3 new PASSes (or skipped if no API key).

- [ ] **Step 4.4: Commit**

```bash
git add server/services/chatAgent.js scripts/test-chat.js
git commit -m "feat(chat): SSE-streaming variant of chatAgent.sendMessage"
```

---

## Task 5: REST routes for thread CRUD

**Files:**
- Create: `server/routes/chat.js`
- Modify: `server/index.js` — mount `/api/chat`

- [ ] **Step 5.1: Create `routes/chat.js` with the CRUD endpoints**

```js
const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const chatAgent = require('../services/chatAgent');

router.use(authMiddleware);

// GET /api/chat/threads
router.get('/threads', (req, res) => {
  res.json({ threads: chatAgent._listThreads(req.user.id) });
});

// POST /api/chat/threads
router.post('/threads', (req, res) => {
  const { agent_kind, model } = req.body || {};
  const id = chatAgent.createThread({ userId: req.user.id, agentKind: agent_kind, model });
  res.status(201).json({ id });
});

// GET /api/chat/threads/:id
router.get('/threads/:id', (req, res) => {
  const id = Number(req.params.id);
  const thread = chatAgent._getThread(id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  res.json({ thread, messages: chatAgent._listMessages(id) });
});

// PATCH /api/chat/threads/:id
router.patch('/threads/:id', (req, res) => {
  const id = Number(req.params.id);
  const thread = chatAgent._getThread(id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const { title, agent_kind, model } = req.body || {};
  if (title != null && (typeof title !== 'string' || title.length > 200)) return res.status(400).json({ error: 'title must be a string ≤ 200 chars' });
  chatAgent._updateThread(id, req.user.id, { title, agent_kind, model });
  res.json({ ok: true });
});

// DELETE /api/chat/threads/:id
router.delete('/threads/:id', (req, res) => {
  const id = Number(req.params.id);
  chatAgent._deleteThread(id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
```

- [ ] **Step 5.2: Mount the route in `server/index.js`**

Find the cluster of `app.use('/api/...', ...)` lines (around line 95). Just after `app.use('/api/import', importRoutes);`, add:

```js
const chatRoutes = require('./routes/chat');
app.use('/api/chat', chatRoutes);
```

- [ ] **Step 5.3: Manually verify CRUD works**

```bash
NODE_ENV=development npm start > /tmp/fin-dashboard.log 2>&1 &
sleep 2
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@local","password":"ChangeMe!Local1"}' | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).token)')
echo "Token: $TOKEN"
curl -s -X POST http://localhost:3001/api/chat/threads -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' | tee /tmp/created
TID=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync("/tmp/created")).id))')
curl -s http://localhost:3001/api/chat/threads -H "Authorization: Bearer $TOKEN"
curl -s -X PATCH http://localhost:3001/api/chat/threads/$TID -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"title":"Renamed"}'
curl -s -X DELETE http://localhost:3001/api/chat/threads/$TID -H "Authorization: Bearer $TOKEN"
kill %1
```

Expected: each call returns 200/201, the list call shows the thread, and DELETE returns `{"ok":true}`.

- [ ] **Step 5.4: Commit**

```bash
git add server/routes/chat.js server/index.js
git commit -m "feat(chat): /api/chat/threads CRUD endpoints"
```

---

## Task 6: SSE stream endpoint + confirm endpoint

**Files:**
- Modify: `server/routes/chat.js` — add `/threads/:id/stream` and `/threads/:id/confirm`

- [ ] **Step 6.1: Add the SSE stream endpoint**

Append to `routes/chat.js`, before `module.exports = router;`:

```js
// SSE: POST /api/chat/threads/:id/stream
router.post('/threads/:id/stream', async (req, res) => {
  const id = Number(req.params.id);
  const thread = chatAgent._getThread(id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const { content } = req.body || {};
  if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  if (!chatAgent.isAgentConfigured()) return res.status(503).json({ error: 'Agent is not configured on the server' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const emit = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await chatAgent.streamMessage({ threadId: id, userId: req.user.id, content }, emit);
  } catch (e) {
    emit('error', { message: e.message });
  } finally {
    res.end();
  }
});
```

- [ ] **Step 6.2: Add the confirm endpoint**

Append before `module.exports = router;`:

```js
// POST /api/chat/threads/:id/confirm
// Body: { tool_use_id, message_id, decision: 'confirm'|'reject', mutation? }
// The mutation object was emitted in the original 'proposal' SSE event
// and is sent back here on confirm so the client doesn't need to remember
// its own tool_use_id ↔ mutation map. We re-validate by checking the
// stored assistant message has a matching tool_use_id.
router.post('/threads/:id/confirm', async (req, res) => {
  const id = Number(req.params.id);
  const thread = chatAgent._getThread(id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  const { tool_use_id, message_id, decision, mutation } = req.body || {};
  if (!tool_use_id || !message_id || !['confirm', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'tool_use_id, message_id, decision required' });
  }

  // Validate the message belongs to this thread, is the right id, and has
  // the matching tool_use_id pending.
  const msgs = chatAgent._listMessages(id);
  const asst = msgs.find(m => m.id === Number(message_id));
  if (!asst || asst.role !== 'assistant') return res.status(404).json({ error: 'Assistant message not found' });
  if (asst.status === 'final') return res.json({ ok: true, applied: false, error: 'Already resolved' });
  const tu = asst.tool_uses ? JSON.parse(asst.tool_uses) : [];
  if (!tu.some(u => u.id === tool_use_id)) return res.status(400).json({ error: 'tool_use_id not on this message' });

  if (decision === 'reject') {
    chatAgent.recordToolResult({ threadId: id, userId: req.user.id, message_id: Number(message_id),
      tool_use_id, result: { rejected: true }, is_error: false });
    return res.json({ ok: true, applied: false });
  }

  // Confirm path: dispatch the stored mutation by invoking the matching
  // route handler in-process. We use a small request-scoped fetch against
  // our own server (auth header reused from this request) for simplicity
  // and to keep route logic the single source of truth.
  if (!mutation || !mutation.method || !mutation.path) return res.status(400).json({ error: 'mutation missing on confirm' });
  let result, isError = false;
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}${mutation.path}`, {
      method: mutation.method,
      headers: { 'Content-Type': 'application/json', 'Authorization': req.headers.authorization || '' },
      body: mutation.body ? JSON.stringify(mutation.body) : undefined
    });
    result = await r.json().catch(() => ({}));
    if (!r.ok) { isError = true; result = { error: result.error || `HTTP ${r.status}` }; }
  } catch (e) {
    isError = true; result = { error: e.message };
  }

  chatAgent.recordToolResult({ threadId: id, userId: req.user.id, message_id: Number(message_id),
    tool_use_id, result, is_error: isError });
  res.json({ ok: true, applied: !isError, error: isError ? result.error : undefined });
});
```

- [ ] **Step 6.3: Manually verify the stream endpoint emits SSE**

```bash
NODE_ENV=development npm start > /tmp/fin-dashboard.log 2>&1 &
sleep 2
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@local","password":"ChangeMe!Local1"}' | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0)).token)')
TID=$(curl -s -X POST http://localhost:3001/api/chat/threads -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0)).id))')
curl -N -s -X POST "http://localhost:3001/api/chat/threads/$TID/stream" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"content":"Say hi"}' | head -20
kill %1
```

Expected (with API key): `event: thread_meta`, `event: assistant_start`, several `event: text`, `event: done` lines visible. Without API key, expect `503` JSON error.

- [ ] **Step 6.4: Commit**

```bash
git add server/routes/chat.js
git commit -m "feat(chat): SSE stream endpoint + confirm endpoint"
```

---

## Task 7: Frontend page scaffolding (HTML + CSS) and nav tab wiring

**Files:**
- Modify: `public/index.html`

The page lives inside `.main-content` next to the others. The nav tabs are added to both the desktop topnav and the mobile menu so navigation matches the existing pattern. CSS uses the existing design tokens (`--bg-secondary`, `--caramel`, `--text-primary`, etc.) — no new colour decisions.

- [ ] **Step 7.1: Add the nav tab buttons**

In the `.topnav-tabs` block (search for `<button class="nav-tab" onclick="navigateTo('vault')">`), add **after** the Vault button (and before the closing `</div>` of `.topnav-tabs`):

```html
      <button class="nav-tab" onclick="navigateTo('agent')">&#x1F916; Agent</button>
```

In the mobile menu block (search for `navigateTo('vault');closeMobileMenu()`), add **after** the Vault entry:

```html
      <button class="nav-tab" style="width:100%;text-align:left;display:block" onclick="navigateTo('agent');closeMobileMenu()">&#x1F916; Agent</button>
```

- [ ] **Step 7.2: Add the page HTML inside `.main-content`**

Find the `<!-- VAULT PAGE -->` block; immediately after the `</div>` that closes `#page-vault`, add:

```html
    <!-- AGENT PAGE -->
    <div class="page" id="page-agent">
      <div class="agent-shell">
        <aside class="agent-sidebar">
          <button class="agent-new-btn" onclick="agentNewThread()">+ New Chat</button>
          <div class="agent-thread-list" id="agentThreadList"></div>
        </aside>
        <section class="agent-main">
          <div class="agent-header">
            <div class="agent-selectors">
              <label>Agent
                <select id="agentKindSelect" onchange="agentOnKindChange()">
                  <option value="financial_advisor">&#x1F4B0; Financial Advisor</option>
                </select>
              </label>
              <label>Model
                <select id="agentModelSelect" onchange="agentOnModelChange()">
                  <option value="claude-haiku-4-5">Claude Haiku 4.5</option>
                  <option value="claude-sonnet-4-5">Claude Sonnet 4.5</option>
                  <option value="claude-opus-4-5">Claude Opus 4.5</option>
                </select>
              </label>
            </div>
            <div class="agent-thread-title" id="agentThreadTitle"></div>
          </div>
          <div class="agent-messages" id="agentMessages"></div>
          <form class="agent-input-row" id="agentInputForm" onsubmit="agentOnSend(event)">
            <textarea id="agentInput" rows="2" placeholder="Type your message... (⌘/Ctrl+Enter to send)" onkeydown="agentOnKeyDown(event)"></textarea>
            <button type="submit" id="agentSendBtn">Send</button>
          </form>
          <div class="agent-pending-hint" id="agentPendingHint" style="display:none">
            Confirm or reject the proposal above to continue.
          </div>
        </section>
      </div>
    </div>
```

- [ ] **Step 7.3: Add the CSS, near the other `.demo-banner`/`.page` rules**

Find the `.demo-banner` CSS rule (added in PR #17). Append just below it:

```css
.agent-shell{display:grid;grid-template-columns:260px 1fr;gap:0;height:calc(100vh - 180px);min-height:520px;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--bg-primary)}
.agent-sidebar{border-right:1px solid var(--border);background:var(--bg-secondary);display:flex;flex-direction:column}
.agent-new-btn{margin:14px;padding:10px 12px;background:var(--caramel);color:var(--cream);border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px}
.agent-new-btn:hover{filter:brightness(1.05)}
.agent-thread-list{flex:1;overflow-y:auto;padding:0 8px 14px}
.agent-thread{padding:10px 12px;margin-bottom:4px;border-radius:8px;cursor:pointer;font-size:13px;color:var(--text-primary);border:1px solid transparent;display:flex;align-items:center;justify-content:space-between;gap:8px}
.agent-thread:hover{background:rgba(198,134,66,.08)}
.agent-thread.active{background:rgba(198,134,66,.18);border-color:rgba(198,134,66,.35)}
.agent-thread .title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent-thread .menu{opacity:0;font-size:14px;color:var(--text-secondary);padding:0 4px;border-radius:4px}
.agent-thread:hover .menu{opacity:1}
.agent-thread .menu:hover{background:rgba(0,0,0,.06)}
.agent-empty-list{padding:20px;color:var(--text-secondary);font-size:12px;text-align:center}
.agent-main{display:flex;flex-direction:column;min-width:0}
.agent-header{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.agent-selectors{display:flex;gap:14px;flex-wrap:wrap}
.agent-selectors label{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary)}
.agent-selectors select{background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);padding:5px 8px;border-radius:6px;font-size:12px}
.agent-thread-title{font-size:13px;color:var(--text-secondary);font-weight:600;max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent-messages{flex:1;overflow-y:auto;padding:18px 22px;display:flex;flex-direction:column;gap:14px}
.agent-msg{max-width:78%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.55;word-wrap:break-word;white-space:pre-wrap}
.agent-msg.user{align-self:flex-end;background:rgba(198,134,66,.12);border:1px solid rgba(198,134,66,.3);color:var(--text-primary)}
.agent-msg.assistant{align-self:flex-start;background:var(--bg-secondary);border:1px solid var(--border);color:var(--text-primary)}
.agent-msg .interrupted{color:var(--text-secondary);font-style:italic;font-size:12px;margin-top:6px}
.agent-tool-chip{align-self:flex-start;background:rgba(0,0,0,.03);border:1px dashed var(--border);color:var(--text-secondary);font-size:11px;padding:4px 10px;border-radius:14px;cursor:pointer}
.agent-tool-chip pre{display:none;white-space:pre-wrap;font-size:11px;margin-top:8px;background:rgba(0,0,0,.05);padding:8px;border-radius:6px;color:var(--text-primary)}
.agent-tool-chip.open pre{display:block}
.agent-proposal{align-self:flex-start;border:1px solid var(--caramel);background:rgba(198,134,66,.06);border-radius:12px;padding:12px 14px;max-width:78%;font-size:13px}
.agent-proposal .summary{font-weight:600;color:var(--text-primary);margin-bottom:8px}
.agent-proposal .actions{display:flex;gap:8px}
.agent-proposal button{padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid transparent}
.agent-proposal .confirm{background:var(--caramel);color:var(--cream)}
.agent-proposal .reject{background:transparent;color:var(--text-secondary);border-color:var(--border)}
.agent-proposal.applied{border-style:dashed;background:rgba(34,197,94,.08);border-color:rgba(34,197,94,.5);color:#15803d}
.agent-proposal.rejected{border-style:dashed;background:rgba(0,0,0,.03);color:var(--text-secondary)}
.agent-input-row{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border);background:var(--bg-primary)}
.agent-input-row textarea{flex:1;resize:none;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-family:inherit;font-size:13px;line-height:1.5}
.agent-input-row button{padding:0 18px;background:var(--caramel);color:var(--cream);border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:13px;min-width:84px}
.agent-input-row button:disabled{opacity:.5;cursor:not-allowed}
.agent-pending-hint{padding:8px 16px;background:rgba(198,134,66,.10);color:var(--caramel);font-size:12px;text-align:center;border-top:1px solid var(--border)}
.agent-empty-state{display:flex;align-items:center;justify-content:center;flex:1;color:var(--text-secondary);font-size:13px;text-align:center;padding:30px}
.agent-demo-block{display:flex;align-items:center;justify-content:center;flex:1;color:var(--text-secondary);font-size:13px;text-align:center;padding:30px}
@media (max-width: 768px){
  .agent-shell{grid-template-columns:1fr;height:calc(100vh - 220px)}
  .agent-sidebar{display:none}
  .agent-sidebar.open{display:flex;position:absolute;inset:0;z-index:50}
}
```

- [ ] **Step 7.4: Verify the page renders empty (without JS yet)**

Run the server, sign in, and click the new "Agent" nav tab. Expected: shell layout visible, "+ New Chat" button visible, empty list area, model/agent dropdowns visible, input box visible. Clicking the dropdowns or buttons does nothing yet (next task).

- [ ] **Step 7.5: Commit**

```bash
git add public/index.html
git commit -m "feat(agent-ui): page scaffolding (HTML + CSS) and nav tab buttons"
```

---

## Task 8: Frontend thread CRUD JS

**Files:**
- Modify: `public/index.html` — JS additions inside the script block that contains `apiPost` (around line 3278 in current main)

- [ ] **Step 8.1: Add the agent-page module just before `</script>` of script #2**

Find the line `</script>` that closes the second `<script>` block (the one starting around line 3152). Just **before** that closing tag, insert:

```js
// ─── AGENT CHAT PAGE ────────────────────────────────────────────────────────
var agentState = {
  threads: [],
  activeId: null,
  messages: [],          // current thread messages
  streaming: false,
  pendingProposal: null, // { tool_use_id, message_id, summary, mutation, name }
  evtSource: null
};

async function agentLoadThreads() {
  var r = await apiFetch('/api/chat/threads');
  agentState.threads = (r && r.threads) || [];
  agentRenderThreadList();
}

function agentRenderThreadList() {
  var el = document.getElementById('agentThreadList');
  if (!el) return;
  if (!agentState.threads.length) {
    el.innerHTML = '<div class="agent-empty-list">No chats yet — start one with + New Chat.</div>';
    return;
  }
  el.innerHTML = agentState.threads.map(function(t){
    var active = t.id === agentState.activeId ? ' active' : '';
    return '<div class="agent-thread'+active+'" onclick="agentOpenThread('+t.id+')">'
      + '<span class="title">'+esc(t.title || 'New chat')+'</span>'
      + '<span class="menu" onclick="event.stopPropagation();agentThreadMenu('+t.id+')">⋯</span>'
      + '</div>';
  }).join('');
}

async function agentNewThread() {
  var r = await apiPost('/api/chat/threads', {});
  if (!r || !r.id) return;
  await agentLoadThreads();
  await agentOpenThread(r.id);
}

async function agentOpenThread(id) {
  if (agentState.streaming) return;
  agentState.activeId = id;
  agentState.pendingProposal = null;
  agentRenderThreadList();
  var r = await apiFetch('/api/chat/threads/'+id);
  if (!r || !r.thread) { showToast('Thread not found','error'); return; }
  agentState.messages = r.messages || [];
  // Restore selectors and title
  document.getElementById('agentKindSelect').value = r.thread.agent_kind;
  document.getElementById('agentModelSelect').value = r.thread.model;
  document.getElementById('agentThreadTitle').textContent = r.thread.title || '';
  // Restore pending proposal if the last assistant message is still streaming
  var lastAsst = [...agentState.messages].reverse().find(function(m){return m.role==='assistant'});
  if (lastAsst && lastAsst.status === 'streaming') {
    var tu = lastAsst.tool_uses ? JSON.parse(lastAsst.tool_uses) : [];
    var p = tu.find(function(u){return u.name && u.name.indexOf('propose_')===0});
    if (p) {
      // We don't have the mutation in DB; rebuild via PATCH-on-confirm flow.
      // The mutation is rebuilt server-side from the stored input on confirm
      // (handled by the confirm endpoint via tools.buildProposal lookup).
      agentState.pendingProposal = { tool_use_id: p.id, message_id: lastAsst.id, name: p.name, input: p.input, summary: '(restored proposal)', mutation: null };
    }
  }
  agentRenderMessages();
  agentUpdateInputState();
}

async function agentThreadMenu(id) {
  var name = prompt('Rename thread (or leave blank to delete):', '');
  if (name === null) return;
  if (name.trim()) {
    await apiPut('/api/chat/threads/'+id, { title: name.trim() });
  } else {
    if (!confirm('Delete this chat?')) return;
    await apiDel('/api/chat/threads/'+id);
    if (agentState.activeId === id) {
      agentState.activeId = null; agentState.messages = [];
      document.getElementById('agentMessages').innerHTML = '';
      document.getElementById('agentThreadTitle').textContent = '';
    }
  }
  await agentLoadThreads();
}

async function agentOnKindChange() {
  if (!agentState.activeId) return;
  await apiPut('/api/chat/threads/'+agentState.activeId, { agent_kind: document.getElementById('agentKindSelect').value });
}
async function agentOnModelChange() {
  if (!agentState.activeId) return;
  await apiPut('/api/chat/threads/'+agentState.activeId, { model: document.getElementById('agentModelSelect').value });
}
```

Note: this depends on `apiFetch`, `apiPost`, `apiPut`, `apiDel`, `esc`, `showToast` — all already defined elsewhere in the file.

The bare-mutation case for restored proposals is acknowledged with `mutation: null`; we'll handle it in Task 10 by making the confirm endpoint accept a missing mutation and rebuild it server-side.

- [ ] **Step 8.2: Wire to navigateTo so opening the page loads threads**

In `navigateTo` (the consolidated single-impl from PR #17, search for `if (page==='vault')`), append a new `if` clause **before** the closing `}`:

```js
  if (page==='agent' && typeof agentLoadThreads === 'function') agentLoadThreads();
```

- [ ] **Step 8.3: Manual verify thread CRUD via UI**

Restart server, sign in, click Agent. Click "+ New Chat" repeatedly → entries appear in sidebar. Click ⋯ → rename works → delete works.

- [ ] **Step 8.4: Commit**

```bash
git add public/index.html
git commit -m "feat(agent-ui): thread CRUD wired up (list, new, rename, delete)"
```

---

## Task 9: Frontend message rendering + send + EventSource streaming

**Files:**
- Modify: `public/index.html` — extend the agent JS module from Task 8

- [ ] **Step 9.1: Add render + send functions**

Append to the agent JS block (still before the closing `</script>` of script #2):

```js
function agentRenderMessages() {
  var el = document.getElementById('agentMessages');
  if (!el) return;
  if (!agentState.messages.length) {
    el.innerHTML = '<div class="agent-empty-state">Send your first message to start the conversation.</div>';
    return;
  }
  el.innerHTML = agentState.messages.map(agentRenderOneMessage).join('');
  // Render pending proposal card after the last message if applicable
  if (agentState.pendingProposal) {
    el.insertAdjacentHTML('beforeend', agentRenderProposalCard(agentState.pendingProposal, 'pending'));
  }
  el.scrollTop = el.scrollHeight;
}

function agentRenderOneMessage(m) {
  if (m.role === 'user') {
    return '<div class="agent-msg user">'+esc(m.content || '')+'</div>';
  }
  if (m.role === 'tool') {
    var t; try { t = JSON.parse(m.content); } catch (_) { t = { name: '?' }; }
    var label = t.name === 'proposal_result'
      ? (t.result && t.result.rejected ? '✗ Rejected' : (t.is_error ? '✗ Failed: ' + (t.result && t.result.error || '') : '✓ Applied'))
      : '🛠 ' + (t.name || '');
    return '<div class="agent-tool-chip" onclick="this.classList.toggle(\'open\')">'
      + esc(label) + '<pre>' + esc(JSON.stringify(t.result, null, 2)) + '</pre></div>';
  }
  // assistant
  var html = '<div class="agent-msg assistant" data-msg-id="'+m.id+'">'+esc(m.content || '');
  if (m.status === 'streaming' && (!m.tool_uses || m.tool_uses === 'null')) {
    html += '<div class="interrupted">(interrupted — send a new message to continue)</div>';
  }
  html += '</div>';
  return html;
}

function agentRenderProposalCard(p, state) {
  var cls = state === 'applied' ? ' applied' : state === 'rejected' ? ' rejected' : '';
  var actions = state === 'pending'
    ? '<div class="actions"><button class="confirm" onclick="agentConfirmProposal()">Confirm</button>'
      + '<button class="reject" onclick="agentRejectProposal()">Reject</button></div>'
    : '<div class="actions"><span>'+(state === 'applied' ? '✓ Done' : '✗ Rejected')+'</span></div>';
  return '<div class="agent-proposal'+cls+'" data-tool-use-id="'+esc(p.tool_use_id)+'">'
    + '<div class="summary">🛠 '+esc(p.summary)+'</div>' + actions + '</div>';
}

function agentUpdateInputState() {
  var btn = document.getElementById('agentSendBtn');
  var input = document.getElementById('agentInput');
  var hint = document.getElementById('agentPendingHint');
  var blocked = agentState.streaming || !!agentState.pendingProposal || !agentState.activeId;
  input.disabled = blocked;
  btn.disabled = blocked;
  if (agentState.streaming) btn.textContent = 'Stop';
  else btn.textContent = 'Send';
  hint.style.display = agentState.pendingProposal ? '' : 'none';
}

function agentOnKeyDown(e) {
  // ⌘/Ctrl+Enter to send; plain Enter inserts newline.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    agentOnSend(e);
  }
}

async function agentOnSend(e) {
  e.preventDefault();
  if (agentState.streaming) { agentStopStream(); return; }
  if (!agentState.activeId) {
    // Auto-create a thread on first send
    var r = await apiPost('/api/chat/threads', {});
    if (!r || !r.id) return;
    agentState.activeId = r.id;
    await agentLoadThreads();
  }
  var input = document.getElementById('agentInput');
  var content = input.value.trim();
  if (!content) return;
  input.value = '';

  // Optimistically append the user message
  agentState.messages.push({ id: 'tmp_user_'+Date.now(), role: 'user', content: content, status: 'final' });
  agentState.streaming = true;
  agentUpdateInputState();
  agentRenderMessages();

  await agentRunStream(content);
}

async function agentRunStream(content) {
  var token = localStorage.getItem('fin_token');
  var url = '/api/chat/threads/'+agentState.activeId+'/stream';
  // EventSource doesn't support POST or custom headers, so we use fetch + ReadableStream parsing.
  try {
    var resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer '+token },
      body: JSON.stringify({ content: content })
    });
    if (!resp.ok) {
      var err = await resp.json().catch(function(){return{};});
      showToast(err.error || ('HTTP '+resp.status), 'error');
      agentState.streaming = false; agentUpdateInputState(); return;
    }
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var assistantMsg = null;

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var events = buffer.split('\n\n');
      buffer = events.pop(); // last partial
      for (var i = 0; i < events.length; i++) {
        var lines = events[i].split('\n');
        var name = '', dataStr = '';
        for (var j = 0; j < lines.length; j++) {
          if (lines[j].indexOf('event:') === 0) name = lines[j].slice(6).trim();
          else if (lines[j].indexOf('data:')  === 0) dataStr += lines[j].slice(5).trim();
        }
        if (!name) continue;
        var data; try { data = JSON.parse(dataStr); } catch (_) { data = {}; }
        if (name === 'thread_meta') {
          // Replace the tmp_user_* id with the real one
          var lastUser = [...agentState.messages].reverse().find(function(m){return m.role==='user'});
          if (lastUser) lastUser.id = data.user_message_id;
        } else if (name === 'assistant_start') {
          assistantMsg = { id: data.message_id, role: 'assistant', content: '', tool_uses: null, status: 'streaming' };
          agentState.messages.push(assistantMsg);
          agentRenderMessages();
        } else if (name === 'text') {
          if (assistantMsg) { assistantMsg.content += data.delta; agentRenderMessages(); }
        } else if (name === 'tool_use') {
          // Insert a tool chip immediately so the user sees what was called
          agentState.messages.push({ id: 'tmp_tu_'+data.id, role: 'tool', content: JSON.stringify({ tool_use_id: data.id, name: data.name, result: { running: true }, is_error: false }), status: 'final' });
          agentRenderMessages();
        } else if (name === 'tool_result') {
          // Replace the running chip with the actual result
          var idx = agentState.messages.findIndex(function(m){
            if (m.role !== 'tool') return false;
            try { return JSON.parse(m.content).tool_use_id === data.tool_use_id; } catch(_) { return false; }
          });
          if (idx >= 0) {
            try {
              var prev = JSON.parse(agentState.messages[idx].content);
              agentState.messages[idx].content = JSON.stringify({ tool_use_id: prev.tool_use_id, name: prev.name, result: data.result, is_error: data.status === 'error' });
            } catch(_){}
          }
          // Reset assistantMsg so next text deltas open a new bubble (the model
          // will continue its turn after the read tools).
          assistantMsg = null;
          agentRenderMessages();
        } else if (name === 'proposal') {
          agentState.pendingProposal = data;
          agentRenderMessages();
        } else if (name === 'done') {
          if (assistantMsg) assistantMsg.status = 'final';
          agentState.streaming = false;
          agentUpdateInputState();
        } else if (name === 'error') {
          showToast(data.message || 'Stream error', 'error');
          agentState.streaming = false;
          agentUpdateInputState();
        }
      }
    }
  } catch (err) {
    showToast('Network error: '+err.message, 'error');
  } finally {
    agentState.streaming = false;
    agentUpdateInputState();
    agentLoadThreads();  // refresh sidebar (updated_at, possibly new title)
  }
}

function agentStopStream() {
  // Best-effort abort. We don't keep the AbortController in scope here for
  // simplicity; closing the tab/page also terminates the read loop.
  agentState.streaming = false;
  agentUpdateInputState();
}
```

- [ ] **Step 9.2: Manual verify a non-tool turn**

Restart server. Sign in (real account, ANTHROPIC_API_KEY in env). Open Agent. Click "+ New Chat". Type "Say hi in 5 words.", ⌘+Enter. Expected: text streams in token-by-token, sidebar updates with new title, no error toast.

- [ ] **Step 9.3: Manual verify a read-tool turn**

Type: "What is my net worth?". Expected: a `🛠 get_net_worth` chip appears, then the assistant continues with a number. Click the chip → result JSON expands.

- [ ] **Step 9.4: Commit**

```bash
git add public/index.html
git commit -m "feat(agent-ui): SSE streaming with text deltas + tool chips"
```

---

## Task 10: Frontend proposal cards + confirm flow

**Files:**
- Modify: `public/index.html` — add `agentConfirmProposal` and `agentRejectProposal`

- [ ] **Step 10.1: Add the confirm/reject handlers**

Append to the agent JS block:

```js
async function agentConfirmProposal() {
  if (!agentState.pendingProposal) return;
  var p = agentState.pendingProposal;
  // Optimistic UI
  var card = document.querySelector('.agent-proposal');
  if (card) { card.classList.add('applied'); card.querySelector('.actions').innerHTML = '<span>✓ Working...</span>'; }

  var r = await apiPost('/api/chat/threads/'+agentState.activeId+'/confirm', {
    tool_use_id: p.tool_use_id,
    message_id:  p.message_id,
    decision:    'confirm',
    mutation:    p.mutation
  });
  if (!r || (r.applied === false && r.error)) {
    showToast((r && r.error) || 'Confirmation failed', 'error');
    if (card) { card.classList.remove('applied'); card.classList.add('rejected'); card.querySelector('.actions').innerHTML = '<span>✗ Failed</span>'; }
  }
  agentState.pendingProposal = null;
  // Re-fetch the thread to pick up the new tool message
  if (agentState.activeId) {
    var t = await apiFetch('/api/chat/threads/'+agentState.activeId);
    if (t && t.messages) { agentState.messages = t.messages; agentRenderMessages(); }
  }
  agentUpdateInputState();
}

async function agentRejectProposal() {
  if (!agentState.pendingProposal) return;
  var p = agentState.pendingProposal;
  var card = document.querySelector('.agent-proposal');
  if (card) { card.classList.add('rejected'); card.querySelector('.actions').innerHTML = '<span>✗ Rejected</span>'; }

  await apiPost('/api/chat/threads/'+agentState.activeId+'/confirm', {
    tool_use_id: p.tool_use_id,
    message_id:  p.message_id,
    decision:    'reject'
  });
  agentState.pendingProposal = null;
  if (agentState.activeId) {
    var t = await apiFetch('/api/chat/threads/'+agentState.activeId);
    if (t && t.messages) { agentState.messages = t.messages; agentRenderMessages(); }
  }
  agentUpdateInputState();
}
```

- [ ] **Step 10.2: Allow `/confirm` to rebuild a missing mutation server-side**

In `server/routes/chat.js`, update the confirm handler — replace the line:
```js
  if (!mutation || !mutation.method || !mutation.path) return res.status(400).json({ error: 'mutation missing on confirm' });
```
with:
```js
  // Rebuild the mutation from the stored proposal input if the client
  // lost it (e.g., after a reload restored a pending-proposal thread).
  var effMutation = mutation;
  if (!effMutation || !effMutation.method || !effMutation.path) {
    var tools = require('../services/chatTools');
    var stored = tu.find(function(u){ return u.id === tool_use_id; });
    if (!stored) return res.status(400).json({ error: 'mutation missing and tool_use not found' });
    try {
      var rebuilt = tools.buildProposal(stored.name, stored.input, { userId: req.user.id });
      effMutation = rebuilt.mutation;
    } catch (e) { return res.status(400).json({ error: 'Could not rebuild mutation: ' + e.message }); }
  }
```
And in the `fetch(...)` call below, replace `mutation.method`, `mutation.path`, and `mutation.body` with `effMutation.method`, `effMutation.path`, `effMutation.body`.

- [ ] **Step 10.3: Manual verify a propose round-trip**

In Agent: "Mark hand loan #1 as settled." Expect a proposal card under the assistant message with Confirm/Reject. Click Reject → card → "✗ Rejected", a tool chip "✗ Rejected" inserted, input re-enabled. Send again: "Yes please mark loan #1 settled." Click Confirm → card → "✓ Done", the loan row's status is now `settled` in the DB (verify via `sqlite3 server/db/data.db "SELECT id, status FROM hand_loans WHERE id=1"`).

- [ ] **Step 10.4: Commit**

```bash
git add public/index.html server/routes/chat.js
git commit -m "feat(agent-ui): proposal cards with confirm/reject flow"
```

---

## Task 11: Demo-mode guard + final polish

**Files:**
- Modify: `public/index.html`

- [ ] **Step 11.1: Replace the page contents in demo mode**

In the `navigateTo` patch from Task 8, replace:
```js
  if (page==='agent' && typeof agentLoadThreads === 'function') agentLoadThreads();
```
with:
```js
  if (page==='agent') {
    var demo = typeof isDemoMode === 'function' && isDemoMode();
    var shell = document.querySelector('#page-agent .agent-shell');
    if (demo && shell) {
      shell.innerHTML = '<div class="agent-demo-block">Sign in with a real account to use the agent — demo mode can\'t reach the LLM.</div>';
    } else if (typeof agentLoadThreads === 'function') {
      agentLoadThreads();
    }
  }
```

- [ ] **Step 11.2: Manual verify demo mode**

Log out. Log in with `demo123` (4-char password fallback). Click Agent → expect the centered "Sign in with a real account..." message, no sidebar/input visible.

- [ ] **Step 11.3: Commit**

```bash
git add public/index.html
git commit -m "feat(agent-ui): demo-mode guard on agent page"
```

---

## Task 12: End-to-end smoke + verification

**Files:**
- None to create. Run the existing smoke harness and a manual test pass.

- [ ] **Step 12.1: Run unit-style smoke**

```bash
node scripts/test-chat.js
```

Expected: all tool tests PASS. With `ANTHROPIC_API_KEY` set: chatAgent tests + streaming tests PASS. Without: SKIP for those.

- [ ] **Step 12.2: Manual e2e checklist**

Restart the server with a real `ANTHROPIC_API_KEY`. Sign in with a real account. For each row, mark the result:

- [ ] Open Agent — sidebar visible, model + agent dropdowns visible
- [ ] "+ New Chat" creates a thread, shows in sidebar
- [ ] Type "What is my net worth?" → text streams in, get_net_worth chip visible, expanded chip shows JSON, response uses real numbers
- [ ] Type "Switch to Sonnet" then change Model dropdown → next message uses claude-sonnet-4-5 (verify in agent_calls.model)
- [ ] Type "Mark hand loan #1 as partial" → proposal card appears, input disabled, hint visible
- [ ] Click Confirm → card → ✓ Done, hand_loans.status = 'partial' in DB
- [ ] Type "Now mark it settled" → propose again, click Reject → card → ✗ Rejected, hand_loans.status unchanged
- [ ] Reload the page mid-stream (kill server during a long response, bring it back, refresh) → assistant bubble shows "(interrupted — send a new message to continue)"
- [ ] Sign out → Sign in with a 4-char demo password → Agent page shows "Sign in with a real account..." message
- [ ] Sign back in real → all threads still in sidebar

- [ ] **Step 12.3: Final commit (if any cleanup needed)**

```bash
# only if you fixed something during e2e
git status
git add -A && git commit -m "fix(agent-ui): <whatever fell out of e2e>"
```

---

## Out of scope (future iterations)

- Edits/deletes of existing financial records via proposal.
- "Regenerate response" button.
- LLM-summarized thread titles (currently just truncates the first message).
- Per-user daily token cap.
- Stop-mid-stream that aborts the server-side fetch (currently a soft stop on the client).
- Mobile drawer toggle button (sidebar is hidden ≤768px; needs a hamburger to reopen).
