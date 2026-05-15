#!/usr/bin/env bash
# Bootstrap a Mac Mini to run fin-dashboard via Docker Desktop, with a
# local Ollama model powering the agent and a Cloudflare Tunnel for
# public access. Idempotent — safe to re-run.
#
# Prerequisites you install manually (one-time, GUI):
#   - Docker Desktop for Mac      https://docker.com/products/docker-desktop
#   - Ollama                      https://ollama.com/download
#
# Then run:
#   bash scripts/setup-mac-host.sh
#
# Required files in APP_DIR before the container can start:
#   .env             — app secrets (JWT_SECRET, AWS_*, etc.)
#                      MUST include: OLLAMA_BASE_URL=http://host.docker.internal:11434/v1
#   cloudflared.env  — TUNNEL_TOKEN=<token from Cloudflare Zero Trust dashboard>
#   data/            — created automatically; holds finance.db

set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/fin-dashboard}"
OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.1:8b}"
COMPOSE_FILE="$APP_DIR/docker-compose.mac.yml"

echo "===== fin-dashboard Mac Mini bootstrap ====="
echo "APP_DIR = $APP_DIR"
mkdir -p "$APP_DIR/data"

# ── 1. Docker ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker not found. Install Docker Desktop for Mac first:"
  echo "       https://docker.com/products/docker-desktop"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon not running. Start Docker Desktop and re-run."
  exit 1
fi
echo "[1/5] Docker OK — $(docker --version)"

# ── 2. Ollama ────────────────────────────────────────────────────────────────
if ! command -v ollama >/dev/null 2>&1; then
  echo "ERROR: Ollama not found. Install from https://ollama.com/download"
  exit 1
fi
# Pull the model if it isn't local yet
if ! ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$OLLAMA_MODEL"; then
  echo "[2/5] Pulling Ollama model $OLLAMA_MODEL (first run, may take a few min)…"
  ollama pull "$OLLAMA_MODEL"
else
  echo "[2/5] Ollama model $OLLAMA_MODEL already present"
fi
# Quick reachability check on the OpenAI-compatible endpoint
if curl -fsS http://localhost:11434/v1/models >/dev/null 2>&1; then
  echo "      Ollama API reachable at localhost:11434"
else
  echo "      WARN: localhost:11434 not responding — make sure 'ollama serve' is running."
fi

# ── 3. Required config files ─────────────────────────────────────────────────
MISSING=0
if [ ! -f "$APP_DIR/.env" ]; then
  echo "[3/5] MISSING: $APP_DIR/.env"
  echo "      Create it with at least JWT_SECRET and:"
  echo "        OLLAMA_BASE_URL=http://host.docker.internal:11434/v1"
  echo "        OLLAMA_MODEL=$OLLAMA_MODEL"
  MISSING=1
fi
if [ ! -f "$APP_DIR/cloudflared.env" ]; then
  echo "[3/5] MISSING: $APP_DIR/cloudflared.env"
  echo "      Create it with: TUNNEL_TOKEN=<token from Cloudflare Zero Trust>"
  echo "      Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create a tunnel"
  echo "      → route fin.kirakon.com to http://fin-dashboard:3001"
  MISSING=1
fi
[ "$MISSING" = "1" ] && { echo; echo "Create the files above, then re-run."; exit 1; }
echo "[3/5] .env + cloudflared.env present"

# ── 4. Compose file ──────────────────────────────────────────────────────────
if [ ! -f "$COMPOSE_FILE" ]; then
  echo "[4/5] ERROR: $COMPOSE_FILE not found. Copy it from the repo to $APP_DIR."
  exit 1
fi
echo "[4/5] Compose file present"

# ── 5. Pull + up ─────────────────────────────────────────────────────────────
echo "[5/5] Pulling image + starting containers…"
cd "$APP_DIR"
APP_DIR="$APP_DIR" OLLAMA_MODEL="$OLLAMA_MODEL" docker compose -f "$COMPOSE_FILE" pull
APP_DIR="$APP_DIR" OLLAMA_MODEL="$OLLAMA_MODEL" docker compose -f "$COMPOSE_FILE" up -d --remove-orphans

echo
APP_DIR="$APP_DIR" docker compose -f "$COMPOSE_FILE" ps
echo
echo "Done. Verify:"
echo "  curl -s http://localhost:3001/api/health"
echo "  curl -s http://localhost:3001/api/health/config   # check 'local' shows configured"
echo "  open https://fin.kirakon.com                       # via Cloudflare Tunnel"
