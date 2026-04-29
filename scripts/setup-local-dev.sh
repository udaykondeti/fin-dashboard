#!/usr/bin/env bash
# setup-local-dev.sh — Set up local development environment
set -euo pipefail

echo "===== fin-dashboard local dev setup ====="

# ── Check Node.js ─────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "Node.js is not installed. Please install Node.js 20+ from https://nodejs.org"
  exit 1
fi
echo "[check] Node.js $(node -v) found."

# ── Install dependencies ──────────────────────────────────────────────────────
echo "[1/3] Installing dependencies..."
npm install
echo "  Dependencies installed."

# ── Copy .env ─────────────────────────────────────────────────────────────────
echo "[2/3] Setting up .env..."
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo "  .env created from .env.example — edit it before running."
  else
    echo "  WARNING: .env.example not found; skipping .env creation."
  fi
else
  echo "  .env already exists — skipping."
fi

# ── Ensure data directory ─────────────────────────────────────────────────────
mkdir -p data
echo "[3/3] data/ directory ready."

# ── Start dev server ──────────────────────────────────────────────────────────
echo ""
echo "Starting development server..."
echo "Visit: http://localhost:3001"
echo "(Press Ctrl+C to stop)"
echo ""

if npm run | grep -q '"dev"'; then
  npm run dev
else
  node server/index.js
fi
