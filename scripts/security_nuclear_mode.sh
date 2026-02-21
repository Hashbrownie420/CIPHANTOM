#!/usr/bin/env bash
set -euo pipefail

# Runs multiple full red-mode rounds and writes one consolidated summary.
# This stays on legal/controlled testing scope for your own infrastructure.

ROUNDS="${ROUNDS:-5}"
STRICT="${STRICT:-1}" # 1 => exit non-zero if any round is not GO

SERVER_HOST="${SERVER_HOST:-130.61.157.46}"
SERVER_USER="${SERVER_USER:-owner}"
OWNER_USER="${OWNER_USER:-cipherowner}"
OWNER_PASS="${OWNER_PASS:-}"
RUN_CHAOS="${RUN_CHAOS:-1}"
LOAD_REQUESTS="${LOAD_REQUESTS:-3000}"
LOAD_CONCURRENCY="${LOAD_CONCURRENCY:-180}"
REQ_THRESHOLD="${REQ_THRESHOLD:-150}"
CONN_THRESHOLD="${CONN_THRESHOLD:-45}"

if ! [[ "$ROUNDS" =~ ^[0-9]+$ ]] || (( ROUNDS < 1 )); then
  echo "Ungültige ROUNDS=$ROUNDS (muss >= 1 sein)." >&2
  exit 1
fi

if [[ -z "$OWNER_PASS" ]]; then
  read -r -s -p "Owner Passwort: " OWNER_PASS
  echo
fi

STAMP="$(date +%F_%H-%M-%S)"
ROOT="${REPORT_ROOT:-$PWD/reports/nuclear_${STAMP}}"
mkdir -p "$ROOT"

SUMMARY_TSV="$ROOT/summary.tsv"
SUMMARY_TXT="$ROOT/summary.txt"
echo -e "round\trc\tscore\tverdict\treport_dir\tlog_file" > "$SUMMARY_TSV"

echo "[nuclear] start rounds=$ROUNDS root=$ROOT"

for round in $(seq 1 "$ROUNDS"); do
  rid="$(printf "%02d" "$round")"
  run_log="$ROOT/round_${rid}.log"
  before="$(ls -dt reports/security_* 2>/dev/null | head -n1 || true)"

  echo
  echo "================================================================"
  echo "[nuclear] ROUND ${rid}/${ROUNDS} start $(date -Is)"
  echo "================================================================"

  set +e
  env \
    SERVER_HOST="$SERVER_HOST" \
    SERVER_USER="$SERVER_USER" \
    OWNER_USER="$OWNER_USER" \
    OWNER_PASS="$OWNER_PASS" \
    RUN_CHAOS="$RUN_CHAOS" \
    LOAD_REQUESTS="$LOAD_REQUESTS" \
    LOAD_CONCURRENCY="$LOAD_CONCURRENCY" \
    REQ_THRESHOLD="$REQ_THRESHOLD" \
    CONN_THRESHOLD="$CONN_THRESHOLD" \
    ./scripts/security_red_mode.sh 2>&1 | tee "$run_log"
  rc="${PIPESTATUS[0]}"
  set -e

  after="$(ls -dt reports/security_* 2>/dev/null | head -n1 || true)"
  report_dir=""
  score="NA"
  verdict="ERROR"

  if [[ -n "$after" && "$after" != "$before" ]]; then
    report_dir="$after"
    gate="$report_dir/release_gate.txt"
    if [[ -f "$gate" ]]; then
      score="$(grep -E '^SCORE=' "$gate" | tail -n1 | cut -d= -f2 || echo "NA")"
      verdict="$(grep -E '^VERDICT=' "$gate" | tail -n1 | cut -d= -f2 || echo "ERROR")"
    fi
  fi

  if (( rc != 0 )); then
    verdict="ERROR(rc=${rc})"
  fi

  echo -e "${rid}\t${rc}\t${score}\t${verdict}\t${report_dir}\t${run_log}" >> "$SUMMARY_TSV"
done

go_count="$(awk -F'\t' 'NR>1 && $4=="GO" {c++} END {print c+0}' "$SUMMARY_TSV")"
err_count="$(awk -F'\t' 'NR>1 && $4!="GO" {c++} END {print c+0}' "$SUMMARY_TSV")"

{
  echo "NUCLEAR SUMMARY"
  echo "rounds=$ROUNDS"
  echo "go=$go_count"
  echo "not_go=$err_count"
  echo
  column -t -s $'\t' "$SUMMARY_TSV" || cat "$SUMMARY_TSV"
} | tee "$SUMMARY_TXT"

echo
echo "[nuclear] summary_tsv=$SUMMARY_TSV"
echo "[nuclear] summary_txt=$SUMMARY_TXT"

if [[ "$STRICT" == "1" ]] && (( err_count > 0 )); then
  echo "[nuclear] Ergebnis: NICHT ALLE RUNDEN GO (STRICT=1)" >&2
  exit 1
fi

echo "[nuclear] Ergebnis: abgeschlossen"
