#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="${OWNER_RUNTIME_DIR:-${SCRIPT_DIR}/runtime}"
LOG_DIR="${OWNER_LOG_DIR:-${RUNTIME_DIR}/logs}"
mkdir -p "${LOG_DIR}"

PORT="${OWNER_APP_PORT:-8787}"
HOST="${OWNER_APP_HOST:-0.0.0.0}"
URL_FILE="${OWNER_TUNNEL_URL_FILE:-${SCRIPT_DIR}/tunnel_url.txt}"
ANDROID_LOCAL_PROPERTIES="${OWNER_ANDROID_LOCAL_PROPERTIES:-${SCRIPT_DIR}/android/local.properties}"
HEALTH_HOST="${HOST}"
if [[ "${HOST}" == "0.0.0.0" ]]; then
  HEALTH_HOST="127.0.0.1"
fi
LOCAL_HEALTH_URL="http://${HEALTH_HOST}:${PORT}/api/healthz"
TUNNEL_TARGET_URL="http://${HEALTH_HOST}:${PORT}"
AUTO_IP="${OWNER_AUTO_IP:-1}"
MANUAL_LOCAL_IP="${OWNER_LOCAL_IP:-}"
MANUAL_FALLBACK_URL="${OWNER_APP_FALLBACK_URL:-}"
HOTSPOT_MODE="${OWNER_HOTSPOT_MODE:-1}"
CF_TUNNEL_TOKEN="${OWNER_CF_TUNNEL_TOKEN:-}"
PUBLIC_URL="${OWNER_PUBLIC_URL:-}"
TUNNEL_PROVIDER="${OWNER_TUNNEL_PROVIDER:-cloudflared}"
NGROK_AUTHTOKEN="${OWNER_NGROK_AUTHTOKEN:-}"
NGROK_DOMAIN="${OWNER_NGROK_DOMAIN:-}"
AUTO_VERSION_ON_RESTART="${OWNER_AUTO_VERSION_ON_RESTART:-1}"
VERSION_STATE_FILE="${OWNER_VERSION_STATE_FILE:-${SCRIPT_DIR}/.owner_version_state}"
VERSION_SNAPSHOT_FILE="${OWNER_VERSION_SNAPSHOT_FILE:-${SCRIPT_DIR}/.owner_version_snapshot.tsv}"
APP_LOG_FILE="${OWNER_APP_LOG_FILE:-${LOG_DIR}/owner-app.log}"
NGROK_LOG_FILE="${OWNER_NGROK_LOG_FILE:-${LOG_DIR}/ngrok.log}"

detect_local_ip() {
  ip route get 1.1.1.1 2>/dev/null | awk '{
    for (i = 1; i <= NF; i++) {
      if ($i == "src") {
        print $(i+1);
        exit;
      }
    }
  }'
}

upsert_prop() {
  local file="$1"
  local key="$2"
  local value="$3"
  if grep -q "^${key}=" "${file}" 2>/dev/null; then
    sed -i "s|^${key}=.*$|${key}=${value}|" "${file}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
}

get_prop() {
  local file="$1"
  local key="$2"
  if [[ ! -f "${file}" ]]; then
    return 0
  fi
  awk -F'=' -v key="${key}" '$1 == key { print substr($0, index($0, "=") + 1); exit }' "${file}" | tr -d '\r'
}

bump_apk_version() {
  local file="$1"
  local bump_type="${2:-patch}"
  if [[ "${bump_type}" == "none" || "${bump_type}" == "off" || "${bump_type}" == "noop" ]]; then
    local current_noop
    current_noop="$(get_prop "${file}" "OWNER_APK_VERSION_CODE")"
    if [[ ! "${current_noop}" =~ ^[0-9]+$ ]]; then
      current_noop=1
      upsert_prop "${file}" "OWNER_APK_VERSION_CODE" "${current_noop}"
    fi
    echo "[owner-remote] APK-Version unverändert (bump=${bump_type}): ${current_noop}"
    return 0
  fi
  local current
  current="$(get_prop "${file}" "OWNER_APK_VERSION_CODE")"
  if [[ ! "${current}" =~ ^[0-9]+$ ]]; then
    current=1
  fi
  local major=$((current / 10000))
  local minor=$(((current % 10000) / 100))
  local patch=$((current % 100))
  case "${bump_type}" in
    major)
      major=$((major + 1))
      minor=0
      patch=0
      ;;
    minor)
      minor=$((minor + 1))
      patch=0
      if (( minor > 99 )); then
        major=$((major + 1))
        minor=0
      fi
      ;;
    *)
      patch=$((patch + 1))
      if (( patch > 99 )); then
        patch=0
        minor=$((minor + 1))
        if (( minor > 99 )); then
          major=$((major + 1))
          minor=0
        fi
      fi
      bump_type="patch"
      ;;
  esac
  local next=$((major * 10000 + minor * 100 + patch))
  upsert_prop "${file}" "OWNER_APK_VERSION_CODE" "${next}"
  echo "[owner-remote] APK-Version erhöht (${bump_type}): ${current} -> ${next}"
}

