#!/usr/bin/env bash
# The Nines — local-first stack runner.
#
# Starts everything on this machine:
#   1. Next.js app  (http://localhost:3000)
#   2. Stream ingestor (Helius WebSocket -> local app)
#
# The watcher (scanner.py) runs on a 5-minute cron separately — see README.
#
# Usage:
#   ./run.sh          # build if needed, then start app + ingestor
#   ./run.sh dev      # Next.js dev mode (hot reload) + ingestor
#   ./run.sh stop     # stop everything started by run.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDDIR="$REPO/.run"
mkdir -p "$PIDDIR"

# Load .env if present (ingestor + watcher read env vars).
if [[ -f "$REPO/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO/.env"
  set +a
fi

# Resolve relative paths in .env against the repo root.
export NINES_STATE_PATH="${NINES_STATE_PATH:-$REPO/watcher/state.json}"
export NINES_STREAM_PATH="${NINES_STREAM_PATH:-$REPO/data-live/stream-events.jsonl}"
export NINES_INGEST_URL="${NINES_INGEST_URL:-http://localhost:3000}"
mkdir -p "$(dirname "$NINES_STREAM_PATH")"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 1; }
}

running() { [[ -f "$PIDDIR/$1.pid" ]] && kill -0 "$(cat "$PIDDIR/$1.pid")" 2>/dev/null; }

stop_one() {
  if running "$1"; then
    kill "$(cat "$PIDDIR/$1.pid")" 2>/dev/null || true
    rm -f "$PIDDIR/$1.pid"
    echo "stopped $1"
  fi
}

do_stop() {
  stop_one ingestor
  stop_one app
  echo "all stopped"
}

[[ "${1:-}" == "stop" ]] && { do_stop; exit 0; }

need node
need npm
need python3

# --- sanity checks -----------------------------------------------------------
if [[ -z "${HELIUS_API_KEY:-}" ]]; then
  echo "HELIUS_API_KEY is not set. Copy .env.example to .env and fill it in." >&2
  exit 1
fi
if [[ -z "${STREAM_INGEST_TOKEN:-}" ]]; then
  echo "STREAM_INGEST_TOKEN is not set. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

# --- ingestor venv -----------------------------------------------------------
if [[ ! -d "$REPO/ingestor/venv" ]]; then
  echo "creating ingestor venv..."
  python3 -m venv "$REPO/ingestor/venv"
  "$REPO/ingestor/venv/bin/pip" install -q -r "$REPO/ingestor/requirements.txt"
fi

# --- next.js -----------------------------------------------------------------
if [[ ! -d "$REPO/node_modules" ]]; then
  echo "installing node deps (first run, may take a few minutes)..."
  (cd "$REPO" && npm install)
fi

MODE="${1:-prod}"
if [[ "$MODE" == "dev" ]]; then
  APP_CMD="npm run dev"
else
  if [[ ! -d "$REPO/.next" ]]; then
    echo "building next.js app (first run)..."
    (cd "$REPO" && npm run build)
  fi
  APP_CMD="npm run start"
fi

# --- start -------------------------------------------------------------------
if running app; then
  echo "app already running (pid $(cat "$PIDDIR/app.pid"))"
else
  echo "starting next.js app ($MODE)..."
  (cd "$REPO" && $APP_CMD >"$REPO/.run/app.log" 2>&1 & echo $! >"$PIDDIR/app.pid")
fi

if running ingestor; then
  echo "ingestor already running (pid $(cat "$PIDDIR/ingestor.pid"))"
else
  echo "starting ingestor..."
  ("$REPO/ingestor/venv/bin/python" "$REPO/ingestor/ingestor.py" \
    >"$REPO/.run/ingestor.log" 2>&1 & echo $! >"$PIDDIR/ingestor.pid")
fi

echo ""
echo "The Nines is up:"
echo "  app:      http://localhost:3000"
echo "  logs:     $REPO/.run/app.log  $REPO/.run/ingestor.log"
echo "  stop:     ./run.sh stop"
echo ""
echo "Next: set up the 5-minute scanner cron (see README.md)."
