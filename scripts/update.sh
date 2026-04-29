#!/usr/bin/env bash
# update.sh — Quick update for fin-dashboard (run on EC2 from source directory)
set -euo pipefail

APP_DIR="/var/www/fin-dashboard"

echo "===== fin-dashboard update ====="

# ── Sync latest files ─────────────────────────────────────────────────────────
echo "[1/3] Syncing files to ${APP_DIR}..."
sudo rsync -a --exclude='.git' --exclude='node_modules' --exclude='data' \
  "$(pwd)/" "${APP_DIR}/"
sudo chown -R "$USER":"$USER" "$APP_DIR"
echo "  Files synced."

# ── Install dependencies ──────────────────────────────────────────────────────
echo "[2/3] Running npm install --production..."
cd "$APP_DIR"
npm install --production --silent
echo "  Dependencies up to date."

# ── Restart app ───────────────────────────────────────────────────────────────
echo "[3/3] Restarting fin-dashboard via PM2..."
pm2 restart fin-dashboard
pm2 save

echo ""
echo "============================================================"
echo "  Update complete! App is running at https://fin.kirakon.com"
echo "============================================================"
