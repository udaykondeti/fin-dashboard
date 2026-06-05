#!/usr/bin/env bash
# update.sh — Pull latest from main and redeploy fin-dashboard.
#
# Self-bootstrapping: works whether you run it from a local git checkout, from
# /var/www/fin-dashboard, or from /. If a sibling source checkout exists at
# /var/www/fin-dashboard-src it is reused; otherwise it's cloned fresh.
set -euo pipefail

APP_DIR="/var/www/fin-dashboard"
SRC_DIR="/var/www/fin-dashboard-src"
REPO_URL="${REPO_URL:-https://github.com/udaykondeti/fin-dashboard.git}"
BRANCH="${BRANCH:-main}"

echo "===== fin-dashboard update ====="

# ── Resolve a source directory we can `git pull` in ──────────────────────────
# Preferred order:
#   1) The directory we were invoked from is itself a git checkout → use it.
#   2) /var/www/fin-dashboard-src is a checkout → pull there.
#   3) Otherwise, clone fresh into /var/www/fin-dashboard-src.
INVOKED_DIR="$(pwd)"
if [ -d "${INVOKED_DIR}/.git" ]; then
  SRC_DIR="${INVOKED_DIR}"
  echo "[1/4] Using existing git checkout at ${SRC_DIR}"
elif [ -d "${SRC_DIR}/.git" ]; then
  echo "[1/4] Using existing git checkout at ${SRC_DIR}"
else
  echo "[1/4] No git checkout found — cloning ${REPO_URL} into ${SRC_DIR}"
  sudo mkdir -p "$(dirname "$SRC_DIR")"
  sudo chown -R "$USER":"$(id -gn)" "$(dirname "$SRC_DIR")"
  git clone --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
fi

# ── Pull latest ──────────────────────────────────────────────────────────────
echo "[2/4] Pulling latest from origin/${BRANCH}..."
git -C "$SRC_DIR" fetch --quiet origin "$BRANCH"
git -C "$SRC_DIR" checkout --quiet "$BRANCH"
OLD_SHA=$(git -C "$SRC_DIR" rev-parse HEAD)
git -C "$SRC_DIR" pull --quiet --ff-only origin "$BRANCH"
HEAD_SHA=$(git -C "$SRC_DIR" rev-parse --short HEAD)
echo "  HEAD is now ${HEAD_SHA}"

# If this script itself changed in the pull, re-exec the new version so the
# rest of the deploy runs with the updated script (avoids stale-bash-buffer issues).
NEW_SHA=$(git -C "$SRC_DIR" rev-parse HEAD)
if [ "$OLD_SHA" != "$NEW_SHA" ] && git -C "$SRC_DIR" diff --name-only "$OLD_SHA" "$NEW_SHA" | grep -q "^scripts/update.sh$"; then
  echo "  update.sh changed — re-executing new version..."
  exec bash "${SRC_DIR}/scripts/update.sh"
fi

# ── Rsync into APP_DIR (excluding .git, node_modules, data, .env) ────────────
echo "[3/4] Rsyncing files to ${APP_DIR}..."
sudo mkdir -p "$APP_DIR"
sudo rsync -a \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='data' \
  --exclude='.env' \
  "${SRC_DIR}/" "${APP_DIR}/"
sudo chown -R "$USER":"$(id -gn)" "$APP_DIR"
echo "  Files synced."

cd "$APP_DIR"
echo "  Running npm install --production..."
npm install --production --silent
echo "  Dependencies up to date."

# ── Restart via PM2 with --update-env ────────────────────────────────────────
echo "[4/4] Restarting fin-dashboard via PM2..."
# --update-env so new vars in .env (JWT_SECRET, CORS_ORIGIN, GROQ_API_KEY) are
# picked up; plain `pm2 restart fin-dashboard` reuses the env captured at first
# start.
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
  echo "  ERROR: fin-dashboard is not online after restart. Recent logs:" >&2
  pm2 logs fin-dashboard --lines 30 --nostream || true
  exit 1
fi
echo "  fin-dashboard is online (HEAD ${HEAD_SHA})."

echo ""
echo "============================================================"
echo "  Update complete! App is running at https://fin.kirakon.com"
echo "============================================================"
