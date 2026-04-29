# Agent Chat Page — Design

**Date:** 2026-04-30
**Status:** Approved (brainstorm); awaiting implementation plan
**Author:** Claude (with Kiran)

## Goal

Add a chat surface where the user can talk to a financial-advisor agent grounded in their own data — querying holdings, net worth, and tax position; and proposing low-risk writes (mark a hand-loan settled, add an income source, record an advance-tax payment) that the user explicitly confirms. Persist conversations as threads so the user can come back to a "Tax planning" or "Stock review" chat across sessions.

The page also exposes a model selector (Anthropic + Groq models already configured in `services/agent.js`) and an agent-kind selector for forward-compat — v1 ships only `financial_advisor`, but the dropdown is in place so additional agents (Tax Helper, Investment Coach) can be added without UI changes.

## Non-goals

- Free-form general chat (split out as a separate `general` agent later if usage warrants it).
- Direct writes from the agent without confirmation.
- Edits/deletes of existing financial records via proposal — only adds and status-flips on hand-loans in v1.
- Voice / image input.
- Sharing threads between users.

## Architecture

Frontend lives entirely in the existing single-file `public/index.html` (new `#page-agent` block inside `.main-content`, new CSS rules, ~250 lines of JS). Backend gets a new route module and a new service module that reuse the Anthropic SDK client and the cost calculator from `services/agent.js` but own their own multi-turn streaming loop.

```
public/index.html
  #page-agent  (HTML)         — sidebar + chat panel
  .agent-*     (CSS)          — layout, bubbles, proposal card
  agent-chat   (JS)           — thread CRUD, EventSource handler, render

server/routes/chat.js          (new) — REST + SSE endpoints
server/services/chatAgent.js   (new) — multi-turn loop, tool dispatch, audit
server/db/database.js          — new agent_threads, agent_messages; ALTER agent_calls
```

`services/agent.js` is intentionally **not** extended. Its current contract is single-shot (`{ task_type, prompt }` → result, audit row). Streaming, tool-use turn loops, and conversation state are a different shape; cramming them into the closed `TASK_TYPES` dispatcher would expand it from ~200 lines to ~600 and make the simple read-only call paths harder to reason about. The chat module reuses what's actually shared (the SDK client, `PRICE_TABLE`, `agent_calls` insert) and owns its own complexity.

## DB schema

```sql
CREATE TABLE agent_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT 'New chat',
  agent_kind TEXT NOT NULL DEFAULT 'financial_advisor',
  model TEXT NOT NULL DEFAULT 'claude-haiku-4-5',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_threads_user ON agent_threads(user_id, updated_at DESC);

CREATE TABLE agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool')),
  content TEXT,                       -- plain text for user/assistant; JSON tool_result for tool turns
  tool_uses TEXT,                     -- JSON: [{id, name, input}, ...] when assistant called tools
  status TEXT NOT NULL DEFAULT 'final'
    CHECK(status IN ('streaming','final')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES agent_threads(id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_messages_thread ON agent_messages(thread_id, id);

ALTER TABLE agent_calls ADD COLUMN thread_id INTEGER;
```

**Notes on the schema:**

- `title` defaults to "New chat"; on the first user message, server auto-sets it to the first ~40 chars (truncated at a word boundary, no API summarization in v1). User can rename via the sidebar ⋯ menu.
- `agent_messages.status='streaming'` is an escape hatch. If the SSE connection drops mid-write, the row stays as `streaming` and is either resumed (next stream finalizes it) or pruned at thread-load time. Avoids "ghost half-message" rendering.
- `tool` rows store the result JSON in `content`. They link back to the assistant turn that triggered them via the `tool_uses[i].id` matching the tool_use_id passed to `/confirm` (no FK column; the tool_use_id is unique enough within a thread).
- `agent_calls.thread_id` is nullable to keep existing single-shot tasks untouched. Chat-driven calls fill it in.

## API contract

All routes mounted at `/api/chat` and require `authMiddleware`.

```
GET    /threads                       → [{id, title, agent_kind, model, updated_at}, ...]
POST   /threads                       → {id, ...}        body: {agent_kind?, model?}
GET    /threads/:id                   → {thread, messages: [...]}
PATCH  /threads/:id                   → {ok}             body: {title?, agent_kind?, model?}
DELETE /threads/:id                   → {ok}

POST   /threads/:id/stream            → text/event-stream
       body: {content: "<user message>"}

POST   /threads/:id/confirm           → {ok, applied: true|false, error?}
       body: {tool_use_id, decision: "confirm"|"reject"}
```

`/stream` is the only SSE endpoint; everything else is plain JSON. All routes scope by `req.user.id` and 404 on cross-user thread access (existing IDOR pattern from other routes).

### SSE events from `/stream`

```
event: thread_meta      data: { user_message_id }
event: assistant_start  data: { message_id }
event: text             data: { delta: "..." }                     ← repeats N times
event: tool_use         data: { id, name, input }                  ← agent wants tool
event: tool_result      data: { tool_use_id, status, result }      ← read tools (server auto-runs)
event: proposal         data: { tool_use_id, name, input,
                                summary, mutation }                ← write tools, awaits user
event: done             data: { message_id, usage: {in, out, cost_usd} }
event: error            data: { message }
```

