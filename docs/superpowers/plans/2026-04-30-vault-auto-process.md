# Vault Auto-Process Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user uploads a PDF or CSV to the vault, extract its contents and queue write proposals (add stock / MF / earning / payment / advance-tax) into the user's "📥 Pending uploads" thread on the agent page. User confirms each in the existing proposal UI.

**Architecture:** Background fire-and-forget processor in `server/services/vaultProcessor.js`, kicked off via `setImmediate()` from `routes/vault.js`'s `/confirm-upload` after the DB row is inserted. Reuses `chatAgent.streamMessage()` with `agent_kind='upload_processor'` and a no-op emit callback (the proposals persist to the thread automatically). Per-user serial queue prevents concurrent Anthropic calls during rapid uploads.

**Tech Stack:** Express, better-sqlite3, `@anthropic-ai/sdk`, `@aws-sdk/client-s3`, `pdf-parse` (new dep), vanilla JS frontend. No bundler, no test framework — verification via `node scripts/<name>.js` smoke harnesses.

**Spec:** `docs/superpowers/specs/2026-04-30-vault-auto-process-design.md`

**Depends on:** PR #19 (`feat/agent-chat`). All chatAgent + chatTools + agent page references in this plan assume that branch is merged or stacked underneath.

---

## File map

**Create:**
- `server/services/vaultProcessor.js` — orchestrator (queue + processUpload)
- `server/services/textExtract.js` — PDF/CSV text extraction
- `scripts/test-vault-processor.js` — smoke harness

**Modify:**
- `package.json` — add `pdf-parse` dependency
- `server/services/s3.js` — add `getObjectBuffer(bucket, key)` helper
- `server/db/database.js` — add `processed_at`, `processing_error` columns on `vault_files`
- `server/routes/vault.js` — call processor at the end of `/confirm-upload`
- `server/services/chatAgent.js` — new system-prompt branch for `upload_processor`
- `server/services/chatTools.js` — add `propose_add_stock` + `propose_add_mutual_fund`
- `public/index.html` — pin "📥 Pending uploads" thread, unresolved badge, upload toast hook

---

## Task 1: Add `pdf-parse` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1.1: Install pdf-parse**

```bash
npm install --save pdf-parse@1.1.1
```

- [ ] **Step 1.2: Verify install**

```bash
node -e "console.log(require('pdf-parse').name || 'pdf-parse loaded')"
```
Expected: prints something like `pdf-parse loaded` or the function name. If `npm install` fails because of native build issues on local Node 25, that's environmental — pdf-parse itself is pure JS so the failure must be in another dep; retry installing only this package: `npm install --save --no-optional pdf-parse@1.1.1`.

- [ ] **Step 1.3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add pdf-parse for vault auto-processing"
```

---

## Task 2: Add S3 buffer-download helper

**Files:**
- Modify: `server/services/s3.js`

The vault route currently uses presigned URLs to let the browser download files. The processor runs server-side, so we need a direct buffer download. Add a small helper next to `getDownloadPresignedUrl`.

- [ ] **Step 2.1: Add `getObjectBuffer` to s3.js**

Find the existing `getDownloadPresignedUrl` function. Just AFTER it, append:

```js
/**
 * Download an object from S3 as a Node Buffer. Used by server-side
 * processors (e.g., vault auto-process) that need the raw bytes rather
 * than a presigned URL.
 */
