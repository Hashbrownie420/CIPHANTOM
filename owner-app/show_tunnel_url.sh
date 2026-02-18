#!/usr/bin/env bash
set -euo pipefail
URL_FILE="${OWNER_TUNNEL_URL_FILE:-$(cd "$(dirname "$0")" && pwd)/tunnel_url.txt}"
if [[ -s "$URL_FILE" ]]; then
  cat "$URL_FILE"
else
  echo "Keine Tunnel-URL gefunden. Starte zuerst ./start_remote.sh oder PM2-Prozess neu."
  exit 1
fi
