#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$ROOT_DIR"
OWNER_DIR="$ROOT_DIR/owner-app"

cleanup() {
  jobs -pr | xargs -r kill >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "[1/2] Starte Bot..."
(
  cd "$BOT_DIR"
  npm start
) &
BOT_PID=$!

echo "[2/2] Starte Owner Remote (App + Tunnel)..."
(
  cd "$OWNER_DIR"
  export OWNER_AUTO_IP="${OWNER_AUTO_IP:-1}"
  export OWNER_LOCAL_IP="${OWNER_LOCAL_IP:-}"
  export OWNER_APP_FALLBACK_URL="${OWNER_APP_FALLBACK_URL:-}"
  export OWNER_UPDATE_URL="${OWNER_UPDATE_URL:-}"
  export OWNER_CF_TUNNEL_TOKEN="${OWNER_CF_TUNNEL_TOKEN:-}"
  export OWNER_PUBLIC_URL="${OWNER_PUBLIC_URL:-}"
  export OWNER_TUNNEL_PROVIDER="${OWNER_TUNNEL_PROVIDER:-cloudflared}"
  export OWNER_NGROK_AUTHTOKEN="${OWNER_NGROK_AUTHTOKEN:-}"
  export OWNER_NGROK_DOMAIN="${OWNER_NGROK_DOMAIN:-}"
  ./start_remote.sh
) &
OWNER_PID=$!

echo "Bot PID: $BOT_PID"
echo "OwnerRemote PID: $OWNER_PID"
echo "Beenden mit CTRL+C"

wait -n $BOT_PID $OWNER_PID
