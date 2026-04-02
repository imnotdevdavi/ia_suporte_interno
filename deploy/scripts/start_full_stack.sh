#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

SERVER_PID=""
NGROK_PID=""

cleanup() {
  local exit_code="${1:-0}"
  trap - INT TERM EXIT

  if [[ -n "$NGROK_PID" ]] && kill -0 "$NGROK_PID" 2>/dev/null; then
    kill "$NGROK_PID" 2>/dev/null || true
  fi

  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi

  wait "$NGROK_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true

  exit "$exit_code"
}

trap 'cleanup 130' INT TERM
trap 'cleanup $?' EXIT

cd "$PROJECT_DIR"

echo "Subindo SmartAI..."
node server.js &
SERVER_PID="$!"

sleep 2
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  wait "$SERVER_PID"
fi

echo "Abrindo tunel ngrok..."
bash "$PROJECT_DIR/deploy/scripts/start_ngrok.sh" &
NGROK_PID="$!"

echo "SmartAI PID: $SERVER_PID"
echo "ngrok PID: $NGROK_PID"
echo "Pressione Ctrl+C para encerrar os dois."

wait -n "$SERVER_PID" "$NGROK_PID"
