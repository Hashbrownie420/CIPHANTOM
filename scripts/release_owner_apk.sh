#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="${ROOT_DIR}/owner-app/android"
APK_LOCAL="${ANDROID_DIR}/app/build/outputs/apk/debug/app-debug.apk"

SERVER_USER="${SERVER_USER:-owner}"
SERVER_HOST="${SERVER_HOST:-}"
SERVER_SSH="${SERVER_USER}@${SERVER_HOST}"
REMOTE_DIR="${REMOTE_DIR:-~/CIPHERPHANTOM}"
SERVER_BASE_URL="${SERVER_BASE_URL:-}"

if [[ -z "${SERVER_HOST}" ]]; then
  echo "[release] SERVER_HOST ist leer. Beispiel: SERVER_HOST=dein-server.tld npm run release:owner-apk" >&2
  exit 1
fi

if [[ -z "${SERVER_BASE_URL}" ]]; then
  SERVER_BASE_URL="http://${SERVER_HOST}"
fi

echo "[release] building local APK"
cd "${ANDROID_DIR}"
./gradlew clean assembleDebug --no-daemon

if [[ ! -f "${APK_LOCAL}" ]]; then
  echo "[release] APK not found: ${APK_LOCAL}" >&2
  exit 1
fi

echo "[release] upload APK -> ${SERVER_SSH}:/tmp/app-debug.apk"
scp "${APK_LOCAL}" "${SERVER_SSH}:/tmp/app-debug.apk"

echo "[release] install APK on server and restart owner app"
ssh "${SERVER_SSH}" "bash -lc '
  set -euo pipefail
  cd ${REMOTE_DIR}
  mkdir -p owner-app/android/app/build/outputs/apk/debug
  mv /tmp/app-debug.apk owner-app/android/app/build/outputs/apk/debug/app-debug.apk

  cd owner-app/android
  sed -i \"s|^OWNER_APP_URL=.*|OWNER_APP_URL=${SERVER_BASE_URL}|\" local.properties || true
  sed -i \"s|^OWNER_UPDATE_URL=.*|OWNER_UPDATE_URL=${SERVER_BASE_URL}/api/app-meta|\" local.properties || true
  sed -i \"s|^OWNER_APP_FALLBACK_URL=.*|OWNER_APP_FALLBACK_URL=${SERVER_BASE_URL}|\" local.properties || true
  sed -i \"s|^OWNER_APK_DOWNLOAD_URL=.*|OWNER_APK_DOWNLOAD_URL=${SERVER_BASE_URL}/downloads/latest.apk|\" local.properties || true

  cd ..
  pm2 restart cipherphantom-owner-app || true
  pm2 save

  curl -s http://127.0.0.1:8787/api/app-meta || true
  curl -s -o /tmp/latest.apk -w \"\\nHTTP:%{http_code}\\n\" http://127.0.0.1:8787/downloads/latest.apk || true
'"

echo "[release] done"
