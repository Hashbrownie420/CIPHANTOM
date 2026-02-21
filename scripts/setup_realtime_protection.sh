#!/usr/bin/env bash
set -euo pipefail

# Sets up real-time protection on the server:
# - fail2ban jails for owner API auth brute-force + API flood
# - UFW auto-ban on 80/443
# - WhatsApp owner alert via owner_outbox on each ban

SERVER_USER="${SERVER_USER:-owner}"
SERVER_HOST="${SERVER_HOST:-130.61.157.46}"
SERVER_SSH="${SERVER_USER}@${SERVER_HOST}"

echo "[setup] target=${SERVER_SSH}"

ssh "${SERVER_SSH}" 'bash -s' <<'EOF'
set -euo pipefail

PROJECT_DIR="$HOME/CIPHERPHANTOM"
DB_FILE="$PROJECT_DIR/data/cipherphantom.db"
ENV_FILE="$PROJECT_DIR/.env"
INCIDENT_LOG="$PROJECT_DIR/data/security_incidents.log"

echo "[server] install fail2ban/sqlite3 if needed"
sudo apt-get update
sudo apt-get install -y fail2ban sqlite3

echo "[server] deploy notify script"
sudo tee /usr/local/bin/cipherphantom-f2b-notify.sh >/dev/null <<'SH'
#!/usr/bin/env bash
set -euo pipefail

JAIL="${1:-unknown}"
IP="${2:-unknown}"
FAILURES="${3:-0}"
MATCHES="${4:-}"

PROJECT_DIR="${PROJECT_DIR:-/home/owner/CIPHERPHANTOM}"
DB_FILE="$PROJECT_DIR/data/cipherphantom.db"
ENV_FILE="$PROJECT_DIR/.env"
INCIDENT_LOG="$PROJECT_DIR/data/security_incidents.log"

mkdir -p "$(dirname "$INCIDENT_LOG")"
touch "$INCIDENT_LOG"

trim() {
  local s="$1"
  printf "%s" "$s" | tr '\n' ' ' | cut -c1-240
}

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

NOW_ISO="$(date -Is)"
MATCH_SHORT="$(trim "${MATCHES}")"

echo "[${NOW_ISO}] source=fail2ban jail=${JAIL} ip=${IP} failures=${FAILURES} match=\"${MATCH_SHORT}\"" >> "$INCIDENT_LOG"

if [[ ! -f "$DB_FILE" ]]; then
  exit 0
fi

OWNER_IDS="$(awk -F= '/^OWNER_IDS=/{print $2}' "$ENV_FILE" 2>/dev/null | tail -n1 || true)"
if [[ -z "$OWNER_IDS" ]]; then
  OWNER_IDS="72271934840903@lid"
fi
CREATED_BY="${OWNER_IDS%%,*}"

MSG="ROT-SICHERHEITSALARM
Fail2ban hat eine IP automatisch blockiert.
Jail: ${JAIL}
IP: ${IP}
Fehlversuche: ${FAILURES}
Zeit: ${NOW_ISO}
Match: ${MATCH_SHORT}"

MSG_SQL="$(sql_escape "$MSG")"
SIG_SQL="$(sql_escape "— Realtime Shield")"
CREATED_BY_SQL="$(sql_escape "$CREATED_BY")"

IFS=',' read -r -a OWNER_ARR <<< "$OWNER_IDS"
for OWNER_ID in "${OWNER_ARR[@]}"; do
  OWNER_ID="$(echo "$OWNER_ID" | xargs)"
  [[ -z "$OWNER_ID" ]] && continue
  OWNER_SQL="$(sql_escape "$OWNER_ID")"
  sqlite3 "$DB_FILE" "
    INSERT INTO owner_outbox
      (type, target_id, target_scope, message, signature, created_by, status, created_at)
    VALUES
      ('single', '${OWNER_SQL}', NULL, '${MSG_SQL}', '${SIG_SQL}', '${CREATED_BY_SQL}', 'pending', '${NOW_ISO}');
  " || true
done
SH
sudo chmod 750 /usr/local/bin/cipherphantom-f2b-notify.sh
sudo chown root:root /usr/local/bin/cipherphantom-f2b-notify.sh

echo "[server] deploy fail2ban action"
sudo tee /etc/fail2ban/action.d/cipherphantom-notify.conf >/dev/null <<'ACT'
[Definition]
actionstart =
actionstop =
actioncheck = test -x /usr/local/bin/cipherphantom-f2b-notify.sh
actionban = /usr/local/bin/cipherphantom-f2b-notify.sh "<name>" "<ip>" "<failures>" "<matches>"
actionunban =
ACT

echo "[server] deploy fail2ban filters"
sudo tee /etc/fail2ban/filter.d/cipherphantom-owner-auth.conf >/dev/null <<'F1'
[Definition]
failregex = ^<HOST> - .* "(GET|POST|HEAD|OPTIONS) /api/login HTTP/1\.[01]" (401|429) .*
ignoreregex =
F1

sudo tee /etc/fail2ban/filter.d/cipherphantom-owner-flood.conf >/dev/null <<'F2'
[Definition]
failregex = ^<HOST> - .* "(GET|POST|HEAD|OPTIONS|PUT|DELETE) /api/.* HTTP/1\.[01]" [1-5][0-9][0-9] .*
ignoreregex =
F2

echo "[server] deploy fail2ban jails"
sudo mkdir -p /etc/fail2ban/jail.d
sudo tee /etc/fail2ban/jail.d/cipherphantom-realtime.local >/dev/null <<'JAIL'
[DEFAULT]
banaction = ufw
ignoreip = 127.0.0.1/8 ::1

[cipherphantom-owner-auth]
enabled = true
filter = cipherphantom-owner-auth
port = http,https
logpath = /var/log/nginx/access.log
backend = auto
findtime = 120
maxretry = 8
bantime = 24h
action = ufw[blocktype=deny]
         cipherphantom-notify

[cipherphantom-owner-flood]
enabled = true
filter = cipherphantom-owner-flood
port = http,https
logpath = /var/log/nginx/access.log
backend = auto
findtime = 20
maxretry = 350
bantime = 2h
action = ufw[blocktype=deny]
         cipherphantom-notify
JAIL

echo "[server] restart fail2ban"
sudo systemctl enable --now fail2ban
sudo systemctl restart fail2ban
sudo fail2ban-client ping
sudo fail2ban-client status
sudo fail2ban-client status cipherphantom-owner-auth || true
sudo fail2ban-client status cipherphantom-owner-flood || true

echo "[server] verify owner_outbox table exists"
sqlite3 "$DB_FILE" "SELECT name FROM sqlite_master WHERE type='table' AND name='owner_outbox';" || true

echo "[server] realtime protection setup finished"
EOF

echo "[setup] done"