compute_owner_fingerprint() {
  local d
  d="$(mktemp -d)"
  local list="${d}/files.list"
  find \
    "${SCRIPT_DIR}/api" \
    "${SCRIPT_DIR}/web" \
    "${SCRIPT_DIR}/android/app/src" \
    "${SCRIPT_DIR}/android/app/build.gradle.kts" \
    "${SCRIPT_DIR}/android/build.gradle.kts" \
    "${SCRIPT_DIR}/package.json" \
    -type f 2>/dev/null \
    ! -path "*/build/*" \
    -print | sort > "${list}"
  if [[ ! -s "${list}" ]]; then
    rm -rf "${d}"
    echo ""
    return 0
  fi
  local fp
  fp="$(xargs -r sha1sum < "${list}" | sha1sum | awk '{print $1}')"
  rm -rf "${d}"
  echo "${fp}"
}

build_owner_snapshot() {
  local out_file="$1"
  : > "${out_file}"
  find \
    "${SCRIPT_DIR}/api" \
    "${SCRIPT_DIR}/web" \
    "${SCRIPT_DIR}/android/app/src" \
    "${SCRIPT_DIR}/android/app/build.gradle.kts" \
    "${SCRIPT_DIR}/android/build.gradle.kts" \
    "${SCRIPT_DIR}/package.json" \
    -type f 2>/dev/null \
    ! -path "*/build/*" \
    -print | sort | while IFS= read -r f; do
      local rel
      rel="$(printf '%s\n' "${f}" | sed "s#^${SCRIPT_DIR}/##")"
      printf '%s %s\n' "$(sha1sum "${f}" | awk '{print $1}')" "${rel}" >> "${out_file}"
    done
}

classify_bump_from_files() {
  local files="$1"
  local count
  count="$(printf '%s\n' "${files}" | sed '/^\s*$/d' | wc -l | tr -d ' ')"

  if printf '%s\n' "${files}" | grep -Eq \
    '^owner-app/android/app/build\.gradle\.kts$|^owner-app/android/build\.gradle\.kts$|^owner-app/android/gradle\.properties$|^owner-app/android/app/src/main/AndroidManifest\.xml$'; then
    echo "major|Build/Manifest-Datei geändert"
    return 0
  fi

  if [[ "${count}" =~ ^[0-9]+$ ]] && (( count >= 20 )); then
    echo "major|Viele Dateien geändert (${count})"
    return 0
  fi

  if printf '%s\n' "${files}" | grep -Eq \
    '^owner-app/android/app/src/main/|^owner-app/web/|^owner-app/api/|^src/index\.js$'; then
    echo "minor|Feature-/Code-Dateien geändert"
    return 0
  fi

  echo "patch|Kleine technische Änderung"
}

auto_bump_version_from_updates() {
  if [[ "${AUTO_VERSION_ON_RESTART}" != "1" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "${VERSION_STATE_FILE}")"
  touch "${VERSION_STATE_FILE}"

  local prev_fp current_fp
  prev_fp="$(get_prop "${VERSION_STATE_FILE}" "LAST_FP")"

  current_fp="$(compute_owner_fingerprint)"

  local changed_files=""
  local tmp_snapshot
  tmp_snapshot="$(mktemp)"
  build_owner_snapshot "${tmp_snapshot}"

  if [[ -f "${VERSION_SNAPSHOT_FILE}" ]]; then
    changed_files="$(
      comm -3 \
        <(sort "${VERSION_SNAPSHOT_FILE}") \
        <(sort "${tmp_snapshot}") \
        | awk '{print $2}' \
        | sed '/^\s*$/d' \
        | sort -u
    )"
  elif [[ -n "${prev_fp}" && -n "${current_fp}" && "${prev_fp}" != "${current_fp}" ]]; then
    changed_files="owner-app/*"
  fi

  if [[ -n "${changed_files//[[:space:]]/}" ]]; then
    local classified bump_type bump_reason changed_preview
    classified="$(classify_bump_from_files "${changed_files}")"
    bump_type="${classified%%|*}"
    bump_reason="${classified#*|}"
    bump_apk_version "${ANDROID_LOCAL_PROPERTIES}" "${bump_type}"
    changed_preview="$(printf '%s\n' "${changed_files}" | sed '/^\s*$/d' | head -n 8 | paste -sd ', ' -)"
    echo "[owner-remote] Auto-Version erkannt (${bump_type}) | Grund: ${bump_reason}"
    if [[ -n "${changed_preview}" ]]; then
      echo "[owner-remote] Geänderte Dateien (Auszug): ${changed_preview}"
    fi
  else
    echo "[owner-remote] Kein relevanter Update-Unterschied erkannt: Version bleibt."
  fi

  upsert_prop "${VERSION_STATE_FILE}" "LAST_FP" "${current_fp}"
  cp "${tmp_snapshot}" "${VERSION_SNAPSHOT_FILE}"
  rm -f "${tmp_snapshot}"
}

