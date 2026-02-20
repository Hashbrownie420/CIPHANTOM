#!/usr/bin/env bash
set -euo pipefail

SERVER_USER="${SERVER_USER:-owner}"
SERVER_HOST="${SERVER_HOST:-}"
SERVER_SSH="${SERVER_USER}@${SERVER_HOST}"
REMOTE_DIR="${REMOTE_DIR:-~/CIPHERPHANTOM}"
BRANCH="${BRANCH:-main}"
DEPLOY_MODE="${DEPLOY_MODE:-auto}" # auto|docker|pm2

if [[ -z "${SERVER_HOST}" ]]; then
  echo "[deploy] SERVER_HOST ist leer. Beispiel: SERVER_HOST=dein-server.tld npm run deploy:server" >&2
  exit 1
fi

echo "[deploy] target=${SERVER_SSH} dir=${REMOTE_DIR} branch=${BRANCH} mode=${DEPLOY_MODE}"

ssh "${SERVER_SSH}" \
  "REMOTE_DIR='${REMOTE_DIR}' BRANCH='${BRANCH}' DEPLOY_MODE='${DEPLOY_MODE}' bash -s" <<'EOF'
set -euo pipefail

cd "${REMOTE_DIR}"
git fetch origin "${BRANCH}"
git pull --ff-only origin "${BRANCH}"

use_docker="0"
if [[ "${DEPLOY_MODE}" == "docker" ]]; then
  use_docker="1"
elif [[ "${DEPLOY_MODE}" == "auto" ]] && command -v docker >/dev/null 2>&1 && [[ -f "docker-compose.yml" ]]; then
  use_docker="1"
fi

if [[ "${use_docker}" == "1" ]]; then
  echo "[deploy] docker mode"
  docker compose up -d --build
  docker compose ps
else
  echo "[deploy] pm2 mode"
  pm2 restart cipherphantom-bot || true
  pm2 restart cipherphantom-owner-app || true
  pm2 save || true
  pm2 status || true
fi

curl -s http://127.0.0.1:8787/api/healthz || true
EOF

echo "[deploy] done"
