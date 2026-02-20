#!/usr/bin/env bash
set -euo pipefail

# Local orchestrator for "red mode" release gate.
# Runs strong SYN scan + controlled stress drill, then server-side auto-block/notify guard.

SERVER_HOST="${SERVER_HOST:-130.61.157.46}"
SERVER_USER="${SERVER_USER:-owner}"
OWNER_USER="${OWNER_USER:-cipherowner}"
OWNER_PASS="${OWNER_PASS:-}"
RUN_CHAOS="${RUN_CHAOS:-1}"
LOAD_REQUESTS="${LOAD_REQUESTS:-1000}"
LOAD_CONCURRENCY="${LOAD_CONCURRENCY:-60}"
REQ_THRESHOLD="${REQ_THRESHOLD:-220}"
CONN_THRESHOLD="${CONN_THRESHOLD:-70}"

if [[ -z "$OWNER_PASS" ]]; then
  read -r -s -p "Owner Passwort: " OWNER_PASS
  echo
fi

if ! command -v nmap >/dev/null 2>&1; then
  echo "[red] nmap fehlt -> installiere..."
  sudo apt-get update
  sudo apt-get install -y nmap
fi

echo "[red] starte security drill (SYN scan + load + chaos)"
env \
  SERVER_HOST="$SERVER_HOST" \
  SERVER_USER="$SERVER_USER" \
  OWNER_USER="$OWNER_USER" \
  OWNER_PASS="$OWNER_PASS" \
  RUN_CHAOS="$RUN_CHAOS" \
  LOAD_REQUESTS="$LOAD_REQUESTS" \
  LOAD_CONCURRENCY="$LOAD_CONCURRENCY" \
  ./scripts/security_drill.sh

LATEST="$(ls -dt reports/security_* | head -n1)"
echo "[red] report=$LATEST"

MY_IP="$(curl -4 -s https://ifconfig.me || true)"
MY_IP_ESC="$(printf '%s' "$MY_IP" | sed 's/[.[\*^$()+?{|]/\\&/g')"
ALLOWLIST_REGEX='^(127\.0\.0\.1|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'
if [[ -n "$MY_IP_ESC" ]]; then
  ALLOWLIST_REGEX="${ALLOWLIST_REGEX}|^${MY_IP_ESC}$"
fi

echo "[red] starte server attack guard (auto-block + log + owner notify)"
# ensure latest guard script is present on server (independent from git pull timing)
scp ./scripts/server_attack_guard.sh "${SERVER_USER}@${SERVER_HOST}:~/CIPHERPHANTOM/scripts/server_attack_guard.sh" >/dev/null
ssh "${SERVER_USER}@${SERVER_HOST}" \
  "cd ~/CIPHERPHANTOM && \
   chmod +x scripts/server_attack_guard.sh && \
   REQ_THRESHOLD='${REQ_THRESHOLD}' \
   CONN_THRESHOLD='${CONN_THRESHOLD}' \
   ALLOWLIST_REGEX='${ALLOWLIST_REGEX}' \
   bash scripts/server_attack_guard.sh" \
  | tee "$LATEST/server_guard.txt"

echo "[red] hole Server-Artefakte"
ssh "${SERVER_USER}@${SERVER_HOST}" \
  "tail -n 80 ~/CIPHERPHANTOM/data/security_incidents.log; echo '---'; sudo ufw status numbered; echo '---'; sqlite3 ~/CIPHERPHANTOM/data/cipherphantom.db \"SELECT id,status,target_id,substr(message,1,120),created_at FROM owner_outbox WHERE message LIKE '%ROT-SICHERHEITSALARM%' ORDER BY id DESC LIMIT 10;\"" \
  > "$LATEST/server_security_state.txt"

echo "[red] 10-Punkte Kurzbewertung"
FULL="$LATEST/full.log"
AUTH_OK=0
RATE_OK=0
INPUT_OK=0
METHOD_OK=0
DOS_OK=0
CHAOS_OK=0
PORT_OK=0
APK_OK=0
BACKUP_OK=0
DEPLOY_OK=0

no_token="$(grep -E '^no_token_status_code=' "$FULL" | tail -n1 | cut -d= -f2 || true)"
bad_token="$(grep -E '^bad_token_status_code=' "$FULL" | tail -n1 | cut -d= -f2 || true)"
[[ "$no_token" == "401" && "$bad_token" == "401" ]] && AUTH_OK=1

