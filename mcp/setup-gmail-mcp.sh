#!/usr/bin/env bash
# Print the MCP client config for the fin-dashboard Gmail MCP, with absolute
# paths filled in. Paste the JSON into your MCP client (Claude Desktop,
# mcphost, Open WebUI, …).
#
# Usage: bash mcp/setup-gmail-mcp.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
NODE_BIN="$(command -v node || echo node)"

echo "=== fin-dashboard Gmail MCP ==="
echo ""
echo "Entry point:      node mcp/gmail-mcp.mjs"
echo "Working dir:      $REPO_DIR"
echo "Node:             $NODE_BIN"
echo ""

if [ ! -d "$REPO_DIR/node_modules/@modelcontextprotocol" ]; then
  echo "⚠  MCP SDK not installed. Run:  (cd \"$REPO_DIR\" && npm install)"
  echo ""
fi

echo "=== Client config snippet ==="
cat <<EOF
{
  "mcpServers": {
    "fin-gmail": {
      "command": "$NODE_BIN",
      "args": ["$REPO_DIR/mcp/gmail-mcp.mjs"],
      "cwd": "$REPO_DIR",
      "env": { "NODE_ENV": "production" }
    }
  }
}
EOF

echo ""
echo "=== Tools ==="
echo "  gmail_status             — configured / connected / credentials valid"
echo "  search_finance_emails    — find bill/invoice/statement emails"
echo "  read_email               — full body + extracted attachment text"
echo "  add_scheduled_payment    — upsert a recurring bill"
echo "  add_transaction          — insert a one-off transaction (dedup by messageId)"
echo "  list_scheduled_payments  — read back existing recurring payments"
echo ""
echo "Prereq: connect Gmail once via the fin.kirakon.com UI banner (stores the OAuth tokens this MCP reuses)."
echo ""
echo "Test directly:"
echo "  cd \"$REPO_DIR\" && npm run mcp:gmail"
