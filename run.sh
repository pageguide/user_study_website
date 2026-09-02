#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

PYTHON_BIN="${PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="python3"
  elif command -v python >/dev/null 2>&1; then
    PYTHON_BIN="python"
  else
    echo "Could not find python3 or python on PATH." >&2
    exit 1
  fi
fi

START_PORT="${1:-${PORT:-8000}}"
HOST="${HOST:-127.0.0.1}"

PORT="$("$PYTHON_BIN" - "$HOST" "$START_PORT" <<'PY'
import socket
import sys

host = sys.argv[1]
start = int(sys.argv[2])

for port in range(start, start + 100):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            continue
        print(port)
        break
else:
    raise SystemExit(f"No open port found from {start} to {start + 99}")
PY
)"

if [[ ! -f app/config.js ]]; then
  echo "Note: app/config.js is missing. The site will load, but Supabase-backed study screens will not work."
  echo "Create it with: cp app/config.example.js app/config.js"
  echo
fi

echo "Serving PageGuide user study from: $ROOT_DIR"
echo "Local site:   http://$HOST:$PORT/"
echo "Find V2 task: http://$HOST:$PORT/study.html"
echo "Find V2 home: http://$HOST:$PORT/index.html"
echo "Original V1:  http://$HOST:$PORT/find-v1.html"
echo
echo "Press Ctrl-C to stop."

exec "$PYTHON_BIN" -m http.server "$PORT" --bind "$HOST"