if grep -q '^429$' "$LATEST/bruteforce_codes.txt"; then RATE_OK=1; fi

sqli_code="$(grep -E '^sqli_login_code=' "$FULL" | tail -n1 | cut -d= -f2 || true)"
trav_code="$(grep -E '^path_traversal_code=' "$FULL" | tail -n1 | cut -d= -f2 || true)"
huge_code="$(grep -E '^huge_body_code=' "$FULL" | tail -n1 | cut -d= -f2 || true)"
if [[ "$sqli_code" == "401" && ( "$trav_code" == "404" || "$trav_code" == "400" ) && "$huge_code" == "413" ]]; then INPUT_OK=1; fi

if ! grep -Eq 'method_.*_code=200' "$LATEST/method_fuzz.txt"; then METHOD_OK=1; fi

err5xx="$(grep -E 'err5xx=' "$FULL" | tail -n1 | sed -E 's/.*err5xx=([0-9]+).*/\1/' || echo 9999)"
total_req="$(grep -E 'total=' "$FULL" | tail -n1 | sed -E 's/.*total=([0-9]+).*/\1/' || echo 0)"
if [[ "$total_req" -gt 0 ]]; then
  pct5=$(( 100 * err5xx / total_req ))
  [[ "$pct5" -le 1 ]] && DOS_OK=1
fi

if grep -q '\[chaos\] restart storm x6' "$FULL" && grep -q '"ok":true' "$FULL"; then CHAOS_OK=1; fi

if grep -Eq '22/tcp|80/tcp|443/tcp' "$LATEST/portscan.txt" && ! grep -Eq '8787/tcp.+open' "$LATEST/portscan.txt"; then PORT_OK=1; fi

appmeta="$(curl -s "http://${SERVER_HOST}/api/app-meta" || true)"
if echo "$appmeta" | grep -q '"apkDownloadUrl"' && echo "$appmeta" | grep -q '"apkSha256"'; then APK_OK=1; fi

if ssh "${SERVER_USER}@${SERVER_HOST}" "test -s /home/owner/backup.log"; then BACKUP_OK=1; fi

if ssh "${SERVER_USER}@${SERVER_HOST}" "crontab -l | grep -q '/home/owner/bin/auto-deploy.sh'"; then DEPLOY_OK=1; fi

printf "1 Auth: %s\n" "$AUTH_OK" | tee "$LATEST/release_gate.txt"
printf "2 RateLimit: %s\n" "$RATE_OK" | tee -a "$LATEST/release_gate.txt"
printf "3 Input: %s\n" "$INPUT_OK" | tee -a "$LATEST/release_gate.txt"
printf "4 Methods: %s\n" "$METHOD_OK" | tee -a "$LATEST/release_gate.txt"
printf "5 DoS: %s\n" "$DOS_OK" | tee -a "$LATEST/release_gate.txt"
printf "6 ChaosRecovery: %s\n" "$CHAOS_OK" | tee -a "$LATEST/release_gate.txt"
printf "7 PortHarden: %s\n" "$PORT_OK" | tee -a "$LATEST/release_gate.txt"
printf "8 APKFlow: %s\n" "$APK_OK" | tee -a "$LATEST/release_gate.txt"
printf "9 Backup: %s\n" "$BACKUP_OK" | tee -a "$LATEST/release_gate.txt"
printf "10 AutoDeploy: %s\n" "$DEPLOY_OK" | tee -a "$LATEST/release_gate.txt"

sum=$((AUTH_OK + RATE_OK + INPUT_OK + METHOD_OK + DOS_OK + CHAOS_OK + PORT_OK + APK_OK + BACKUP_OK + DEPLOY_OK))
printf "\nSCORE=%s/10\n" "$sum" | tee -a "$LATEST/release_gate.txt"
if [[ "$sum" -eq 10 ]]; then
  echo "VERDICT=GO" | tee -a "$LATEST/release_gate.txt"
else
  echo "VERDICT=NO-GO" | tee -a "$LATEST/release_gate.txt"
fi

echo "[red] fertig. Dateien:"
echo " - $LATEST/full.log"
echo " - $LATEST/server_guard.txt"
echo " - $LATEST/server_security_state.txt"
echo " - $LATEST/release_gate.txt"
