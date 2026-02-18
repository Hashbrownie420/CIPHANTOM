#!/usr/bin/env bash
set -euo pipefail

SERVER_USER="${SERVER_USER:-ubuntu}"
SERVER_HOST="${SERVER_HOST:-130.61.157.46}"
SERVER_SSH="${SERVER_USER}@${SERVER_HOST}"
REMOTE_DIR="${REMOTE_DIR:-~/CIPHERPHANTOM}"
BRANCH="${BRANCH:-main}"

echo "[deploy] target=${SERVER_SSH} dir=${REMOTE_DIR} branch=${BRANCH}"

ssh "${SERVER_SSH}" "bash -lc '
  set -euo pipefail
  cd ${REMOTE_DIR}
  git fetch origin ${BRANCH}
  git pull --ff-only origin ${BRANCH}

  pm2 restart cipherphantom-bot || true
  pm2 restart cipherphantom-owner-app || true
  pm2 save

  pm2 status
  curl -s http://127.0.0.1:8787/api/healthz || true
'"

echo "[deploy] done"
