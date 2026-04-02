#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="${ENV_FILE:-$PROJECT_DIR/.env}"
APP_PORT="${1:-${PORT:-3000}}"
DEFAULT_LOCAL_NGROK="$PROJECT_DIR/tools/ngrok/ngrok"
DEFAULT_LOCAL_CONFIG="$PROJECT_DIR/tools/ngrok/ngrok.yml"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

APP_PORT="${1:-${PORT:-3000}}"

if [[ -z "${NGROK_BIN:-}" && -x "$DEFAULT_LOCAL_NGROK" ]]; then
  NGROK_BIN="$DEFAULT_LOCAL_NGROK"
else
  NGROK_BIN="${NGROK_BIN:-ngrok}"
fi

NGROK_CONFIG="${NGROK_CONFIG:-$DEFAULT_LOCAL_CONFIG}"

if [[ -n "${NGROK_AUTHTOKEN:-}" ]]; then
  mkdir -p "$(dirname "$NGROK_CONFIG")"
  "$NGROK_BIN" config add-authtoken "$NGROK_AUTHTOKEN" --config "$NGROK_CONFIG" >/dev/null
fi

ARGS=(http "$APP_PORT")

if [[ -n "${NGROK_DOMAIN:-}" ]]; then
  ARGS+=("--domain=$NGROK_DOMAIN")
fi

if [[ -n "${NGROK_BASIC_AUTH:-}" ]]; then
  ARGS+=("--basic-auth=$NGROK_BASIC_AUTH")
fi

exec "$NGROK_BIN" --config "$NGROK_CONFIG" "${ARGS[@]}"
