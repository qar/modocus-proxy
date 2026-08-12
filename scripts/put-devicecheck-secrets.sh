#!/usr/bin/env bash
# Put Apple DeviceCheck secrets on the Cloudflare Worker (prod and optional staging).
#
# Prerequisites (from developer.apple.com → Certificates, Identifiers & Profiles → Keys):
#   1. Create a key with DeviceCheck enabled; download AuthKey_<KEY_ID>.p8 once.
#   2. Note Key ID and Team ID (Membership details).
#
# Usage:
#   export DEVICECHECK_KEY_ID=XXXXXXXXXX
#   export APPLE_TEAM_ID=XXXXXXXXXX          # e.g. from Membership
#   export DEVICECHECK_KEY_P8_PATH=./AuthKey_XXXXXXXXXX.p8
#   bash scripts/put-devicecheck-secrets.sh           # production
#   bash scripts/put-devicecheck-secrets.sh --staging # also staging
set -euo pipefail
cd "$(dirname "$0")/.."

STAGING=0
[[ "${1:-}" == "--staging" ]] && STAGING=1

: "${DEVICECHECK_KEY_ID:?set DEVICECHECK_KEY_ID}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID (10-char Team ID)}"
: "${DEVICECHECK_KEY_P8_PATH:?set DEVICECHECK_KEY_P8_PATH to the .p8 file}"

[[ -f "$DEVICECHECK_KEY_P8_PATH" ]] || { echo "missing $DEVICECHECK_KEY_P8_PATH" >&2; exit 1; }

put_one() {
  local env_flag="${1:-}"
  echo "→ DEVICECHECK_KEY_ID$env_flag"
  printf '%s' "$DEVICECHECK_KEY_ID" | npx wrangler secret put DEVICECHECK_KEY_ID $env_flag
  echo "→ APPLE_TEAM_ID$env_flag"
  printf '%s' "$APPLE_TEAM_ID" | npx wrangler secret put APPLE_TEAM_ID $env_flag
  echo "→ DEVICECHECK_KEY_P8$env_flag"
  # shellcheck disable=SC2002
  cat "$DEVICECHECK_KEY_P8_PATH" | npx wrangler secret put DEVICECHECK_KEY_P8 $env_flag
}

echo "Putting DeviceCheck secrets on production…"
put_one ""
if [[ "$STAGING" -eq 1 ]]; then
  echo "Putting DeviceCheck secrets on staging…"
  put_one "--env staging"
fi

echo "Verify: curl -sS https://ai.modocus.app/health | jq .deviceCheck"
echo "Expect: {\"configured\":true}"
