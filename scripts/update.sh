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
# Use ecosystem.config.js + --update-env so new variables in .env (e.g.
# JWT_SECRET, CORS_ORIGIN) are picked up. Plain `pm2 restart fin-dashboard`
# would re-use the env captured when PM2 first started the process.
cd "$APP_DIR"
if pm2 list | grep -q 'fin-dashboard'; then
  pm2 restart ecosystem.config.js --update-env
else
  pm2 start ecosystem.config.js
fi
pm2 save

# Health check — confirm the process actually came back up. If JWT_SECRET is
# missing the app now refuses to boot, so a silent crash-loop must surface here.
sleep 2
if ! pm2 describe fin-dashboard | grep -qE 'status\s+\│\s+online'; then
  echo "  ERROR: fin-dashboard is not online after restart. Recent logs:"
  pm2 logs fin-dashboard --lines 30 --nostream || true
  exit 1
fi
echo "  fin-dashboard is online."

echo ""
echo "============================================================"
echo "  Update complete! App is running at https://fin.kirakon.com"
echo "============================================================"
