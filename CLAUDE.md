# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow (standing authorization)

The repo owner has authorized fully automated change delivery. After completing any code change on a non-main branch:

1. Push the branch to origin.
2. Open a PR via `mcp__github__create_pull_request` against `main` if one does not already exist for that branch.
3. Squash-merge the PR via `mcp__github__merge_pull_request` once it is mergeable. Do **not** wait for human review or comments. If CI checks exist, wait for them to pass; if there are no CI checks configured (current state), merge immediately.
4. Do not push directly to `main` — always go through a PR, even when auto-merging.

This standing authorization replaces the default "ask before pushing/merging" guidance for this repo.

## Commands

```bash
# Local dev (also installs deps + creates .env from .env.example + ensures data/)
bash scripts/setup-local-dev.sh

# Manual equivalents
npm install
npm run dev      # nodemon server/index.js
npm start        # node server/index.js
```

The app listens on `PORT` (default 3001) and serves both the API and the static frontend from the same Express process. There is no build step, no test suite, and no linter configured.

**Deployment: Mac Mini** — all apps run on Mac Mini (EC2 decommissioned).
- Host: `100.85.165.105`, SSH port `2323`, user `kiran`
- Repo path: `/Users/kiran/repos/fin-dashboard`
- Port: `3001`, PM2 name: `fin-dashboard`
- Pippy auto-deploys on every push to `main` via webhook → SSH → `npm install --production && pm2 restart fin-dashboard`
- Nginx at `/opt/homebrew/etc/nginx/servers/kirakon.conf` routes `fin.kirakon.com` → `localhost:3001`

Manual update:
```bash
ssh kiran@100.85.165.105 -p 2323
cd /Users/kiran/repos/fin-dashboard
git pull origin main && npm install --production && pm2 restart fin-dashboard
```

Default seeded admin (created automatically on first DB init): `kondetiudaykiran@gmail.com` / `Admin@123`.

## Architecture

**Single-process monolith.** `server/index.js` is the entry point: it mounts all `/api/*` routers, serves `public/` as static, and falls through to `public/index.html` for any non-API path (SPA catch-all). The frontend is one ~2800-line `public/index.html` file (vanilla JS + Chart.js via CDN) that talks to the same origin via `fetch('/api/...')` with `Authorization: Bearer <jwt>`.

**Auth model.** `server/middleware/auth.js` verifies a JWT (HS256, 7-day expiry, signed with `JWT_SECRET`) from the `Authorization: Bearer` header and attaches `req.user = { id, email, name }`. Most routers call `router.use(authMiddleware)` at the top, so every handler in that file is authenticated. Two exceptions:
- `POST /api/auth/login` — public
- `GET /api/vault/ca/:token` — public CA (chartered accountant) download link, gated by a one-off token row in `ca_access_tokens`. It is mounted directly in `server/index.js` *outside* the auth middleware as `vaultRoutes.caAccess` (a named export bolted onto the router); don't move it under the auth-protected `/api/vault` prefix.