async function getObjectBuffer(bucket, key) {
  const client = getS3Client();
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  const out = await client.send(cmd);
  // out.Body is a Readable stream in Node; collect to Buffer.
  const chunks = [];
  for await (const chunk of out.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}
```

- [ ] **Step 2.2: Export it**

In the `module.exports = { ... }` block at the bottom, add `getObjectBuffer` to the list:

```js
module.exports = {
  getS3Client,
  isS3Configured,
  ensureBucketExists,
  getUploadPresignedUrl,
  getDownloadPresignedUrl,
  getObjectBuffer,
  listFiles,
  deleteFile,
  getFYFolder,
  getCategoryPath
};
```

- [ ] **Step 2.3: Syntax check**

```bash
node --check server/services/s3.js
```
Expected: no output (clean syntax).

- [ ] **Step 2.4: Commit**

```bash
git add server/services/s3.js
git commit -m "feat(s3): add getObjectBuffer for server-side downloads"
```

---

## Task 3: DB columns for idempotency

**Files:**
- Modify: `server/db/database.js`

The schema uses `addColumnIfMissing` (search for that function). It maintains a numbered list of migrations. Find the migration list (around line 460) and append two new entries.

- [ ] **Step 3.1: Find the migration list**

```bash
grep -n "addColumnIfMissing\|migrations.*=\|MIGRATIONS\|\\bid:" server/db/database.js | head -20
```
Note the highest existing `id:` number in the migrations list — call it N.

- [ ] **Step 3.2: Append two migrations**

In the migrations list, after the last entry, append:

```js
    { id: N+1, name: 'vault_files.processed_at',     run: () => addColumnIfMissing('vault_files', 'processed_at',     'ALTER TABLE vault_files ADD COLUMN processed_at DATETIME') },
    { id: N+2, name: 'vault_files.processing_error', run: () => addColumnIfMissing('vault_files', 'processing_error', 'ALTER TABLE vault_files ADD COLUMN processing_error TEXT') },
```

Replace `N+1` and `N+2` with the actual next two numbers.

- [ ] **Step 3.3: Restart server, verify columns exist**

If `better-sqlite3` is not installed locally (Node version mismatch), skip the runtime verification — the production deploy will run the migrations on start. Code inspection is sufficient.

If you can run locally:
```bash
NODE_ENV=development npm start > /tmp/fin-dashboard.log 2>&1 &
sleep 2
sqlite3 server/db/data.db "PRAGMA table_info(vault_files);" | grep -E "processed_at|processing_error"
kill %1
```
Expected: two rows showing the new columns.

- [ ] **Step 3.4: Commit**

```bash
git add server/db/database.js
git commit -m "feat(db): vault_files.processed_at + processing_error columns"
```

---

## Task 4: Text extraction helper

**Files:**
- Create: `server/services/textExtract.js`
- Create: `scripts/test-text-extract.js`

The text extractor is a pure function (input: buffer + mime type + filename, output: `{text, kind, warnings}`) so it can be unit-smoke-tested without S3, the DB, or Anthropic.

- [ ] **Step 4.1: Write the failing smoke test**

Create `scripts/test-text-extract.js`:

```js
// Smoke test for server/services/textExtract.js
//   node scripts/test-text-extract.js
const fs = require('fs');
const extract = require('../server/services/textExtract');

function eq(label, actual, predicate) {
  const ok = predicate(actual);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log('  got:', JSON.stringify(actual).slice(0, 200)); process.exitCode = 1; }
}

(async () => {
  // Plain text passthrough
  const r1 = await extract.extractText(Buffer.from('hello world\nline two'), 'text/plain', 'note.txt');
  eq('plain text passthrough', r1, r => r.kind === 'text' && r.text === 'hello world\nline two');

  // CSV is treated as text
  const csv = 'Symbol,Quantity\nRELIANCE,10\nINFY,25';
  const r2 = await extract.extractText(Buffer.from(csv), 'text/csv', 'holdings.csv');
  eq('csv extraction returns text', r2, r => r.kind === 'csv' && r.text.includes('RELIANCE'));

  // Truncation
  const big = 'x'.repeat(50000);
  const r3 = await extract.extractText(Buffer.from(big), 'text/plain', 'big.txt');
  eq('truncation to 30000 chars', r3, r => r.text.length <= 30000 && r.warnings.some(w => /truncat/i.test(w)));

  // Unknown mime returns kind='unknown'
  const r4 = await extract.extractText(Buffer.from([0xff, 0xfe]), 'application/octet-stream', 'binary.bin');
  eq('unknown mime returns kind=unknown', r4, r => r.kind === 'unknown' && r.text === '');

  console.log('Done.');
})();
```

- [ ] **Step 4.2: Run, confirm failure**

```bash
node scripts/test-text-extract.js
```
Expected: `Cannot find module '../server/services/textExtract'`.

- [ ] **Step 4.3: Implement `textExtract.js`**

Create `server/services/textExtract.js`:

```js
// Text extraction for vault files. Returns { text, kind, warnings } where:
//   - text: extracted plain text (truncated to MAX_CHARS)
//   - kind: 'pdf' | 'csv' | 'text' | 'unknown'
//   - warnings: array of strings (e.g., truncation, parse errors)
const MAX_CHARS = 30000;

