#!/usr/bin/env bash
# ec2-first-time-setup.sh — Run once on a brand-new EC2 Ubuntu 22.04 instance
# Usage: bash scripts/ec2-first-time-setup.sh
set -euo pipefail

echo "===== EC2 first-time setup for fin-dashboard ====="
echo "Running as: $(whoami) on $(lsb_release -ds 2>/dev/null || uname -s)"
echo ""

# ── System update ─────────────────────────────────────────────────────────────
echo "[1/7] Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y curl gnupg ca-certificates lsb-release git unzip
echo "  System up to date."

# ── Node.js 20 via NodeSource ─────────────────────────────────────────────────
echo "[2/7] Installing Node.js 20..."
if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d 'v')" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "  Node.js $(node -v) installed."
else
  echo "  Node.js $(node -v) already installed — skipping."
fi

# ── PM2 ──────────────────────────────────────────────────────────────────────
echo "[3/7] Installing PM2 globally..."
if ! command -v pm2 &>/dev/null; then
  sudo npm install -g pm2
  echo "  PM2 $(pm2 -v) installed."
else
  echo "  PM2 $(pm2 -v) already installed — skipping."
fi

# ── Nginx ────────────────────────────────────────────────────────────────────
echo "[4/7] Installing Nginx..."
if ! command -v nginx &>/dev/null; then
  sudo apt-get install -y nginx
  sudo systemctl enable nginx
  sudo systemctl start nginx
  echo "  Nginx installed and started."
else
  echo "  Nginx already installed — skipping."
fi

# ── Certbot ──────────────────────────────────────────────────────────────────
echo "[5/7] Installing Certbot..."
if ! command -v certbot &>/dev/null; then
  sudo apt-get install -y certbot python3-certbot-nginx
  echo "  Certbot installed."
else
  echo "  Certbot already installed — skipping."
fi

# ── App directory ─────────────────────────────────────────────────────────────
echo "[6/7] Creating /var/www/fin-dashboard..."
sudo mkdir -p /var/www/fin-dashboard/data
sudo chown -R ubuntu:ubuntu /var/www/fin-dashboard
echo "  Directory ready."

# ── Firewall (ufw) ────────────────────────────────────────────────────────────
echo "[7/7] Configuring firewall (ufw)..."
sudo ufw allow 22/tcp   comment 'SSH'
sudo ufw allow 80/tcp   comment 'HTTP'
sudo ufw allow 443/tcp  comment 'HTTPS'
# Enable ufw non-interactively only if not already active
if ! sudo ufw status | grep -q "Status: active"; then
  sudo ufw --force enable
fi
sudo ufw status
echo "  Firewall configured."

echo ""
echo "============================================================"
echo "  EC2 first-time setup complete!"
echo ""
echo "  Next step — copy your app files from your Mac:"
echo "    rsync -avz --exclude node_modules --exclude .git \\"
echo "      fin-dashboard/ ubuntu@YOUR_EC2_IP:/var/www/fin-dashboard/"
echo ""
echo "  Then on this EC2 instance, run:"
echo "    cd /var/www/fin-dashboard"
echo "    bash scripts/deploy.sh"
echo "============================================================"
