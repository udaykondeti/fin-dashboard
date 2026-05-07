#!/usr/bin/env bash
# Configure AWS credentials for the Vault feature. Idempotent: existing keys
# are kept (script will skip lines already in .env) and PM2 is restarted with
# --update-env so the running process picks up the new values.
#
# Run on EC2:
#   bash scripts/setup-aws-env.sh

set -e

ENV_FILE="${ENV_FILE:-/var/www/fin-dashboard/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Run from EC2 in the deployed app dir."
  exit 1
fi

prompt_or_keep() {
  local key="$1"
  local existing
  existing=$(grep "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2-)
  if [ -n "$existing" ]; then
    echo "  ${key} already set (keeping existing value)"
    return 0
  fi
  read -rp "  ${key}: " value
  if [ -n "$value" ]; then
    echo "${key}=${value}" | sudo tee -a "$ENV_FILE" >/dev/null
    echo "    appended."
  else
    echo "    skipped (empty input)."
  fi
}

echo "Configuring AWS env vars in ${ENV_FILE}"
echo "Existing values are kept. Press Enter to skip a key."
echo

prompt_or_keep AWS_REGION
prompt_or_keep AWS_ACCESS_KEY_ID
prompt_or_keep AWS_SECRET_ACCESS_KEY
prompt_or_keep S3_BUCKET_NAME

echo
echo "Restarting PM2 with --update-env..."
pm2 restart fin-dashboard --update-env
echo
echo "Done. Verify with:"
echo "  curl -s http://localhost:3001/api/health/config"