if ! command -v cloudflared >/dev/null 2>&1; then
  if [[ "${TUNNEL_PROVIDER}" == "cloudflared" ]]; then
    echo "cloudflared fehlt. Installiere zuerst cloudflared."
    exit 1
  fi
fi

mkdir -p "$(dirname "${ANDROID_LOCAL_PROPERTIES}")"
if [[ ! -f "${ANDROID_LOCAL_PROPERTIES}" ]]; then
  touch "${ANDROID_LOCAL_PROPERTIES}"
fi
if [[ -z "$(get_prop "${ANDROID_LOCAL_PROPERTIES}" "OWNER_APK_VERSION_CODE")" ]]; then
  upsert_prop "${ANDROID_LOCAL_PROPERTIES}" "OWNER_APK_VERSION_CODE" "1"
fi

auto_bump_version_from_updates

echo "[1/2] Starte Owner-App lokal auf ${HOST}:${PORT} ..."
(
  cd "${SCRIPT_DIR}"
  OWNER_APP_HOST="$HOST" OWNER_APP_PORT="$PORT" node api/server.mjs
) >"${APP_LOG_FILE}" 2>&1 &
APP_PID=$!

LOCAL_IP=""
if [[ -n "${MANUAL_LOCAL_IP}" ]]; then
  LOCAL_IP="${MANUAL_LOCAL_IP}"
elif [[ "${AUTO_IP}" != "0" ]]; then
  LOCAL_IP="$(detect_local_ip || true)"
fi

if [[ -n "${LOCAL_IP}" ]]; then
  LOCAL_URL="http://${LOCAL_IP}:${PORT}"
  if [[ "${HOTSPOT_MODE}" == "1" ]]; then
    # Handy als Hotspot-Host: lokale Laptop-IP ist oft nicht direkt zuverlässig erreichbar.
    # Trotzdem als Fallback setzen, falls das Gerät lokale Client-Zugriffe erlaubt.
    upsert_prop "${ANDROID_LOCAL_PROPERTIES}" "OWNER_APP_FALLBACK_URL" "${LOCAL_URL}"
    upsert_prop "${ANDROID_LOCAL_PROPERTIES}" "OWNER_APK_DOWNLOAD_URL" "${LOCAL_URL}/downloads/latest.apk"
  else
    FALLBACK_URL="${MANUAL_FALLBACK_URL:-${LOCAL_URL}}"
    upsert_prop "${ANDROID_LOCAL_PROPERTIES}" "OWNER_APP_FALLBACK_URL" "${FALLBACK_URL}"
    upsert_prop "${ANDROID_LOCAL_PROPERTIES}" "OWNER_APK_DOWNLOAD_URL" "${LOCAL_URL}/downloads/latest.apk"
  fi
  echo "[owner-remote] Auto-IP erkannt: ${LOCAL_IP}"
  echo "[owner-remote] local.properties mit lokaler URL aktualisiert."
else
  echo "[owner-remote] Konnte lokale IP nicht automatisch erkennen."
fi

echo "[1/2] Warte auf lokalen Server (${LOCAL_HEALTH_URL}) ..."
for i in $(seq 1 40); do
  if curl -fsS --max-time 2 "${LOCAL_HEALTH_URL}" >/dev/null 2>&1; then
    echo "[1/2] Owner-App ist erreichbar."
    break
  fi
  if ! kill -0 "${APP_PID}" >/dev/null 2>&1; then
    echo "Owner-App Prozess wurde beendet. Details: ${APP_LOG_FILE}"
    exit 1
  fi
  sleep 1
  if [[ "${i}" -eq 40 ]]; then
    echo "Owner-App ist lokal nicht erreichbar. Details: ${APP_LOG_FILE}"
    exit 1
  fi
done

echo "[2/2] Starte Tunnel..."
echo "Beenden: CTRL+C"
echo "Tunnel-URL Datei: ${URL_FILE}"
echo "Android local.properties: ${ANDROID_LOCAL_PROPERTIES}"
rm -f "${URL_FILE}"
trap 'kill ${APP_PID} >/dev/null 2>&1 || true' EXIT