The streaming endpoint runs the multi-turn loop server-side:

1. Open SSE, write user message row, emit `thread_meta`.
2. Call Anthropic with the conversation so far + tools spec.
3. As text deltas arrive, emit `text` and append to the in-flight assistant message buffer.
4. If the model emits `tool_use`:
   - **Read tool** (e.g. `query_holdings`) — server executes it, emits `tool_result`, appends both the tool_use and tool_result to the conversation, and re-enters the loop (back to step 2).
   - **Write proposal** (e.g. `propose_mark_handloan_status`) — server stops the loop, builds the proposal payload (see "Tools" below), persists the assistant message with `status='streaming'`, emits `proposal`, closes the SSE.
5. On `end_turn` with no tool calls — server marks the assistant message `final`, emits `done` with usage, closes the SSE.

This means **no streaming-while-waiting-for-confirmation**. The connection closes cleanly on a proposal; the next user message (which may be "yes please" or a fresh question) re-opens it. Avoids long-held SSE connections waiting on a UI click.

## Tools

### Read tools (server auto-executes)

| Tool | Input | Returns |
|---|---|---|
| `get_net_worth` | — | totals from `routes/networth` |
| `query_holdings` | `{category}` | stocks/mutual_funds/fds/us_stocks/savings/nps/insurance |
| `query_liabilities` | — | credit cards + loans |
| `query_hand_loans` | `{direction?, status?}` | given/taken with optional status filter |
| `query_earnings` | — | income sources |
| `query_payments` | `{filter?}` | scheduled payments |
| `query_tax` | `{year}` | advance tax + estimated liability for FY |
| `query_properties` | — | properties + active rent |

All read tools are thin wrappers over the existing route handlers. They do not duplicate validation/auth logic — instead they invoke the handlers programmatically with `{ user: req.user }` set.

### Write-proposal tools (require user confirmation)

| Tool | Proposes |
|---|---|
| `propose_mark_handloan_status` | flip a hand-loan to active/partial/settled |
| `propose_add_earning` | add a new income source |
| `propose_add_payment` | add a new scheduled payment |
| `propose_record_advance_tax` | record a new advance-tax installment |

Deliberately **no delete proposals and no edits on existing financial records in v1.** Adds and status-flips are reversible enough; deletes need a confirmation flow we don't need to design yet.

### Confirmation flow

1. Agent emits `tool_use` for `propose_*`. Server doesn't execute it; instead it builds:
   ```js
   {
     tool_use_id,
     name,
     input,
     summary: "Mark loan #3 (Rahul Sharma, ₹50,000) as Settled",
     mutation: { method: "PUT", path: "/api/loans/hand-loans/3", body: { status: "settled" } }
   }
   ```
   Persists the assistant message in `status='streaming'`, emits `proposal`, closes the SSE.

2. Frontend renders an inline card under the assistant message:
   > **🛠 Mark loan #3 (Rahul Sharma, ₹50,000) as Settled**
   > [Confirm]  [Reject]

3. On click → `POST /api/chat/threads/:id/confirm { tool_use_id, decision }`:
   - **confirm** — server dispatches the stored `mutation` against the existing route handler (using a small in-process invoker with `req.user.id` set; no actual HTTP loop), writes a `tool` message with the result, marks the assistant message `final`. Returns `{applied:true}`. Frontend updates card to "✓ Done".
   - **reject** — server writes a `tool` message `{rejected:true}`, marks the assistant message `final`. Card → "✗ Rejected".

4. The next user message reopens the loop. The agent sees the tool result and can respond ("Marked as settled. Anything else?").

**Pending-proposal rule.** Anthropic's tool-use protocol requires a `tool_result` for every `tool_use` before the conversation can continue. While a proposal is pending the assistant message has an unresolved tool_use, so the chat input is **disabled** with the hint "Confirm or reject the proposal above to continue." This keeps the conversation history valid by construction; we never need to synthesize a fake tool_result to recover from out-of-order user input.

