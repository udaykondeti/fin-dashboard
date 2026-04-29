# Vault Auto-Process on Upload — Design

**Date:** 2026-04-30
**Status:** Approved (brainstorm); awaiting implementation plan
**Depends on:** PR #19 (`feat/agent-chat`) — auto-process reuses the chat agent's streaming tool loop and propose_* infrastructure.

## Goal

When a user uploads a financial document (PDF or CSV) to the vault, the system extracts its contents and proposes adding the relevant rows (stock holdings, mutual funds, earnings, payments, advance-tax payments) to the database. The user reviews each proposal in a single "📥 Pending uploads" thread on the agent page and clicks Confirm/Reject. No data is mutated without explicit confirmation.

This closes the loop the user described: "I uploaded a file but the AI should have read it and added the investments."

## Non-goals

- Image OCR (scanned PDFs without text layer return a "couldn't extract" message instead).
- Direct auto-apply (no confirm step). One bad extraction = corrupted portfolio data with no audit trail. Always go through proposals.
- Reprocess button — re-uploading is the workaround.
- Batch "confirm all" UI — proposals are still confirmed one at a time. Safer.
- New file types: spreadsheets (.xlsx), images, Word docs.

## Architecture

```
POST /api/vault/confirm-upload
        │
        │  insert vault_files row
        │
        ▼
        respond 200 immediately
        │
        │  setImmediate(() => vaultProcessor.processUpload(fileId, userId))
        ▼
vaultProcessor (background)
        │
        ├─ download file from S3
        ├─ extract text (PDF: pdf-parse / CSV: existing parser)
        ├─ if extracted text < 50 chars → write "couldn't extract"
        │  message to the Pending-uploads thread, stop
        │
        └─ chatAgent.streamMessage(threadId, syntheticUserMessage)
                │
                │  agent uses propose_add_stock / propose_add_mutual_fund /
                │  propose_add_earning / propose_add_payment / propose_record_advance_tax
                │
                ▼
        proposals land in the Pending-uploads thread
        │
        ▼
   user opens Agent page → reviews → Confirm/Reject each
```

The processor is **fire-and-forget** from the upload route's perspective — upload responds immediately, processing happens in background, failures are logged but never block the upload. The user sees a toast that processing started; the agent thread is the source of truth for what got extracted.

## DB schema changes

Two small additions, no new tables:

```sql
-- Track whether a vault file has been auto-processed (idempotency).
ALTER TABLE vault_files ADD COLUMN processed_at DATETIME;
ALTER TABLE vault_files ADD COLUMN processing_error TEXT;
```

The "📥 Pending uploads" thread itself is just a regular `agent_threads` row with a special `agent_kind = 'upload_processor'`. One per user. Auto-created lazily on first upload.

## Backend modules

### `server/services/vaultProcessor.js` (new)

```js
async function processUpload(fileId, userId) {
  // 1. Idempotency check — skip if already processed
  // 2. Load file row + download from S3
  // 3. Extract text by mime type
  // 4. Get-or-create the user's "Pending uploads" thread
  // 5. Build a synthetic user message including filename + category + text
  // 6. Run chatAgent.streamMessage with a no-op emit (we don't need SSE
  //    here; we're running server-side and the proposals persist to the
  //    thread automatically)
  // 7. Mark vault_files.processed_at = now (success or failure)
}

// Per-user serial queue so concurrent uploads don't trigger
// concurrent Anthropic calls.
const queues = new Map();   // userId → Promise chain
function enqueue(userId, work) {
  const prev = queues.get(userId) || Promise.resolve();
  const next = prev.then(work, work).catch(err => console.error('[vaultProcessor]', err));
  queues.set(userId, next);
  next.finally(() => { if (queues.get(userId) === next) queues.delete(userId); });
  return next;
}
```

### `server/services/textExtract.js` (new, small)

Wraps `pdf-parse` (PDF) and the existing CSV parser. Single function:

```js
async function extractText(buffer, mimeType, filename) {
  // Returns { text, kind: 'pdf'|'csv'|'text', warnings: [...] }
  // Truncates to 30000 chars (Sonnet input budget; rest of context is the
  // system prompt + tool spec).
}
```

### `server/routes/vault.js` (modify)

In the existing `/confirm-upload` handler, after the DB insert, before `res.json(...)`:

