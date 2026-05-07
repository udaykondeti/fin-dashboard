# Gmail Bill Ingestion — Design

## Goal
Pull bill emails from the user's Gmail inbox into the dashboard's `liabilities` / `scheduled_payments` tables. When the user marks a bill paid (or we detect a "payment received" email), close the entry.

## Out of scope (this design)
- Sending email (we already have Slack outgoing for notifications)
- Parsing arbitrary email content into investments / earnings (separate ingestion track)
- Multi-user OAuth — assume single-tenant on EC2 for v1

## High-level flow
```
  User clicks "Connect Gmail" in Settings
    ↓
  OAuth consent (Google) → authorization code → access + refresh tokens
    ↓
  Tokens stored encrypted in user_credentials table
    ↓
  Background poller (every 30 min) walks new messages with
    label:UNREAD AND (subject:bill OR subject:invoice OR from:(known billers))
    ↓
  For each message → extract via LLM → propose a liability/payment row
    ↓
  Pending proposals shown in a new "Inbox" tab; user accepts/rejects
    ↓
  Accepted → INSERT into liabilities or scheduled_payments
    ↓
  When the user marks paid OR a "payment received" email arrives →
    set is_paid=1 / status='paid' on the linked row
```

## Architecture

### New tables
```sql
CREATE TABLE oauth_credentials (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,             -- 'gmail'
  access_token TEXT NOT NULL,         -- AES-256-GCM encrypted
  refresh_token TEXT NOT NULL,        -- AES-256-GCM encrypted
  expires_at DATETIME,
  scopes TEXT,                        -- comma-separated
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, provider)
);

CREATE TABLE bill_proposals (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  source TEXT NOT NULL,               -- 'gmail'
  source_message_id TEXT NOT NULL,    -- Gmail msg id, dedup key
  raw_subject TEXT,
  raw_from TEXT,
  raw_received_at DATETIME,
  extracted JSON,                     -- { biller, amount, due_date, currency, ... }
  status TEXT DEFAULT 'pending',      -- pending | accepted | rejected | duplicate
  linked_table TEXT,                  -- 'scheduled_payments' or 'credit_cards'
  linked_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, source_message_id)
);

CREATE TABLE bill_payment_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  proposal_id INTEGER,
  source_message_id TEXT,
  detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  applied_at DATETIME,
  notes TEXT,
  FOREIGN KEY (proposal_id) REFERENCES bill_proposals(id) ON DELETE SET NULL
);
```

### Backend modules
- `server/services/oauth/gmail.js` — Google OAuth dance + token refresh
- `server/services/gmailClient.js` — wraps gmail.users.messages.list + .get
- `server/services/billExtractor.js` — passes raw email subject/snippet to the
  existing chat agent (`runTask({ taskType: 'extract_bill', ... })`) and
  validates the JSON shape returned
- `server/jobs/gmailPoller.js` — PM2 cron app (like groq-watcher), runs every
  30 min, fetches new messages since `last_message_id` per user, persists
  proposals
- `server/routes/inbox.js` — list pending proposals, accept/reject them, mark
  bill paid
- `server/middleware/encrypt.js` — `encrypt(token)` / `decrypt(token)` using
  `process.env.OAUTH_TOKEN_KEY` (32-byte hex). Refuses to start if missing
  in production.

### Frontend
- New "Inbox" nav tab next to Vault — list of pending proposals with biller,
  amount, due date, accept/reject buttons
- Liabilities page gains a small "From email" badge on rows that came from
  a proposal
- Connect Gmail button in a future Settings page (or on the empty Inbox)

### Google Cloud setup (one-time, manual)
1. Create OAuth 2.0 client in Google Cloud Console (Web app)
2. Authorized redirect URI: `https://fin.kirakon.com/api/oauth/gmail/callback`
3. Scopes: `gmail.readonly`, `gmail.modify` (to add a `Processed` label)
4. Add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_TOKEN_KEY` to
   `/var/www/fin-dashboard/.env`

## Extraction strategy
First pass per email:
1. Pull subject + sender + first 1000 chars of plain-text body
2. Send to existing agent with task type `extract_bill`:
   ```
   System: "Given a bill email, return JSON: {biller, amount, currency,
            due_date (ISO), category, is_recurring, confidence (0-1)}.
            If not a bill, return {is_bill: false}."
   User: "<subject>\n<from>\n<body>"
   ```
3. Reject `is_bill: false` or `confidence < 0.6`. Persist accepted ones to
   `bill_proposals` with `status='pending'`.

Routing via existing `routeProvider`: this is app-data territory, so it goes
to Anthropic by default (good extraction quality is worth the cost).

## "Mark paid" detection
Two paths:
1. **Manual**: user clicks "Mark paid" on the liability row → updates
   `bill_proposals.status='paid'` + sets `paid_at`
2. **Automatic**: a follow-up email matching `from:bank.com subject:debited`
   triggers a fuzzy match against open proposals (same biller name +
   amount within 5% within 7 days) → flags for user confirmation
   ("Looks like XYZ bill was paid. Confirm?")

Auto-detection is conservative — never auto-closes without user OK to avoid
false positives.

## Security / Privacy
- Tokens encrypted at rest with `OAUTH_TOKEN_KEY` (AES-256-GCM, random IV per
  row). Server refuses to boot in production if the key is missing.
- Read-only Gmail scope first; `gmail.modify` only needed if we want to add
  a "Processed by FinDash" label so the poller doesn't reprocess.
- Email body is sent to the LLM per the existing audit table — only a 200-char
  preview persists in `agent_calls`. Full body never stored.
- No third-party redistribution. Gmail data stays on EC2 + temporarily on
  Anthropic/Groq during extraction.

## Effort estimate
Rough breakdown:

| Phase | Scope | Days |
|---|---|---|
| 1 | DB tables + OAuth flow + token storage | 1 |
| 2 | Gmail poller + dedup (no extraction yet, just persisted raw) | 1 |
| 3 | Extractor + chat-agent task type + propose flow | 1 |
| 4 | Inbox UI + accept/reject + linked-row badge | 1 |
| 5 | Mark-paid manual + auto-detection (conservative) | 1 |
| 6 | Migration scripts, smoke tests, hardening | 1 |

Total: ~6 working days. Phases 1-3 are the irreversible architecture; phases
4-6 are incremental UI / quality.

## Open questions for the user
1. **Single-user or multi-user OAuth?** v1 single-user simpler; multi-user
   means each user signs into their own Google account.
2. **Which Gmail labels/queries** to scan? Default `subject:(bill OR invoice OR
   payment OR statement)` — but if you have a custom Gmail filter that tags
   bills, point us at that label instead.
3. **Bill categories**: route into `scheduled_payments` (recurring) or
   `credit_cards` (statement)? v1 routes by sender heuristic (banks/cc → CC
   row; utilities/subscriptions → scheduled payment).
4. **Notification channel for new proposals**: web only, or also push
   to the existing Slack webhook?