async function extractText(buffer, mimeType, filename) {
  const warnings = [];
  const lcName = String(filename || '').toLowerCase();
  const lcMime = String(mimeType || '').toLowerCase();

  // Detect kind by mime first, then filename extension as fallback.
  let kind = 'unknown';
  if (lcMime.includes('pdf') || lcName.endsWith('.pdf')) kind = 'pdf';
  else if (lcMime.includes('csv') || lcName.endsWith('.csv') || lcName.endsWith('.tsv')) kind = 'csv';
  else if (lcMime.startsWith('text/') || lcName.endsWith('.txt')) kind = 'text';

  let text = '';
  if (kind === 'pdf') {
    try {
      const pdfParse = require('pdf-parse');
      const result = await pdfParse(buffer);
      text = String(result.text || '');
    } catch (e) {
      warnings.push(`PDF parse failed: ${e.message}`);
      text = '';
    }
  } else if (kind === 'csv' || kind === 'text') {
    text = buffer.toString('utf8');
  } else {
    return { text: '', kind: 'unknown', warnings: ['Unsupported mime type: ' + (mimeType || '?')] };
  }

  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    warnings.push(`Text truncated to ${MAX_CHARS} chars`);
  }

  return { text, kind, warnings };
}

module.exports = { extractText, MAX_CHARS };
```

- [ ] **Step 4.4: Run smoke test, confirm 4 PASS**

```bash
node scripts/test-text-extract.js
```
Expected: 4 PASS lines, then `Done.`

If `pdf-parse` is missing (Task 1 didn't run or failed), the truncation/csv/text/unknown cases still pass — only the PDF case in later tasks would be affected. That's fine for v1.

- [ ] **Step 4.5: Commit**

```bash
git add server/services/textExtract.js scripts/test-text-extract.js
git commit -m "feat(vault): textExtract helper for PDF/CSV/text"
```

---

## Task 5: Add propose_add_stock + propose_add_mutual_fund tools

**Files:**
- Modify: `server/services/chatTools.js`

The existing chatTools module exports `TOOLS`, `TOOL_KIND`, `runReadTool`, `buildProposal`. We're adding two more `propose_*` tools so the upload processor (and the chat agent) can suggest adding stocks and mutual funds.

- [ ] **Step 5.1: Add the two propose builders**

In `server/services/chatTools.js`, find the `PROPOSE` object (it has `propose_mark_handloan_status`, `propose_add_earning`, `propose_add_payment`, `propose_record_advance_tax`). Add two new properties **inside** that object, after `propose_record_advance_tax`:

```js
  propose_add_stock(input, _ctx) {
    const { symbol, company_name, quantity, avg_buy_price, notes } = input || {};
    if (!symbol || !quantity) throw new Error('symbol and quantity required');
    return {
      summary: `Add stock: ${String(symbol).toUpperCase()}` +
               (company_name ? ` (${company_name})` : '') +
               ` — ${quantity} shares` +
               (avg_buy_price ? ` @ ₹${Number(avg_buy_price).toLocaleString('en-IN')}` : ''),
      mutation: { method: 'POST', path: '/api/investments/stocks', body: {
        symbol: String(symbol).toUpperCase(),
        company_name: company_name || symbol,
        quantity: Number(quantity),
        avg_buy_price: Number(avg_buy_price) || 0,
        notes: notes || null
      }}
    };
  },

  propose_add_mutual_fund(input, _ctx) {
    const { fund_name, units, avg_nav, fund_type, notes } = input || {};
    if (!fund_name || !units) throw new Error('fund_name and units required');
    return {
      summary: `Add MF: ${fund_name} — ${units} units` +
               (avg_nav ? ` @ ₹${Number(avg_nav).toLocaleString('en-IN')}` : '') +
               (fund_type ? ` (${fund_type})` : ''),
      mutation: { method: 'POST', path: '/api/investments/mutual-funds', body: {
        fund_name,
        units: Number(units),
        avg_nav: Number(avg_nav) || 0,
        fund_type: fund_type || 'Equity',
        notes: notes || null
      }}
    };
  },
```

- [ ] **Step 5.2: Add the matching tool specs to the TOOLS array**

In the same file, find the `TOOLS = [ ... ]` array. Inside it, after the existing `propose_record_advance_tax` spec, append:

```js
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
        fund_type: { type: 'string', enum: ['Equity', 'Debt', 'Hybrid', 'ELSS', 'Index', 'Other'] },
        notes:     { type: 'string' }
      }, additionalProperties: false } }
