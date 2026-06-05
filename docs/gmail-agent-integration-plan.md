# Gmail → Agent Integration Plan

**Goal:** when the user connects their Gmail, the agent can read transactional emails (credit-card statements, MF deposits, broker confirmations, NPS credits, FD interest payouts, etc.) and propose dashboard updates — same `propose_*` flow the vault uses today.

## Current state

| Piece | Status | File |
|---|---|---|
| Gmail OAuth flow (`/connect`, `/callback`, token storage) | ✅ shipped | `server/routes/gmail.js`, `server/services/gmailService.js` |
| `gmail_tokens` table (migration 30) | ✅ shipped | `server/db/database.js` |
| Manual poll endpoint (`POST /api/gmail/poll`) | ✅ shipped | `server/routes/gmail.js` |
| Cron poller script | ⚠️ exists but stale | `scripts/gmail-poller.js` |
| Agent tool for Gmail (`query_gmail`, `propose_from_gmail`) | ❌ missing | — |
| Per-message dedup (`gmail_messages` table) | ❌ missing | — |
| MCP server wrapping Gmail (so other agents can use it) | ❌ optional, later | — |

## Architecture (three layers)

### Layer 1 — Storage & dedup (new)

Add a table that records every Gmail message we've examined so re-polling doesn't re-propose the same transaction:

```sql
CREATE TABLE gmail_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message_id TEXT NOT NULL,          -- Gmail's own message-id
  thread_id TEXT,
  subject TEXT,
  from_addr TEXT,
  received_at DATETIME,
  category TEXT,                     -- 'cc_statement' | 'mf_credit' | 'nps' | 'broker' | 'other'
  extracted_text TEXT,               -- normalised body
  processed_at DATETIME,
  processing_error TEXT,
  proposals_applied INTEGER DEFAULT 0,
  UNIQUE(user_id, message_id)
);
```

That gives the same processed/error/applied trio the vault has, so the agent UI can reuse the existing list view.

### Layer 2 — Poller → ingester (extend existing)

Rewrite `scripts/gmail-poller.js` so each run:

1. Pulls every message matching `from:noreply OR from:alerts OR from:statement` since `MAX(received_at)` for that user (incremental — pagination via Gmail's `historyId`).
2. For each new message:
   - `INSERT OR IGNORE INTO gmail_messages` — natural-key dedup on `(user_id, message_id)`. If the row already exists, skip.
   - Classify into one of the categories above using filename/subject/from heuristics (mirror `services/smartRouter.js`).
   - Fire-and-forget into the existing `vaultProcessor` pattern: same per-user queue, same auto-confirm loop, same propose_* tools. The body becomes the "DOCUMENT TEXT" the LLM sees.
3. Update `processed_at` + `proposals_applied` on the row.

Cron: run once an hour from the existing `pm2-monitor` cluster (or as a setInterval inside the main server process — the vault watcher already does similar 60s rescans, easy to add).

### Layer 3 — Agent-facing tools (new in `chatTools.js`)

Two read tools (the agent calls these in conversation):

```js
get_gmail_status(_input, { userId })
  // → { connected, last_polled, unprocessed_count }

query_gmail({ since?, category?, limit? }, { userId })
  // → { messages: [{ id, subject, from, received_at, category, processed_at, proposals_applied }, ...] }
```

No new `propose_*` tools needed — the existing `propose_add_*` family handles the actual mutations. The poller pushes work into the same `📥 Pending uploads` thread the vault uses (or a sibling `📨 Pending emails` thread — design decision below).

## Open design questions (need your call)

1. **One thread or two?** The vault feeds `📥 Pending uploads`. Should email-derived proposals share that thread (one inbox to triage) or get their own `📨 Pending emails` thread (cleaner provenance)? **Recommendation: separate thread.** Easier to disable email auto-confirm without affecting uploads.

2. **Auto-confirm scope.** Vault auto-confirms now (user said intentional). For email-derived proposals — same auto-confirm? Some emails are higher-stakes (e.g. "credit card statement = ₹1.2L due") and you might prefer manual confirm. **Recommendation: opt-in per category.** Default: low-stakes categories (FD interest, NPS credit) auto-confirm; high-stakes (CC statements, new accounts) require manual confirm.

3. **MCP server wrapping.** You mentioned "MCP integration". Two interpretations:
   - **a)** Expose Gmail as an MCP server other LLMs/agents can use — overkill for a single-user app.
   - **b)** Use an existing MCP Gmail server (e.g. the Google MCP server already listed in your deferred tools as `mcp__151ba3e1-...`) so we don't have to maintain our own OAuth + polling.
   
   **Recommendation: (b)** if that MCP server is hosted by Google/Anthropic and survives across sessions. Saves you maintaining `gmail_tokens` + refresh logic. If it's session-scoped (re-auth every time), stick with our own.

4. **Backfill horizon.** First poll after connect — last 30 days? 90 days? All time? Older emails take longer to process and the model may be more uncertain on stale data. **Recommendation: 30 days, with a "Backfill more" button.**

5. **PII / privacy.** Gmail bodies often contain account numbers, names, balances. Currently `vault_files.processing_error` and `agent_messages.content` store the full extracted text. For Gmail we may want to redact PAN/account numbers before storing the body. **Recommendation: redact on write.**

## Phased delivery

| Phase | What ships | Effort |
|---|---|---|
| 0 — Validate OAuth still works end-to-end with current image, fix any UI gaps in `/settings → Gmail` | ½ day |
| 1 — `gmail_messages` table + migration + the rewritten poller w/ dedup | 1 day |
| 2 — Wire poller into `vaultProcessor` pattern; classifier from `smartRouter`; first auto-confirm of one category (NPS credits) | 1 day |
| 3 — Agent tools `get_gmail_status` + `query_gmail`; settings UI shows last-polled + unprocessed count | ½ day |
| 4 — Roll out remaining categories (CC, MFs, broker); per-category auto-confirm toggle | 1 day |
| 5 — Optional: swap our OAuth/polling for the deferred MCP Gmail server if it's persistent | ½ day |

Total: ~4–5 dev days.

## Out of scope (for now)
- Gmail → categorise → file-to-vault (the vault watcher already covers files attached to emails if you forward to the inbox folder). Different ingestion path; not needed.
- Sending emails from the agent. Read-only is enough.
- Multi-account Gmail. Single-user app.