The agent never directly mutates anything; the proposal is a stored DB row before any UI choice; dispatch goes through the existing authed route handlers (so the server doesn't need a second copy of validation/IDOR/profile checks).

**Per-tool summary builders.** Each `propose_*` tool has a small server-side summary function that takes the input args and returns the human-readable string shown on the card and stored on the proposal payload. Centralised in one map in `chatAgent.js` so the rendering rule stays close to the tool definition.

## Frontend UI

New `Agent` nav tab between `Vault` and `Properties`. Page id `page-agent`, lives inside `.main-content` like every other page.

### Layout

CSS grid, two columns at desktop (sidebar 260px / chat 1fr); sidebar collapses to a slide-in drawer on mobile (≤768px), toggled from a hamburger button at the top of the chat panel.

```
┌────────────────────┬─────────────────────────────────────────┐
│  + New Chat        │  Agent: [Financial Advisor ▾]          │
│  ──────────────    │  Model: [Claude Sonnet 4.5 ▾]          │
│  Tax planning      │ ──────────────────────────────────────  │
│  Stock review      │                                         │
│  Hand loan check  ◀│  user: how am I doing on 80C this year?│
│  ...               │                                         │
│                    │  agent: You've used ₹1.2L of ₹1.5L...  │
│                    │  ┌──────────────────────────────────┐  │
│                    │  │ 🛠 Mark loan #3 as Settled       │  │
│                    │  │ Rahul Sharma · ₹50,000           │  │
│                    │  │ [Confirm]  [Reject]              │  │
│                    │  └──────────────────────────────────┘  │
│                    │                                         │
│                    │  ┌────────────────────────────┐ [Send] │
│                    │  │ Type your message...       │        │
│                    │  └────────────────────────────┘        │
└────────────────────┴─────────────────────────────────────────┘
```

### Components

- **Sidebar** — list of threads sorted by `updated_at DESC`, active thread highlighted. Hover reveals ⋯ menu → Rename / Delete. Empty state: "No chats yet — start one with + New Chat."
- **Selectors row** — `agent_kind` and `model` dropdowns at the top of the chat panel. Changes persist to the thread on the *next* user message (no immediate PATCH; cheap and avoids racing with a streaming turn). For v1, `agent_kind` has one option (`Financial Advisor`); the dropdown is wired up so adding more agents later is config-only.
- **Message list** — rendered top-down with auto-scroll on new tokens. User bubbles right-aligned in a muted color (`var(--bg-secondary)` border), assistant bubbles left-aligned with caramel accent. Tool calls render as a small grey "🛠 Read holdings (12 stocks)" chip inline; the result JSON is collapsed but expandable on click for debugging.
- **Proposal card** — distinct caramel-bordered block under the assistant message. Three persistent states (read from DB on reload):
  - **pending** — Confirm/Reject buttons.
  - **applied** — "✓ Done" + green chip with the executed action's summary.
  - **rejected** — "✗ Rejected" muted chip.
- **Input** — textarea with autosize; `⌘/Ctrl+Enter` to send, `Enter` for newline. Disabled while a stream is in flight, **and** while a proposal is awaiting Confirm/Reject (see the pending-proposal rule above). A "Stop" button replaces "Send" mid-stream and aborts the `EventSource` (server-side: when the request closes, the loop bails and marks any in-flight assistant row `final`).
- **Demo mode banner** — same dismissible banner used elsewhere. Agent calls require a real auth token; in demo mode the page shows a centered "Sign in with a real account to use the agent — demo mode can't reach the LLM."

## Error handling

- **No `ANTHROPIC_API_KEY`** — `/threads/*/stream` returns 503 with `{error: "Agent is not configured on the server"}` before opening SSE. Frontend shows it as a toast and disables the input.
- **Stream interrupted** — assistant row stays `status='streaming'`. On thread reload, the frontend renders it with a faint "(interrupted — send a new message to continue)" suffix. The next stream cleans it up by either appending or replacing.
- **Tool execution failure** (read tool throws) — emit `tool_result` with `status: "error"`. The agent sees the error and can recover or apologise.
- **Rate-limit / 429 from Anthropic** — surface as `event: error` with the upstream message; do not retry blindly.
- **Confirmation race** (user clicks Confirm twice) — server checks the assistant message status; if already `final`, returns `{ok:true, applied:false, error:"Already resolved"}`.

## Cost & abuse

Each call already audits to `agent_calls` with input/output tokens and the model's price from `PRICE_TABLE`, so the existing admin cost view picks up chat usage automatically (just filter on `task_type='interactive_chat'` or by `thread_id IS NOT NULL`).

No per-user daily cap in v1 — this is a single-user app and the user is the operator. If the app ever grows beyond personal use, add a daily token cap as a follow-up.

## Testing

No automated test harness exists in this repo, so verification is manual + targeted:

- **Server unit-style smoke tests** (a small Node script committed alongside the implementation) — assert each read tool wrapper returns the same shape as the underlying route handler for a fixture user.
- **Streaming round-trip** — manual: open the page, send "what's my net worth", verify tokens stream in, tool chip appears, response uses real numbers.
- **Proposal round-trip** — manual: ask "mark loan #3 as settled". Confirm → loan row's `status` is `settled`, tool message is appended, agent responds. Reject → no DB change, agent acknowledges.
- **Demo-mode guard** — manual: in demo mode the input is disabled and the banner explains why.
- **Reload safety** — manual: kill the server mid-stream, reload the thread, verify the streaming row renders with the suffix and the next message recovers cleanly.

## Open questions

None blocking implementation; flagged for future iteration:

- Should we summarise (with a small model) the first user message into a thread title, instead of just truncating? Cheap, but would add a second API call per thread creation.
- Should write proposals expire (e.g. become un-confirmable after 24h) for safety? The current design keeps them confirmable forever.
- Do we need a "regenerate response" button? Out of scope for v1; users can just send a follow-up.