```

- [ ] **Step 5.3: Smoke test**

Append to `scripts/test-chat-tools.js` (or directly extend the existing assertions in `scripts/test-chat.js` from PR #19):

```js
const tools2 = require('../server/services/chatTools');
const ps = tools2.buildProposal('propose_add_stock', { symbol: 'INFY', quantity: 25, avg_buy_price: 1380 }, { userId: 1 });
console.log(`${ps.mutation.path === '/api/investments/stocks' && /Add stock/.test(ps.summary) ? 'PASS' : 'FAIL'}  propose_add_stock`);

const pm = tools2.buildProposal('propose_add_mutual_fund', { fund_name: 'Mirae Asset Large Cap', units: 1250.45, avg_nav: 58.2 }, { userId: 1 });
console.log(`${pm.mutation.path === '/api/investments/mutual-funds' && /Add MF/.test(pm.summary) ? 'PASS' : 'FAIL'}  propose_add_mutual_fund`);
```

(If the existing test harness is different, just confirm with a one-liner: `node -e "console.log(require('./server/services/chatTools').buildProposal('propose_add_stock', {symbol:'INFY',quantity:25,avg_buy_price:1380}, {userId:1}))"`.)

- [ ] **Step 5.4: Commit**

```bash
git add server/services/chatTools.js scripts/test-chat-tools.js scripts/test-chat.js 2>/dev/null
git commit -m "feat(chat): propose_add_stock + propose_add_mutual_fund tools"
```

---

## Task 6: System prompt branch for `upload_processor`

**Files:**
- Modify: `server/services/chatAgent.js`

The chatAgent's `systemPromptFor(agentKind)` currently has a `'financial_advisor'` branch and a default. Add a new branch for the upload processor.

- [ ] **Step 6.1: Add the branch**

Find the `function systemPromptFor(agentKind)` definition. Replace the function with:

```js
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
  if (agentKind === 'upload_processor') {
    return [
      "You are processing a financial document the user just uploaded to their vault. Currency is INR (₹) unless the document states otherwise.",
      "Your job: extract any concrete entries you can identify — stock holdings, mutual fund holdings, earnings/income sources, scheduled payments, advance-tax installments — and propose adding each one using the propose_* tools.",
      "Available propose tools: propose_add_stock, propose_add_mutual_fund, propose_add_earning, propose_add_payment, propose_record_advance_tax.",
      "Be conservative. Only propose rows where you're confident about all required fields. Skip rows where values are ambiguous.",
      "If the document is something else (e.g., a tax filing summary, a bank statement summary, a research note), produce a short text reply describing what you saw — do not call propose_* tools.",
      "Do NOT use the read tools (get_net_worth etc.) — there is no human in the loop to follow up on questions; just extract from the supplied document text.",
      "Do not write conversational filler ('I will now extract...'). Go directly to the proposals or the short summary."
    ].join('\n');
  }
  return 'You are a helpful assistant.';
}
```

- [ ] **Step 6.2: Syntax check**

```bash
node --check server/services/chatAgent.js
```
Expected: no output.

- [ ] **Step 6.3: Commit**

```bash
git add server/services/chatAgent.js
git commit -m "feat(chat): upload_processor system prompt for vault-driven extraction"
```

---

## Task 7: vaultProcessor service — queue + processUpload

**Files:**
- Create: `server/services/vaultProcessor.js`
- Create: `scripts/test-vault-processor.js`

This is the orchestrator. It runs in the background after `confirm-upload`, downloads the file, extracts text, finds-or-creates the user's "Pending uploads" thread, and runs `chatAgent.streamMessage` with a no-op emit. It also implements a per-user serial queue so two rapid uploads don't fan out into concurrent Anthropic calls.

- [ ] **Step 7.1: Write the failing smoke test**

Create `scripts/test-vault-processor.js`:

```js
// Smoke test for server/services/vaultProcessor.js
//   node scripts/test-vault-processor.js
const vp = require('../server/services/vaultProcessor');

function eq(label, actual, predicate) {
  const ok = predicate(actual);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) { console.log('  got:', JSON.stringify(actual).slice(0, 200)); process.exitCode = 1; }
}

