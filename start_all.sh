#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$ROOT_DIR"
OWNER_DIR="$ROOT_DIR/owner-app"

echo "[startup] Root: $ROOT_DIR"
echo "[startup] Host: $(hostname) | Kernel: $(uname -sr) | Node: $(node -v 2>/dev/null || echo 'n/a')"

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

echo "[2/2] Starte Owner App (direkt)..."
(
  cd "$OWNER_DIR"
  OWNER_APP_HOST="${OWNER_APP_HOST:-0.0.0.0}" OWNER_APP_PORT="${OWNER_APP_PORT:-8787}" node api/server.mjs
) &
OWNER_PID=$!

echo "Bot PID: $BOT_PID"
echo "OwnerApp PID: $OWNER_PID"
echo "Beenden mit CTRL+C"

wait -n $BOT_PID $OWNER_PID
