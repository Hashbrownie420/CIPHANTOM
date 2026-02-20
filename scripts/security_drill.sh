#!/usr/bin/env bash
set -u
set -o pipefail

# Controlled security + resilience drill for your own infrastructure.
# This script does NOT perform distributed attacks (DDoS).

SERVER_HOST="${SERVER_HOST:-130.61.157.46}"
SERVER_USER="${SERVER_USER:-owner}"
BASE_URL="${BASE_URL:-http://${SERVER_HOST}}"
OWNER_USER="${OWNER_USER:-cipherowner}"
OWNER_PASS="${OWNER_PASS:-}"
RUN_CHAOS="${RUN_CHAOS:-0}"          # 1 => run crash/recovery tests via SSH
LOAD_REQUESTS="${LOAD_REQUESTS:-600}" # DoS-style burst size (single machine)
LOAD_CONCURRENCY="${LOAD_CONCURRENCY:-40}"

STAMP="$(date +%F_%H-%M-%S)"
REPORT_DIR="${REPORT_DIR:-$PWD/reports/security_${STAMP}}"
mkdir -p "$REPORT_DIR"

LOG_FILE="$REPORT_DIR/full.log"
touch "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

section() {
  echo
  echo "================================================================"
  echo "$1"
  echo "================================================================"
}

save_text() {
  local file="$1"
  shift
  printf "%s\n" "$@" | tee "$file"
}

if [[ -z "$OWNER_PASS" ]]; then
  read -r -s -p "Owner Passwort für Login-Tests: " OWNER_PASS
  echo
fi

section "META"
echo "timestamp=$(date -Is)"
echo "server_host=$SERVER_HOST"
echo "server_user=$SERVER_USER"
echo "base_url=$BASE_URL"
echo "owner_user=$OWNER_USER"
echo "run_chaos=$RUN_CHAOS"
echo "load_requests=$LOAD_REQUESTS"
echo "load_concurrency=$LOAD_CONCURRENCY"
echo "report_dir=$REPORT_DIR"

section "PORTSCAN"
if command -v nmap >/dev/null 2>&1; then
  # -sS needs root. Try sudo nmap first; fallback to -sT if sudo/nmap fails.
  if [[ "${EUID}" -eq 0 ]]; then
    nmap -Pn -sS -sV -p 22,80,443,8787 "$SERVER_HOST" | tee "$REPORT_DIR/portscan.txt"
  else
    if command -v sudo >/dev/null 2>&1; then
      if sudo nmap -Pn -sS -sV -p 22,80,443,8787 "$SERVER_HOST" | tee "$REPORT_DIR/portscan.txt"; then
        :
      else
        echo "WARN: SYN scan via sudo fehlgeschlagen, fallback auf -sT" | tee "$REPORT_DIR/portscan.txt"
        nmap -Pn -sT -sV -p 22,80,443,8787 "$SERVER_HOST" | tee -a "$REPORT_DIR/portscan.txt"
      fi
    else
      nmap -Pn -sT -sV -p 22,80,443,8787 "$SERVER_HOST" | tee "$REPORT_DIR/portscan.txt"
    fi
  fi
else
  echo "nmap nicht installiert -> übersprungen" | tee "$REPORT_DIR/portscan.txt"
fi

section "PUBLIC ENDPOINTS"
for path in "/" "/api/healthz" "/api/app-meta" "/downloads/latest.apk"; do
  slug="$(echo "$path" | tr '/?' '__' | sed 's/^_$/root/')"
  body_file="$REPORT_DIR/public_${slug}.body.txt"
  code="$(curl -sS -o "$body_file" -w "%{http_code}" "${BASE_URL}${path}" || true)"
  echo "GET ${path} -> HTTP ${code} (body: ${body_file})"
done | tee "$REPORT_DIR/public_endpoints.txt"

section "AUTH TESTS"
no_auth_code="$(curl -sS -o "$REPORT_DIR/auth_no_token.body.json" -w "%{http_code}" "${BASE_URL}/api/process/all/status" || true)"
bad_token_code="$(curl -sS -o "$REPORT_DIR/auth_bad_token.body.json" -w "%{http_code}" -H "Authorization: Bearer 123" "${BASE_URL}/api/process/all/status" || true)"
echo "no_token_status_code=${no_auth_code}"
echo "bad_token_status_code=${bad_token_code}"

LOGIN_JSON="$REPORT_DIR/login_ok.json"
curl -sS -X POST "${BASE_URL}/api/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${OWNER_USER}\",\"password\":\"${OWNER_PASS}\"}" \
  -o "$LOGIN_JSON" || true

TOKEN="$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$LOGIN_JSON")"
if [[ -z "$TOKEN" ]]; then
  echo "WARN: Kein Token erhalten. Datei prüfen: $LOGIN_JSON"
