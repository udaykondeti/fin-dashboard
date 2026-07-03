# fin-dashboard Gmail MCP

An MCP server that lets an AI client read the connected Gmail inbox — **emails
and their attachments** (PDF, image OCR, DOCX, XLSX, CSV) — and write the
results into fin-dashboard as recurring **scheduled payments** or one-off
**transactions**.

The AI does the reasoning (what's a bill, the amount, the date); this server
does the plumbing (Gmail fetch, attachment extraction, DB writes).

## Prerequisites

1. **Gmail connected in the UI.** Open fin.kirakon.com and use the *Connect
   Gmail* banner. That stores the OAuth tokens this MCP reuses. (Needs
   `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` in `.env` — a Web-application OAuth
   client with redirect URI `https://fin.kirakon.com/api/gmail/callback`.)
2. **Deps installed:** `npm install` in the repo root.

## Run / test

```bash
npm run mcp:gmail          # stdio server — an MCP client spawns it
```

It waits silently for a client on stdin — that's correct for an MCP server.

## Register with a client

**Claude Desktop / mcphost / generic** — add to the client's MCP config:

```json
{
  "mcpServers": {
    "fin-gmail": {
      "command": "node",
      "args": ["mcp/gmail-mcp.mjs"],
      "cwd": "/Users/kiran/repos/fin-dashboard",
      "env": { "NODE_ENV": "production" }
    }
  }
}
```

`bash mcp/setup-gmail-mcp.sh` prints this snippet with absolute paths filled in.

## Which account it acts for

Resolved in order: `MCP_GMAIL_USER_ID` env → the seeded admin
(`kondetiudaykiran@gmail.com`) → the lowest user id.

## Tools

| Tool | What it does |
|------|--------------|
| `gmail_status` | Is Gmail configured / connected / credentials still valid |
| `search_finance_emails` | Find bill/invoice/statement emails (metadata + which attachments each has) |
| `read_email` | Full body **+ extracted attachment text** for one message |
| `add_scheduled_payment` | Upsert a recurring bill (dedup by name) |
| `add_transaction` | Insert a one-off transaction (dedup by Gmail messageId) |
| `list_scheduled_payments` | Read back existing recurring payments |

## Typical flow the AI runs

1. `search_finance_emails({ days: 14 })`
2. `read_email({ messageId })` — inspect body + attachment text
3. `add_scheduled_payment({ … })` or `add_transaction({ …, source_ref: messageId })`
4. `list_scheduled_payments()` to confirm

Writes land in the same SQLite DB the dashboard serves, so they show up
immediately at fin.kirakon.com.
