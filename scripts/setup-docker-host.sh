#!/usr/bin/env bash
# One-shot bootstrap to prep an EC2 host for Docker-based fin-dashboard.
# Idempotent — safe to re-run.
#
# What it does:
#   1. Installs Docker Engine + compose plugin (Ubuntu)
#   2. Adds the current user to the docker group (logout/in required once)
#   3. Logs Docker into ghcr.io if GHCR_TOKEN is provided
#   4. Pulls the latest image
#   5. Brings up the container via /var/www/fin-dashboard/docker-compose.yml
#
# Run on EC2:
#   GHCR_USER=udaykondeti GHCR_TOKEN=<github-PAT-with-read:packages> \
#     bash /var/www/fin-dashboard/scripts/setup-docker-host.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/fin-dashboard}"

echo "===== fin-dashboard Docker host bootstrap ====="

if ! command -v docker >/dev/null 2>&1; then
  echo "[1/5] Installing Docker Engine…"
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "[1/5] Docker already installed: $(docker --version)"
fi

if ! id -nG "$USER" | grep -qw docker; then
  echo "[2/5] Adding $USER to docker group (you'll need to log out + back in for this to take effect)…"
  sudo usermod -aG docker "$USER"
  NEEDS_RELOGIN=1
else
  echo "[2/5] $USER already in docker group"
fi

if [ -n "${GHCR_TOKEN:-}" ] && [ -n "${GHCR_USER:-}" ]; then
  echo "[3/5] Logging into ghcr.io as $GHCR_USER…"
  echo "$GHCR_TOKEN" | sudo docker login ghcr.io -u "$GHCR_USER" --password-stdin
else
  echo "[3/5] Skipped GHCR login (set GHCR_USER + GHCR_TOKEN env vars)."
  echo "       Required if the image is private."
fi

if [ -f "$APP_DIR/docker-compose.yml" ]; then
  echo "[4/5] Pulling latest image…"
  cd "$APP_DIR"
  sudo docker compose pull
  echo "[5/5] Starting container…"
  sudo docker compose up -d --remove-orphans
  echo
  echo "Container status:"
  sudo docker compose ps
else
  echo "[4-5/5] $APP_DIR/docker-compose.yml not found yet."
  echo "        It will be rsync'd by the next GitHub Actions deploy."
fi

if [ -n "${NEEDS_RELOGIN:-}" ]; then
  echo
  echo "⚠  You were just added to the docker group. Log out and back in"
  echo "   (exit + ssh again) before subsequent docker commands work without sudo."
fi

echo
echo "Done. Verify with:"
echo "  sudo docker compose -f $APP_DIR/docker-compose.yml ps"
echo "  curl -s http://localhost:3001/api/health"