apply_remote_url() {
  local url="$1"
  local bump_on_url_change="${OWNER_VERSION_BUMP_ON_URL_CHANGE:-patch}"
  local old_url target_url update_url fallback_url apk_base apk_url
  old_url="$(get_prop "${ANDROID_LOCAL_PROPERTIES}" "OWNER_APP_URL")"
  target_url="${url}"
  update_url="${url}/api/app-meta"

  fallback_url="${MANUAL_FALLBACK_URL:-}"
  if [[ -n "${LOCAL_URL:-}" ]]; then
    fallback_url="${LOCAL_URL}"
  fi

  apk_base="${target_url}"
  if [[ -n "${apk_base}" ]]; then
    apk_url="${apk_base}/downloads/latest.apk"
  else
    apk_base="${LOCAL_URL:-${MANUAL_FALLBACK_URL:-}}"
    if [[ -n "${apk_base}" ]]; then
      apk_url="${apk_base}/downloads/latest.apk"
    else
      apk_url="$(get_prop "${ANDROID_LOCAL_PROPERTIES}" "OWNER_APK_DOWNLOAD_URL")"
    fi
  fi

  upsert_prop "${ANDROID_LOCAL_PROPERTIES}" "OWNER_APP_URL" "${target_url}"
  upsert_prop "${ANDROID_LOCAL_PROPERTIES}" "OWNER_UPDATE_URL" "${update_url}"
  if [[ -n "${fallback_url}" ]]; then
    upsert_prop "${ANDROID_LOCAL_PROPERTIES}" "OWNER_APP_FALLBACK_URL" "${fallback_url}"
  fi
  if [[ -n "${apk_url}" ]]; then
    upsert_prop "${ANDROID_LOCAL_PROPERTIES}" "OWNER_APK_DOWNLOAD_URL" "${apk_url}"
  fi
  if [[ "${old_url}" != "${target_url}" ]]; then
    bump_apk_version "${ANDROID_LOCAL_PROPERTIES}" "${bump_on_url_change}"
  fi
  echo "${url}" > "${URL_FILE}"
  echo "[owner-remote] URL gespeichert: ${url}"
  echo "[owner-remote] local.properties aktualisiert."
}

if [[ -n "${CF_TUNNEL_TOKEN}" ]]; then
  if [[ -z "${PUBLIC_URL}" ]]; then
    echo "OWNER_PUBLIC_URL fehlt (z. B. https://owner.example.com)."
    exit 1
  fi

  apply_remote_url "${PUBLIC_URL}"
  echo "[owner-remote] Named Tunnel aktiv: ${PUBLIC_URL}"

  exec cloudflared tunnel run --token "${CF_TUNNEL_TOKEN}"
fi

if [[ "${TUNNEL_PROVIDER}" == "ngrok" ]]; then
  if ! command -v ngrok >/dev/null 2>&1; then
    echo "ngrok fehlt. Installiere zuerst ngrok."
    exit 1
  fi

  if [[ -n "${NGROK_AUTHTOKEN}" ]]; then
    ngrok config add-authtoken "${NGROK_AUTHTOKEN}" >/dev/null 2>&1 || true
  fi

  echo "[2/2] Starte ngrok..."
  if [[ -n "${NGROK_DOMAIN}" ]]; then
    ngrok http --domain="${NGROK_DOMAIN}" "${HEALTH_HOST}:${PORT}" >"${NGROK_LOG_FILE}" 2>&1 &
  else
    ngrok http "${HEALTH_HOST}:${PORT}" >"${NGROK_LOG_FILE}" 2>&1 &
  fi
  NGROK_PID=$!
  trap 'kill ${APP_PID} >/dev/null 2>&1 || true; kill ${NGROK_PID} >/dev/null 2>&1 || true' EXIT

  URL=""
  for i in $(seq 1 30); do
    URL="$(curl -fsS --max-time 2 http://127.0.0.1:4040/api/tunnels 2>/dev/null \
      | tr -d '\n' \
      | sed -n 's/.*\"public_url\":\"\\(https:[^\"]*\\)\".*/\\1/p')"
    if [[ -n "${URL}" ]]; then
      break
    fi
    sleep 1
  done

  if [[ -z "${URL}" ]]; then
    echo "Konnte ngrok URL nicht lesen. Details: ${NGROK_LOG_FILE}"
    exit 1
  fi

  apply_remote_url "${URL}"
  echo "[owner-remote] ngrok aktiv. Beenden: CTRL+C"
  wait "${NGROK_PID}"
  exit 0
fi

cloudflared tunnel \
  --url "${TUNNEL_TARGET_URL}" \
  --protocol http2 \
  --edge-ip-version 4 \
  --no-autoupdate 2>&1 | while IFS= read -r line; do
  echo "${line}"
  if [[ "${line}" =~ https://[a-zA-Z0-9.-]+\.trycloudflare\.com ]]; then
    URL="${BASH_REMATCH[0]}"
    apply_remote_url "${URL}"
  fi
done
