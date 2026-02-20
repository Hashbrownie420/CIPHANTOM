#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="${ROOT_DIR}/owner-app/android"
APK_BUILD_TASK="${APK_BUILD_TASK:-assembleDebug}" # assembleDebug|assembleRelease

SERVER_USER="${SERVER_USER:-owner}"
SERVER_HOST="${SERVER_HOST:-}"
SERVER_SSH="${SERVER_USER}@${SERVER_HOST}"
REMOTE_DIR="${REMOTE_DIR:-~/CIPHERPHANTOM}"
SERVER_BASE_URL="${SERVER_BASE_URL:-}"
DEPLOY_MODE="${DEPLOY_MODE:-auto}" # auto|docker|pm2

if [[ "${APK_BUILD_TASK}" == "assembleRelease" ]]; then
  APK_LOCAL="${ANDROID_DIR}/app/build/outputs/apk/release/app-release.apk"
else
  APK_LOCAL="${ANDROID_DIR}/app/build/outputs/apk/debug/app-debug.apk"
fi

if [[ -z "${SERVER_HOST}" ]]; then
  echo "[release] SERVER_HOST ist leer. Beispiel: SERVER_HOST=dein-server.tld npm run release:owner-apk" >&2
  exit 1
fi

if [[ -z "${SERVER_BASE_URL}" ]]; then
  SERVER_BASE_URL="http://${SERVER_HOST}"
fi

VERSION_CODE="$(
  awk -F= '/^OWNER_APK_VERSION_CODE=/{print $2}' "${ANDROID_DIR}/local.properties" \
    | tail -n 1 \
    | tr -d '\r' \
    | xargs || true
)"
VERSION_NAME="$(
  awk -F= '/^OWNER_APP_VERSION_NAME=/{print $2}' "${ANDROID_DIR}/local.properties" \
    | tail -n 1 \
    | tr -d '\r' \
    | xargs || true
)"
if [[ -z "${VERSION_CODE}" ]]; then VERSION_CODE="1"; fi
if [[ -z "${VERSION_NAME}" ]]; then VERSION_NAME="1.0.${VERSION_CODE}"; fi

echo "[release] building local APK task=${APK_BUILD_TASK} versionCode=${VERSION_CODE} versionName=${VERSION_NAME}"
cd "${ANDROID_DIR}"
./gradlew clean "${APK_BUILD_TASK}" --no-daemon

if [[ ! -f "${APK_LOCAL}" ]]; then
  echo "[release] APK not found: ${APK_LOCAL}" >&2
  exit 1
fi

echo "[release] upload APK -> ${SERVER_SSH}:/tmp/app-debug.apk"
scp "${APK_LOCAL}" "${SERVER_SSH}:/tmp/app-debug.apk"

echo "[release] install APK on server and reload owner app"
ssh "${SERVER_SSH}" \
  "REMOTE_DIR='${REMOTE_DIR}' SERVER_BASE_URL='${SERVER_BASE_URL}' VERSION_CODE='${VERSION_CODE}' VERSION_NAME='${VERSION_NAME}' DEPLOY_MODE='${DEPLOY_MODE}' bash -s" <<'EOF'
set -euo pipefail
cd "${REMOTE_DIR}"

mkdir -p data/releases
install -m 0644 /tmp/app-debug.apk data/releases/latest.apk
rm -f /tmp/app-debug.apk

if [[ -f owner-app/android/local.properties ]]; then
  cd owner-app/android
  sed -i "s|^OWNER_APP_URL=.*|OWNER_APP_URL=${SERVER_BASE_URL}|" local.properties || true
  sed -i "s|^OWNER_UPDATE_URL=.*|OWNER_UPDATE_URL=${SERVER_BASE_URL}/api/app-meta|" local.properties || true
  sed -i "s|^OWNER_APP_FALLBACK_URL=.*|OWNER_APP_FALLBACK_URL=${SERVER_BASE_URL}|" local.properties || true
  sed -i "s|^OWNER_APK_DOWNLOAD_URL=.*|OWNER_APK_DOWNLOAD_URL=${SERVER_BASE_URL}/downloads/latest.apk|" local.properties || true
  if grep -q '^OWNER_APK_VERSION_CODE=' local.properties; then
    sed -i "s|^OWNER_APK_VERSION_CODE=.*|OWNER_APK_VERSION_CODE=${VERSION_CODE}|" local.properties
  else
    echo "OWNER_APK_VERSION_CODE=${VERSION_CODE}" >> local.properties
  fi
  if grep -q '^OWNER_APP_VERSION_NAME=' local.properties; then
    sed -i "s|^OWNER_APP_VERSION_NAME=.*|OWNER_APP_VERSION_NAME=${VERSION_NAME}|" local.properties
  else
    echo "OWNER_APP_VERSION_NAME=${VERSION_NAME}" >> local.properties
  fi
  cd "${REMOTE_DIR}"
fi

use_docker="0"
if [[ "${DEPLOY_MODE}" == "docker" ]]; then
  use_docker="1"
elif [[ "${DEPLOY_MODE}" == "auto" ]] && command -v docker >/dev/null 2>&1 && [[ -f "docker-compose.yml" ]]; then
  use_docker="1"
fi

if [[ "${use_docker}" == "1" ]]; then
  docker compose up -d owner-app
else
  pm2 restart cipherphantom-owner-app || true
  pm2 save || true
fi

curl -s http://127.0.0.1:8787/api/app-meta || true
curl -s -o /tmp/latest.apk -w "\nHTTP:%{http_code}\n" http://127.0.0.1:8787/downloads/latest.apk || true
ls -lh data/releases/latest.apk || true
EOF

echo "[release] done"
