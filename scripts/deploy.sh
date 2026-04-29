#!/usr/bin/env bash
# deploy.sh — Deploy fin-dashboard to EC2 Ubuntu 22.04
# Run this from /var/www/fin-dashboard on the EC2 instance
set -euo pipefail

APP_DIR="/var/www/fin-dashboard"
DOMAIN="fin.kirakon.com"
NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}.conf"

echo "===== fin-dashboard deploy ====="

# ── Node.js 20 ──────────────────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt 20 ]]; then
  echo "[1/8] Installing Node.js 20 via nvm..."
  export NVM_DIR="$HOME/.nvm"
  if [ ! -d "$NVM_DIR" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  fi
  # shellcheck source=/dev/null
  source "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
  nvm alias default 20
  # Make node/npm available to sudo / system
  NODE_BIN=$(nvm which 20)
  sudo ln -sf "$NODE_BIN" /usr/local/bin/node
  sudo ln -sf "$(dirname "$NODE_BIN")/npm" /usr/local/bin/npm
  echo "  Node.js $(node -v) installed."
else
  echo "[1/8] Node.js $(node -v) already installed — skipping."
fi

# ── PM2 ─────────────────────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  echo "[2/8] Installing PM2..."
  sudo npm install -g pm2
  echo "  PM2 $(pm2 -v) installed."
else
  echo "[2/8] PM2 $(pm2 -v) already installed — skipping."
fi

# ── Nginx ────────────────────────────────────────────────────────────────────
if ! command -v nginx &>/dev/null; then
  echo "[3/8] Installing Nginx..."
  sudo apt-get install -y nginx
  sudo systemctl enable nginx
  sudo systemctl start nginx
  echo "  Nginx installed."
else
  echo "[3/8] Nginx $(nginx -v 2>&1 | awk '{print $3}') already installed — skipping."
fi

# ── Copy app files ───────────────────────────────────────────────────────────
echo "[4/8] Copying app files to ${APP_DIR}..."
sudo mkdir -p "$APP_DIR"
# If running from a source checkout in a different location, rsync here.
# Assumes this script is already running from within the app directory.
sudo rsync -a --exclude='.git' --exclude='node_modules' --exclude='data' \
  "$(pwd)/" "${APP_DIR}/"
sudo chown -R "$USER":"$USER" "$APP_DIR"
echo "  Files copied."

# ── npm install ──────────────────────────────────────────────────────────────
echo "[5/8] Running npm install --production..."
cd "$APP_DIR"
npm install --production --silent
echo "  Dependencies installed."

# ── Data directory ───────────────────────────────────────────────────────────
echo "[6/8] Ensuring data directory exists..."
mkdir -p "${APP_DIR}/data"
echo "  ${APP_DIR}/data ready."

# ── Nginx config ─────────────────────────────────────────────────────────────
echo "[7/8] Configuring Nginx..."
sudo cp "${APP_DIR}/nginx/${DOMAIN}.conf" "$NGINX_CONF"
if [ ! -L "$NGINX_ENABLED" ]; then
  sudo ln -sf "$NGINX_CONF" "$NGINX_ENABLED"
fi
# Remove default site if present
if [ -L /etc/nginx/sites-enabled/default ]; then
  sudo rm /etc/nginx/sites-enabled/default
fi

# ── SSL / Certbot ─────────────────────────────────────────────────────────────
if ! command -v certbot &>/dev/null; then
  echo "  Certbot not found — installing..."
  sudo apt-get install -y certbot python3-certbot-nginx
fi

CERT_PATH="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
if [ ! -f "$CERT_PATH" ]; then
  echo "  No SSL cert found — running certbot for ${DOMAIN}..."
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    -m "kondetiudaykiran@gmail.com" --redirect
  echo "  SSL certificate obtained."
else
  echo "  SSL certificate already exists — skipping certbot."
fi

# ── PM2 start / restart ───────────────────────────────────────────────────────
echo "[8/8] Starting app with PM2..."
cd "$APP_DIR"
if pm2 list | grep -q 'fin-dashboard'; then
  pm2 restart ecosystem.config.js --update-env
else
  pm2 start ecosystem.config.js
fi
pm2 save

# Configure PM2 to start on boot (prints a command you should run as root)
PM2_STARTUP=$(pm2 startup | tail -n1 || true)
if [[ "$PM2_STARTUP" == sudo* ]]; then
  echo "  Running PM2 startup command..."
  eval "$PM2_STARTUP"
fi

# ── Nginx reload ─────────────────────────────────────────────────────────────
echo "Testing Nginx config..."
sudo nginx -t
sudo systemctl reload nginx

echo ""
echo "============================================================"
echo "  Deployment complete!"
echo "  Visit: https://${DOMAIN}"
echo "============================================================"