(async () => {
  // The exports must include enqueue + processUpload
  eq('exports enqueue', typeof vp.enqueue, t => t === 'function');
  eq('exports processUpload', typeof vp.processUpload, t => t === 'function');

  // enqueue serialises per user. Run two tasks; second must not start
  // until first finishes.
  const order = [];
  const p1 = vp.enqueue(1, () => new Promise(r => setTimeout(() => { order.push('a'); r(); }, 80)));
  const p2 = vp.enqueue(1, () => new Promise(r => setTimeout(() => { order.push('b'); r(); }, 10)));
  await Promise.all([p1, p2]);
  eq('per-user queue is serial', order, o => o.join(',') === 'a,b');

  // Different users run in parallel (fast user finishes first)
  const order2 = [];
  const pa = vp.enqueue(1, () => new Promise(r => setTimeout(() => { order2.push('slow'); r(); }, 60)));
  const pb = vp.enqueue(2, () => new Promise(r => setTimeout(() => { order2.push('fast'); r(); }, 10)));
  await Promise.all([pa, pb]);
  eq('cross-user queues are independent', order2, o => o[0] === 'fast');

  console.log('Done.');
})();
```

- [ ] **Step 7.2: Run, confirm failure**

```bash
node scripts/test-vault-processor.js
```
Expected: `Cannot find module '../server/services/vaultProcessor'`.

- [ ] **Step 7.3: Implement vaultProcessor.js**

Create `server/services/vaultProcessor.js`:

```js
// Background processor for vault uploads. On every successful upload,
// routes/vault.js fires processUpload(fileId, userId) via setImmediate.
// We download the file, extract text, then run chatAgent.streamMessage()
// against the user's "Pending uploads" thread so the agent can propose
// adds via the existing propose_* tool flow.
//
// Per-user serial queue: two rapid uploads from the same user are
// processed sequentially. Cross-user uploads run in parallel.

const db = require('../db/database');
const s3 = require('./s3');
const textExtract = require('./textExtract');
const chatAgent = require('./chatAgent');

const PENDING_THREAD_KIND = 'upload_processor';
const PENDING_THREAD_TITLE = '📥 Pending uploads';

// ────────────────────────────── Per-user serial queue ──────────────────────

const queues = new Map();   // userId → tail Promise

function enqueue(userId, work) {
  const prev = queues.get(userId) || Promise.resolve();
  const next = prev.then(() => Promise.resolve().then(work)).catch(err => {
    console.error('[vaultProcessor] queue error:', err);
  });
  queues.set(userId, next);
  next.finally(() => {
    if (queues.get(userId) === next) queues.delete(userId);
  });
  return next;
}

// ────────────────────────────── Thread provisioning ────────────────────────

function getOrCreatePendingThread(userId) {
  const existing = db.prepare(
    `SELECT id FROM agent_threads WHERE user_id = ? AND agent_kind = ? ORDER BY id ASC LIMIT 1`
  ).get(userId, PENDING_THREAD_KIND);
  if (existing) return existing.id;
  const threadId = chatAgent.createThread({
    userId,
    agentKind: PENDING_THREAD_KIND,
    model: 'claude-sonnet-4-5'
  });
  db.prepare('UPDATE agent_threads SET title = ? WHERE id = ?').run(PENDING_THREAD_TITLE, threadId);
  return threadId;
}

// ────────────────────────────── Main entry ─────────────────────────────────