```js
const vaultProcessor = require('../services/vaultProcessor');
setImmediate(() => {
  vaultProcessor.enqueue(req.user.id, () =>
    vaultProcessor.processUpload(insertedRow.id, req.user.id)
  );
});
```

Wrapping in `setImmediate` decouples the upload response from the processor — the user gets their 200 instantly, the LLM call happens later.

### `server/services/chatAgent.js` (modify)

- Add a new system prompt branch in `systemPromptFor('upload_processor')`:

  > "You are processing a document the user uploaded to their vault. Extract any concrete financial entries you can identify (stocks, mutual funds, earnings, payments, advance-tax) and propose adding each one using the propose_* tools. Be conservative — only propose rows where you're confident about the parsed values. If the document is something else (e.g., a tax filing summary, a brokerage statement summary), produce a short text reply describing what you saw and skip the proposals."

- Allow `streamMessage` to be called with a no-op `emit` callback so the processor can run it server-side without SSE (no new code; existing `emit` is just a function — passing `() => {}` is fine).

### `server/services/chatTools.js` (extend)

Add 2 new write-proposal tools:

| Tool | Proposes |
|---|---|
| `propose_add_stock` | row in `stocks` (symbol, company_name, quantity, avg_buy_price) |
| `propose_add_mutual_fund` | row in `mutual_funds` (fund_name, units, avg_nav, fund_type) |

Schemas mirror the existing import payloads; mutations target `POST /api/investments/stocks` and `POST /api/investments/mutual-funds` (existing endpoints).

The chat agent (Financial Advisor) gets these tools too — it already had read access to holdings, having `propose_add_*` for stocks/MFs is consistent.

## Frontend changes

Small. The agent page already exists.

- **Sidebar pinning:** when the sidebar renders, the "📥 Pending uploads" thread (matched by `agent_kind === 'upload_processor'`) is sorted to the top, separated by a thin border. Other threads sort by `updated_at DESC` underneath.
- **Unresolved-proposal badge:** the pinned thread shows a count badge if it has any assistant messages with `status='streaming'` (i.e., pending proposals). Updated on `agentLoadThreads`.
- **Toast on upload-confirm** (in vault upload UI): "📄 Processing \<filename\>... Tap to review →" — clicking switches to the agent page and opens the Pending uploads thread.

## Error handling

- **PDF without text layer (scanned image):** `pdf-parse` returns empty/short text. If extracted text < 50 chars, write a single text message to the thread: "Couldn't extract text from \<filename\>. Looks like it may be a scanned image — try uploading a text-based PDF or a CSV export." Mark `processed_at` so we don't retry.
- **Anthropic call fails:** log to console, write a text message to the thread: "Couldn't process \<filename\>: \<reason\>". Mark `processed_at` and store reason in `processing_error`.
- **No `ANTHROPIC_API_KEY`:** processor is a no-op (logs once and skips). Vault upload still succeeds.
- **Unsupported mime type:** skip silently. Vault upload still succeeds; no thread entry created.
- **Concurrent uploads same user:** the per-user queue serialises them. No interleaving.

## Cost & abuse

Each upload costs one Anthropic call (Sonnet by default for extraction quality), audited to `agent_calls` like every other chat-driven call. The vault already has size limits (5MB body limit on the JSON upload route) and the text extraction caps at 30k chars before sending to the model, so a single upload is bounded in token cost.

No per-user daily cap in v1 (single-user app); add later if needed.

## Testing

- **Unit-style smoke** — extend `scripts/test-chat.js` with a section that calls `vaultProcessor.processUpload(fixtureFileId, 1)` against a small fixture PDF and asserts the resulting thread has at least one `propose_*` tool_use row.
- **Manual round-trip** — upload a Zerodha holdings PDF (or CSV), wait ~10s, open the Agent page, see the Pending uploads thread with proposals, Confirm one, check the corresponding investments table.
- **Failure paths** — upload an empty PDF, upload a JPG (skipped silently), upload while the API key is unset (no thread entry, no crash).

## Open questions

None blocking. Future iterations:

- Should we summarise the extraction in the thread title (e.g. "Zerodha holdings — 12 stocks proposed")? Cheap; would make the sidebar more glanceable.
- Should processed files show their proposals' state (pending/applied/rejected) in the vault file list, alongside the existing category badge?
- Image OCR for scanned PDFs (vision model). Would handle the realistic case of someone scanning a paper statement.
