#!/usr/bin/env bash
set -euo pipefail

# Server-side guard:
# - detects suspicious request/connection spikes
# - blocks attacker IPs via UFW
# - writes incident log
# - sends owner WhatsApp alerts through owner_outbox
#
# Run on server:
#   bash scripts/server_attack_guard.sh

PROJECT_DIR="${PROJECT_DIR:-$HOME/CIPHERPHANTOM}"
DB_FILE="${DB_FILE:-$PROJECT_DIR/data/cipherphantom.db}"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
INCIDENT_LOG="${INCIDENT_LOG:-$PROJECT_DIR/data/security_incidents.log}"
NGINX_LOG="${NGINX_LOG:-/var/log/nginx/access.log}"
MAX_ACCESS_LINES="${MAX_ACCESS_LINES:-8000}"
REQ_THRESHOLD="${REQ_THRESHOLD:-220}"     # requests in access tail
CONN_THRESHOLD="${CONN_THRESHOLD:-70}"    # simultaneous tcp connections
MAX_BLOCKS_PER_RUN="${MAX_BLOCKS_PER_RUN:-20}"
ALLOWLIST_REGEX="${ALLOWLIST_REGEX:-^(127\\.0\\.0\\.1|10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[0-1])\\.)}"

mkdir -p "$(dirname "$INCIDENT_LOG")"
touch "$INCIDENT_LOG"

ts() {
  date -Is
}

log_incident() {
  local line="$1"
  echo "[$(ts)] $line" | tee -a "$INCIDENT_LOG"
}

sql_escape() {
  local s="${1:-}"
  s="${s//\'/\'\'}"
  printf "%s" "$s"
}

is_ipv4() {
  [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]
}

is_allowlisted() {
  local ip="$1"
  [[ "$ip" =~ $ALLOWLIST_REGEX ]]
}

tmp_candidates="$(mktemp)"
tmp_blocks="$(mktemp)"
trap 'rm -f "$tmp_candidates" "$tmp_blocks"' EXIT

echo "=== server_attack_guard start $(ts) ==="
echo "project=$PROJECT_DIR"
echo "db=$DB_FILE"
echo "incident_log=$INCIDENT_LOG"

# 1) Candidate IPs from nginx access spikes
if [[ -f "$NGINX_LOG" ]]; then
  tail -n "$MAX_ACCESS_LINES" "$NGINX_LOG" \
    | awk '{print $1}' \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort \
    | uniq -c \
    | awk -v threshold="$REQ_THRESHOLD" '$1 >= threshold {print $2 " " $1 " nginx_hits"}' \
    >> "$tmp_candidates" || true
else
  echo "WARN: nginx log not found: $NGINX_LOG"
fi

# 2) Candidate IPs from active TCP connections to :80
ss -Htn 2>/dev/null \
  | awk '$4 ~ /:80$/ {print $5}' \
  | sed -E 's/^\[?([0-9.]+)\]?(:[0-9]+)?$/\1/' \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort \
  | uniq -c \
  | awk -v threshold="$CONN_THRESHOLD" '$1 >= threshold {print $2 " " $1 " conn_80"}' \
  >> "$tmp_candidates" || true

sort -u "$tmp_candidates" -o "$tmp_candidates"

if [[ ! -s "$tmp_candidates" ]]; then
  log_incident "guard=no_candidate_ips action=none"
  echo "No suspicious IPs detected."
  exit 0
fi

echo "Suspicious candidates:"
cat "$tmp_candidates"

blocks=0
while read -r ip count source; do
  [[ -z "${ip:-}" ]] && continue
  is_ipv4 "$ip" || continue
  if is_allowlisted "$ip"; then
    log_incident "guard=skip_allowlist ip=$ip source=$source count=$count"
    continue
  fi
  if sudo ufw status | grep -Eq "\\b${ip}\\b"; then
    log_incident "guard=already_ruled ip=$ip source=$source count=$count"
    continue
  fi
  if (( blocks >= MAX_BLOCKS_PER_RUN )); then
    log_incident "guard=max_blocks_reached limit=$MAX_BLOCKS_PER_RUN ip=$ip"
    break
  fi
  sudo ufw insert 1 deny from "$ip" to any port 80 proto tcp >/dev/null
  sudo ufw insert 1 deny from "$ip" to any port 443 proto tcp >/dev/null
  log_incident "guard=blocked ip=$ip source=$source count=$count action=ufw_deny_web"
  echo "$ip $count $source" >> "$tmp_blocks"
  blocks=$((blocks + 1))
done < "$tmp_candidates"

if [[ ! -s "$tmp_blocks" ]]; then
  log_incident "guard=done blocked=0"
  echo "No new IP was blocked."
  exit 0
fi

# Build owner alert message
alert_lines="$(awk '{printf "- %s (%s, %s)\n", $1, $2, $3}' "$tmp_blocks")"
alert_msg="ROT-SICHERHEITSALARM
Verdächtige Aktivität erkannt und blockiert.

Geblockte IPs:
${alert_lines}

Details: ${INCIDENT_LOG}"

echo "Blocked IPs:"
cat "$tmp_blocks"

if [[ ! -f "$DB_FILE" ]]; then
  log_incident "guard=notify_skipped reason=db_missing db=$DB_FILE"
  echo "WARN: DB file not found, skip owner notification."
  exit 0
fi

owner_ids_raw=""
if [[ -f "$ENV_FILE" ]]; then
  owner_ids_raw="$(grep -E '^OWNER_IDS=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
fi

if [[ -z "$owner_ids_raw" ]]; then
  # fallback hard default used across project
  owner_ids_raw="72271934840903@lid"
fi

IFS=',' read -r -a owner_ids <<< "$owner_ids_raw"
created_by="${owner_ids[0]}"
created_by_sql="$(sql_escape "$created_by")"
msg_sql="$(sql_escape "$alert_msg")"
sig_sql="$(sql_escape "— Security Guard")"
now="$(ts)"

for owner_id in "${owner_ids[@]}"; do
  owner_id="$(echo "$owner_id" | xargs)"
  [[ -z "$owner_id" ]] && continue
  owner_sql="$(sql_escape "$owner_id")"
  sqlite3 "$DB_FILE" "
    INSERT INTO owner_outbox
      (type, target_id, target_scope, message, signature, created_by, status, created_at)
    VALUES
      ('single', '${owner_sql}', NULL, '${msg_sql}', '${sig_sql}', '${created_by_sql}', 'pending', '${now}');
  " || true
done

log_incident "guard=notify_sent blocked=$blocks owners=${#owner_ids[@]}"
echo "Owner alert queued in owner_outbox."
echo "=== server_attack_guard done $(ts) ==="