async function processUpload(fileId, userId) {
  const file = db.prepare('SELECT * FROM vault_files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) { console.warn(`[vaultProcessor] file ${fileId} not found`); return; }
  if (file.processed_at) { return; } // idempotency

  if (!chatAgent.isAgentConfigured()) {
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run('Anthropic API key not configured', fileId);
    return;
  }
  if (!s3.isS3Configured()) {
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run('S3 not configured', fileId);
    return;
  }

  let buffer;
  try {
    buffer = await s3.getObjectBuffer(process.env.S3_BUCKET, file.s3_key);
  } catch (e) {
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run(`S3 download failed: ${e.message}`, fileId);
    return;
  }

  const extracted = await textExtract.extractText(buffer, file.mime_type, file.original_filename);
  const threadId = getOrCreatePendingThread(userId);

  // Short / unsupported text: write a single message and stop
  if (extracted.kind === 'unknown' || extracted.text.length < 50) {
    const reason = extracted.kind === 'unknown'
      ? `Unsupported file type for "${file.original_filename}". Only PDF and CSV are auto-processed.`
      : `Couldn't extract text from "${file.original_filename}". Looks like it may be a scanned image — try uploading a text-based PDF or a CSV export.`;
    db.prepare(
      `INSERT INTO agent_messages (thread_id, role, content, status) VALUES (?, 'assistant', ?, 'final')`
    ).run(threadId, reason);
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run(reason, fileId);
    return;
  }

  // Build the synthetic user message that introduces the document.
  const userMessage =
    `New vault upload to process.\n` +
    `Filename: ${file.original_filename}\n` +
    `Category: ${file.category}${file.subcategory ? ' / ' + file.subcategory : ''}\n` +
    `Financial Year: ${file.financial_year}\n` +
    `Type: ${extracted.kind.toUpperCase()}\n` +
    (extracted.warnings.length ? `Warnings: ${extracted.warnings.join('; ')}\n` : '') +
    `\n--- DOCUMENT TEXT ---\n${extracted.text}\n--- END ---`;

  try {
    await chatAgent.streamMessage(
      { threadId, userId, content: userMessage },
      () => {} // no-op emit; we don't need SSE here
    );
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP WHERE id = ?').run(fileId);
  } catch (e) {
    db.prepare('UPDATE vault_files SET processed_at = CURRENT_TIMESTAMP, processing_error = ? WHERE id = ?')
      .run(`Agent processing failed: ${e.message}`, fileId);
    db.prepare(
      `INSERT INTO agent_messages (thread_id, role, content, status) VALUES (?, 'assistant', ?, 'final')`
    ).run(threadId, `Couldn't process "${file.original_filename}": ${e.message}`);
  }
}

module.exports = {
  enqueue,
  processUpload,
  PENDING_THREAD_KIND,
  PENDING_THREAD_TITLE
};
```

- [ ] **Step 7.4: Run smoke test, confirm 4 PASS**

```bash
node scripts/test-vault-processor.js
```
Expected: 4 PASS lines (exports check + queue serial + cross-user parallel), then `Done.`

The queue tests pass without any DB or S3 setup — they only exercise the in-memory enqueue logic.

- [ ] **Step 7.5: Commit**

```bash
git add server/services/vaultProcessor.js scripts/test-vault-processor.js
git commit -m "feat(vault): processUpload + per-user serial queue"
```

---

## Task 8: Hook the vault confirm-upload route to fire the processor

**Files:**
- Modify: `server/routes/vault.js`

- [ ] **Step 8.1: Add the require + setImmediate**

In `server/routes/vault.js`, find the `/confirm-upload` handler. After the line `res.status(201).json({ message: 'File registered successfully', file });` — actually, place the trigger BEFORE the response so the require is in scope. Restructure as follows:

Find this block:
```js
    const file = db.prepare('SELECT * FROM vault_files WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ message: 'File registered successfully', file });
```

Replace with:
```js
    const file = db.prepare('SELECT * FROM vault_files WHERE id = ?').get(result.lastInsertRowid);

    // Fire-and-forget auto-processing. Failures are logged but don't block
    // the upload response.
    try {
      const vaultProcessor = require('../services/vaultProcessor');
      setImmediate(() => {
        vaultProcessor.enqueue(userId, () =>
          vaultProcessor.processUpload(file.id, userId)
        ).catch(err => console.error('[vault] processor error:', err));
      });
    } catch (e) {
      console.error('[vault] could not schedule processor:', e.message);
    }

    res.status(201).json({ message: 'File registered successfully', file });
```

- [ ] **Step 8.2: Syntax check**

```bash
node --check server/routes/vault.js
```
Expected: no output.

- [ ] **Step 8.3: Commit**

```bash
git add server/routes/vault.js
git commit -m "feat(vault): trigger auto-processor after confirm-upload"
```

---

## Task 9: Frontend — pin the Pending uploads thread + unresolved badge

**Files:**
- Modify: `public/index.html`

The agent sidebar from PR #19 lists threads sorted by `updated_at DESC`. We want the special `agent_kind === 'upload_processor'` thread pinned at the top, separated by a visual divider, with a count badge for any assistant messages whose `status === 'streaming'` (i.e., unresolved proposals).

- [ ] **Step 9.1: Update `agentRenderThreadList` to pin the upload-processor thread**

In `public/index.html`, find the `agentRenderThreadList` function. Replace its body with:

```js
function agentRenderThreadList() {
  var el = document.getElementById('agentThreadList');
  if (!el) return;
  if (!agentState.threads.length) {
    el.innerHTML = '<div class="agent-empty-list">No chats yet — start one with + New Chat.</div>';
    return;
  }
  var pinned = agentState.threads.filter(function(t){ return t.agent_kind === 'upload_processor'; });
  var rest   = agentState.threads.filter(function(t){ return t.agent_kind !== 'upload_processor'; });

  var renderRow = function(t, isPinned) {
    var active = t.id === agentState.activeId ? ' active' : '';
    var pendingBadge = (isPinned && t.pending_count > 0)
      ? '<span class="agent-thread-badge">'+t.pending_count+'</span>' : '';
    return '<div class="agent-thread'+active+(isPinned ? ' pinned' : '')+'" onclick="agentOpenThread('+t.id+')">'
      + '<span class="title">'+esc(t.title || 'New chat')+'</span>'
      + pendingBadge
      + '<span class="menu" onclick="event.stopPropagation();agentThreadMenu('+t.id+')">⋯</span>'
      + '</div>';
  };

  var html = '';
  pinned.forEach(function(t){ html += renderRow(t, true); });
  if (pinned.length && rest.length) html += '<div class="agent-thread-divider"></div>';
  rest.forEach(function(t){ html += renderRow(t, false); });
  el.innerHTML = html;
}
```

- [ ] **Step 9.2: Update `agentLoadThreads` to fetch the pending count**

The thread-list endpoint already returns `id, title, agent_kind, model, updated_at`. We need a per-thread count of streaming assistant messages. Two options: (a) extend the server to include `pending_count`, (b) compute on the client via a follow-up request. Option (a) is one line of SQL.

In `server/services/chatAgent.js`, find `_listThreads`. Replace it with:

```js
  _listThreads: (userId) => db.prepare(`
    SELECT t.id, t.title, t.agent_kind, t.model, t.updated_at,
      (SELECT COUNT(*) FROM agent_messages m
        WHERE m.thread_id = t.id AND m.role = 'assistant' AND m.status = 'streaming') AS pending_count
    FROM agent_threads t
    WHERE t.user_id = ?
    ORDER BY t.updated_at DESC
  `).all(userId),
```

(This file lives in `server/services/chatAgent.js` from PR #19 — only this single export expression changes; everything else stays.)

- [ ] **Step 9.3: Add CSS for the divider, badge, and pinned style**

In `public/index.html`, find the existing `.agent-thread.active{...}` CSS rule. Append immediately after it:

```css
.agent-thread.pinned{background:rgba(198,134,66,.05);font-weight:600}
.agent-thread.pinned .title::before{content:""}
.agent-thread-divider{height:1px;background:var(--border);margin:8px 4px}
.agent-thread-badge{font-size:10px;font-weight:700;background:var(--caramel);color:var(--cream);padding:2px 7px;border-radius:10px;min-width:18px;text-align:center}
```

- [ ] **Step 9.4: Syntax check**

```bash
node -e "const h=require('fs').readFileSync('public/index.html','utf8'); const m=h.match(/<script[^>]*>([\\s\\S]*?)<\\/script>/g); let ok=true; m.forEach((s,i)=>{const code=s.replace(/<script[^>]*>|<\\/script>/g,''); try{new Function(code);}catch(e){ok=false;console.log('Script #'+i+' parse error:',e.message);}}); console.log(ok?'OK':'FAIL');"
node --check server/services/chatAgent.js
```
Both: clean.

- [ ] **Step 9.5: Commit**

```bash
git add public/index.html server/services/chatAgent.js
git commit -m "feat(agent-ui): pin Pending uploads thread + pending-proposal badge"
```

---

## Task 10: Frontend — toast on upload-confirm

**Files:**
- Modify: `public/index.html`

When the vault upload UI gets a 201 from `/api/vault/confirm-upload`, surface a toast directing the user to the agent page. The simplest hook is to wrap the existing upload-confirm code path in the frontend.

- [ ] **Step 10.1: Find the existing vault upload-confirm caller**

```bash
grep -n "confirm-upload\|/api/vault/upload-url" public/index.html | head -10
```
Note the line numbers. The frontend has an upload flow that calls `/api/vault/upload-url`, uses the presigned URL to PUT to S3, then calls `/api/vault/confirm-upload`. The toast fires after the confirm-upload returns 201.

- [ ] **Step 10.2: Add the toast after a successful confirm-upload**

In `public/index.html`, find the success branch of the confirm-upload fetch (a line containing `confirm-upload` followed by checks like `res.ok` or `r.file`). Just after the success handling (typically `showToast('File uploaded'...)` or similar — there may already be a generic success toast), add:

```js
        // Auto-process kicks off server-side; surface a hint and let user
        // jump to the Agent page where proposals will appear.
        showToast('📄 Processing ' + (file && file.original_filename ? file.original_filename : 'upload') + '... Tap to review →', 'info');
        var t = document.querySelector('.toast');
        if (t) t.style.cursor = 'pointer';
        if (t) t.onclick = function(){ navigateTo('agent'); };
```

If the existing flow uses a different variable name for the parsed response (e.g., `data.file`), adjust accordingly. Use the local variable that holds the `file` object returned by confirm-upload.

If the codebase has multiple upload paths (drag-drop vs button), add the toast to each — one of them is likely a single shared function.

- [ ] **Step 10.3: Syntax check**

```bash
node -e "const h=require('fs').readFileSync('public/index.html','utf8'); const m=h.match(/<script[^>]*>([\\s\\S]*?)<\\/script>/g); let ok=true; m.forEach((s,i)=>{const code=s.replace(/<script[^>]*>|<\\/script>/g,''); try{new Function(code);}catch(e){ok=false;console.log('Script #'+i+' parse error:',e.message);}}); console.log(ok?'OK':'FAIL');"
```
Expected: OK.

- [ ] **Step 10.4: Commit**

```bash
git add public/index.html
git commit -m "feat(vault-ui): toast linking to agent page after upload"
```

---

## Task 11: End-to-end smoke + verification checklist

**Files:** none to create.

This is the human-driven validation pass. The earlier task smoke scripts cover the unit-style assertions; this is the integration.

- [ ] **Step 11.1: Run all smoke harnesses**

```bash
node scripts/test-text-extract.js
node scripts/test-vault-processor.js
node scripts/test-chat.js
```
Expected: each prints PASS rows and `Done.`. (Subagents on Node 25 will see better-sqlite3 native-build failures on chat.js — that's a tooling gap; production deploys validate.)

- [ ] **Step 11.2: Manual e2e (production or staging with API key + S3 + DB)**

Run the deployed app with `ANTHROPIC_API_KEY`, `S3_BUCKET`, etc. set. Sign in. For each row, mark the result:

- [ ] Open Agent page → "📥 Pending uploads" thread does not yet exist (sidebar empty or only your prior chats).
- [ ] Upload a Zerodha holdings PDF or CSV via the Vault page.
- [ ] Toast appears: "📄 Processing &lt;filename&gt;..." Click the toast → Agent page opens.
- [ ] Within ~10–20 seconds, the "📥 Pending uploads" thread appears at the top of the sidebar with a count badge.
- [ ] Open the thread → see the synthetic user message (with "DOCUMENT TEXT" block) and the assistant's tool calls; each `propose_*` shows as a confirmation card.
- [ ] Click Confirm on a `propose_add_stock` card → card → "✓ Done"; the corresponding row appears in the Investments page (Stocks tab) on next refresh.
- [ ] Click Reject on another card → card → "✗ Rejected"; no DB row created.
- [ ] Re-upload the same file (different S3 key but same content) — confirm a new processing run kicks off (idempotency is per `vault_files.id`, so a re-upload with a new row does run). Verify the original processed file's `processed_at` is unchanged: `sqlite3 server/db/data.db "SELECT id, original_filename, processed_at FROM vault_files ORDER BY id DESC LIMIT 5"`.
- [ ] Upload a JPG (image, no text layer extractable as PDF) — toast appears; Pending uploads thread either gets a "Unsupported file type..." message OR no message (depending on mime). No crash, no broken UI.
- [ ] Upload while Anthropic API key is unset (test env) — vault upload still succeeds; Pending uploads thread gets "Anthropic API key not configured" message via processing_error path; agent page still renders.

- [ ] **Step 11.3: Final cleanup commit (only if e2e found something)**

```bash
git status
# If anything fell out of e2e, commit fixes here:
# git add -A && git commit -m "fix(vault): <summary>"
```

---

## Out of scope (future iterations)

- Image OCR (vision-capable model for scanned PDFs / photos).
- Reprocess button on the vault file row (currently must re-upload).
- Batch "Confirm all" for proposals (each one still confirmed individually for safety).
- LLM-generated thread titles (e.g., "Zerodha holdings — 12 stocks proposed") instead of the static "📥 Pending uploads".
- Surfacing the proposal state (pending/applied/rejected) on the vault file row alongside its category badge.
- Per-user daily token cap.