**Database.** `server/db/database.js` opens a `better-sqlite3` handle (synchronous API, WAL mode, FK enforcement) at `DB_PATH`. On module load it runs `initializeDatabase()` (idempotent `CREATE TABLE IF NOT EXISTS`), `seedData()` (inserts a default user + sample portfolio only if the admin email isn't present), and `runMigrations()` (an array of "add this column if missing" `ALTER TABLE` statements — this is how new columns are introduced; append to the `migrations` array rather than editing existing `CREATE TABLE` statements). The exported `db` is a shared singleton. All routes use prepared statements via `db.prepare(...)`.

**Domain entities and routes.** Each financial concept gets its own table + router file:
- `server/routes/investments.js` — stocks (NSE/BSE), mutual_funds, fixed_deposits, us_stocks; also exposes `GET /prices` (Yahoo Finance proxy) and `GET /summary`
- `server/routes/liabilities.js` — credit_cards, loans
- `server/routes/loans.js` — `hand_loans` (informal IOUs, `direction` is `given|taken`)
- `server/routes/savings.js`, `insurance.js`, `nps.js`, `payments.js` (scheduled), `tax.js` (advance tax), `earnings.js`, `profiles.js`
- `server/routes/networth.js` — aggregates everything into a single `/api/networth` response, fetching live prices for stocks
- `server/routes/vault.js` — S3-backed document storage (see below)

The mounting in `server/index.js` is non-trivial: `savings`, `insurance`, and `nps` are all mounted under `/api/investments/*` (not their own top-level prefix), so changes to those routers must keep paths consistent with that nesting.

**Profiles.** Many tables (`savings_accounts`, `insurance_policies`, `nps_accounts`, `scheduled_payments`, `advance_tax_payments`, `earnings`, `vault_files`, `ca_access_tokens`) carry a nullable `profile_id`, letting one user partition data across personas (e.g. "Kiran" vs "Joint"). When filtering by profile, queries should typically include `(profile_id = ? OR profile_id IS NULL)` to keep shared rows visible — see `vault.js` `GET /files` for the canonical pattern.

**Live prices.** Stock and US-stock valuation is computed on the fly by proxying `https://query1.finance.yahoo.com/v8/finance/chart/{symbol}` server-side (see `fetchPrice`/`fetchYahooPrice` in `routes/networth.js` and `routes/investments.js`). Yahoo failure falls back to `avg_buy_price`. A hardcoded `usdInrRate = 84.0` is used for USD→INR conversion.

**S3 vault.** `server/services/s3.js` wraps `@aws-sdk/client-s3`. The upload flow is presigned-URL based, not server-proxied:
1. Client calls `POST /api/vault/upload-url` with filename + metadata.
2. Server calls `classifyDocument` (`services/smartRouter.js`) if no category was provided — keyword matching against filename+description, falling back to a `linkedType` map, falling back to `receipts/other`.
3. Server returns a presigned PUT URL keyed at `{userId}/p{profileId}/FY{YYYY-YY}/{category}/{subcategory}/{timestamp}-{safeFilename}`. `getFYFolder()` computes the Indian financial year (April–March), so a date in Jan 2026 lives under `FY2025-26`.
4. Client `PUT`s directly to S3, then calls `POST /api/vault/confirm-upload` to register the row in `vault_files`.
5. `ensureBucketExists` is called lazily on first upload — it creates the bucket, sets CORS, and applies a deny-public bucket policy scoped to `AWS_ACCOUNT_ID` if set.

If AWS env vars are missing, vault endpoints return `503` via the `requireS3` helper rather than crashing — preserve that behavior so the app still runs locally without S3.

**Slack notifications (outgoing only).** `server/services/slack.js` exposes `isSlackConfigured()` and `notify(message)` (string or `{text, blocks}` object) which POSTs to `SLACK_WEBHOOK_URL` (the kirakon app's incoming webhook). When the env var is unset, `notify()` returns `{ok: false, status: 503, ...}` rather than throwing — same graceful-degradation pattern as `services/s3.js`. The admin test surface is `server/routes/notifications.js` (`GET /slack/status`, `POST /slack/test`). No domain triggers are wired up yet — those land in a follow-up. Bidirectional Slack → server (event subscriptions, slash commands, signing-secret verification) requires a separate follow-up PR with bot token + signing secret.

**Local-first Claude agent.** `server/services/agent.js` is the single entry point for any LLM-backed feature: callers invoke `runTask({ userId, taskType, systemPrompt, userInput, maxTokens })` which proxies to the Anthropic SDK and writes one row to the `agent_calls` audit table per call (success or error). The module degrades gracefully like the vault — `isAgentConfigured()` mirrors `isS3Configured()`, and `getClient()` throws a descriptive error if `ANTHROPIC_API_KEY` is unset, so feature endpoints can guard with the same `requireAgent`-style 503 pattern. Privacy: only minimal task-specific context is sent to Anthropic, and full prompts are never persisted — the audit row stores a SHA-256 of (system+user) input plus a 200-char preview, plus token counts, latency, cost, and any error. Admin views at `GET /api/admin/agent-usage` and `GET /api/admin/agent-calls` (mounted in `server/index.js` under `authMiddleware`) read this table for cost/usage observability. New task types extend the `TASK_TYPES` enum in `agent.js`; new model prices go in the `PRICE_TABLE` constant in the same file.

**Gmail ingestion.** `server/services/gmailService.js` holds the OAuth2 flow, per-user token storage (`gmail_tokens`), message fetch (recursive part-walk capturing body + attachment metadata), `getMessageById`, and `downloadAttachmentText` (routes attachments through `services/textExtract.js` — PDF, image OCR, DOCX, XLSX). `server/routes/gmail.js` exposes `/status` (configured/connected/valid), `/auth-url`, `/connect`, `/callback`, `/disconnect`, `/poll`; the SPA surfaces a connect/reconnect banner off `/status`. Two consumers feed the DB from email: `scripts/gmail-poller.js` (PM2 cron → `scheduled_payments` via Ollama extraction) and the **Gmail MCP** at `mcp/gmail-mcp.mjs` — an MCP stdio server that lets an AI client read emails + attachments and write `scheduled_payments` / `transactions` (source `gmail-mcp`). The MCP reuses the UI-linked OAuth tokens, resolves the account via `MCP_GMAIL_USER_ID` → seeded admin → lowest id, and **must keep stdout pure JSON-RPC** (it reassigns `console.log`→stderr before requiring `database.js`, which logs on load). See `mcp/README.md`. Run: `npm run mcp:gmail`.

**Two `package.json` files.** The root `package.json` is the canonical one — it's what `npm install`, `npm run dev`, and `ecosystem.config.js` (`script: 'server/index.js'`) all use. `server/package.json` exists but is not installed by the deploy/dev flow; treat the root one as the source of truth for dependencies.

## Configuration

Environment variables (root `.env`, copied from `.env.example` on first setup):
- `PORT` (default 3001), `NODE_ENV`, `JWT_SECRET`, `DB_PATH` (default `./data/finance.db`)
- `CORS_ORIGIN` — passed to both Express CORS and the S3 bucket CORS rule
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME` (default `fin-kirakon-vault`), `AWS_ACCOUNT_ID`, `BASE_URL` — all optional; only required for vault features

`JWT_SECRET` and the production secret in `ecosystem.config.js` both have insecure fallback strings. Production secrets are expected to be set via the EC2 environment, not committed.

Production stack: PM2 (single instance, 512M memory cap) → Express on `localhost:3001` ← Nginx reverse proxy at `nginx/fin.kirakon.com.conf` with Let's Encrypt SSL provisioned by `deploy.sh`.

## Model & token economy (standing instruction)

Applies to every Claude session and agent workflow touching this repo:

- Be extremely conservative with tokens. No broad re-audits or exploratory sweeps when the task is already scoped — write prescriptive agent prompts and read only the files being changed.
- Route work by model tier: **Haiku** for mechanical checks/verification, **Sonnet** for routine implementation and styling, **Fable/Opus only where genuinely necessary** (complex new features, security-sensitive logic, hard conflict resolution).
- Keep agent fleets small: one well-briefed agent per app/module beats parallel audit swarms. Resume interrupted workflows from cache instead of re-running completed agents.