else
  echo "login_ok=1 token_length=${#TOKEN}"
  curl -sS -H "Authorization: Bearer $TOKEN" "${BASE_URL}/api/process/all/status" -o "$REPORT_DIR/auth_status_ok.json" || true
  curl -sS -H "Authorization: Bearer $TOKEN" "${BASE_URL}/api/process/bot/logs?lines=20" -o "$REPORT_DIR/auth_bot_logs.json" || true
  curl -sS -H "Authorization: Bearer $TOKEN" "${BASE_URL}/api/process/app/logs?lines=20" -o "$REPORT_DIR/auth_app_logs.json" || true
fi

section "BRUTEFORCE / RATELIMIT TEST"
BRUTE_OUT="$REPORT_DIR/bruteforce_codes.txt"
: > "$BRUTE_OUT"
for i in $(seq 1 25); do
  code="$(curl -sS -o /dev/null -w "%{http_code}" \
    -X POST "${BASE_URL}/api/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${OWNER_USER}\",\"password\":\"wrong-${i}\"}" || true)"
  echo "$code" >> "$BRUTE_OUT"
  echo "try=$i code=$code"
done
echo "code_distribution:"
sort "$BRUTE_OUT" | uniq -c

section "INPUT ATTACK TESTS"
sqli_code="$(curl -sS -o "$REPORT_DIR/sqli_login.body.json" -w "%{http_code}" \
  -X POST "${BASE_URL}/api/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"' OR '1'='1\",\"password\":\"x\"}" || true)"
echo "sqli_login_code=$sqli_code"

trav_code="$(curl -sS -o "$REPORT_DIR/path_traversal.body.txt" -w "%{http_code}" \
  "${BASE_URL}/media/avatar/../../etc/passwd" || true)"
echo "path_traversal_code=$trav_code"

for method in TRACE PUT DELETE OPTIONS; do
  code="$(curl -sS -o /dev/null -w "%{http_code}" -X "$method" "${BASE_URL}/api/login" || true)"
  echo "method_${method}_code=$code"
done | tee "$REPORT_DIR/method_fuzz.txt"

section "OVERSIZED BODY TEST"
python3 - <<'PY' > "$REPORT_DIR/huge_login.json"
print('{"username":"cipherowner","password":"' + ('A' * 1500000) + '"}')
PY
huge_code="$(curl -sS -o "$REPORT_DIR/huge_login.body.txt" -w "%{http_code}" \
  -X POST "${BASE_URL}/api/login" \
  -H "Content-Type: application/json" \
  --data-binary @"$REPORT_DIR/huge_login.json" || true)"
echo "huge_body_code=$huge_code"

section "CONTROLLED DOS-STYLE LOAD TEST (SINGLE ORIGIN)"
LOAD_CODES="$REPORT_DIR/load_codes.txt"
seq 1 "$LOAD_REQUESTS" | xargs -P "$LOAD_CONCURRENCY" -I{} \
  curl -sS -o /dev/null -w "%{http_code}\n" "${BASE_URL}/api/healthz" > "$LOAD_CODES"

total="$(wc -l < "$LOAD_CODES" | tr -d ' ')"
ok2xx="$(grep -c '^2' "$LOAD_CODES" || true)"
err4xx="$(grep -c '^4' "$LOAD_CODES" || true)"
err5xx="$(grep -c '^5' "$LOAD_CODES" || true)"
echo "total=$total ok2xx=$ok2xx err4xx=$err4xx err5xx=$err5xx"
echo "distribution:"
sort "$LOAD_CODES" | uniq -c

section "OPTIONAL CHAOS CRASH TESTS (RUN_CHAOS=1)"
if [[ "$RUN_CHAOS" == "1" ]]; then
  ssh "${SERVER_USER}@${SERVER_HOST}" '
    set -euo pipefail
    cd ~/CIPHERPHANTOM
    echo "[chaos] before"
    docker compose ps
    curl -s http://127.0.0.1:8787/api/healthz || true
    echo
    echo "[chaos] hard kill app+bot"
    docker kill cipherphantom-owner-app || true
    docker kill cipherphantom-bot || true
    sleep 8
    echo "[chaos] after kill"
    docker compose ps
    curl -s http://127.0.0.1:8787/api/healthz || true
    echo
    echo "[chaos] restart storm x6"
    for i in $(seq 1 6); do
      docker restart cipherphantom-owner-app cipherphantom-bot >/dev/null || true
      sleep 2
    done
    docker compose ps
    curl -s http://127.0.0.1:8787/api/healthz || true
    echo
  ' | tee "$REPORT_DIR/chaos.txt"
else
  echo "RUN_CHAOS=0 -> übersprungen" | tee "$REPORT_DIR/chaos.txt"
fi

section "DONE"
echo "Bericht erstellt: $REPORT_DIR"
echo "Hauptlog: $LOG_FILE"
echo
echo "Bitte diese Dateien schicken:"
echo "1) $LOG_FILE"
echo "2) $REPORT_DIR/portscan.txt"
echo "3) $REPORT_DIR/bruteforce_codes.txt"
echo "4) $REPORT_DIR/load_codes.txt"
