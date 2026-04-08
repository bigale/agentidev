#!/usr/bin/env bash
# Start the full development stack: bridge server + Chromium with extension.
#
# Usage:
#   ./packages/bridge/start-dev.sh          # start both
#   ./packages/bridge/start-dev.sh --stop   # kill both
#
# The bridge server must start first so the extension can auto-connect.

set -e
cd "$(dirname "$0")/../.."

BRIDGE_PID_FILE="/tmp/contextual-recall-bridge.pid"
BROWSER_PID_FILE="/tmp/contextual-recall-browser.pid"

stop_all() {
  echo "[dev] Stopping..."
  for pidfile in "$BRIDGE_PID_FILE" "$BROWSER_PID_FILE"; do
    if [ -f "$pidfile" ]; then
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null
        echo "[dev] Killed PID $pid"
      fi
      rm -f "$pidfile"
    fi
  done
  # Sweep any orphans
  pkill -f "node packages/bridge/server.mjs" 2>/dev/null || true
  pkill -f "node packages/bridge/launch-browser.mjs" 2>/dev/null || true
  echo "[dev] Stopped."
}

if [ "$1" = "--stop" ]; then
  stop_all
  exit 0
fi

# Stop anything already running
stop_all 2>/dev/null

echo "[dev] Starting bridge server..."
node packages/bridge/server.mjs > /tmp/contextual-recall-bridge.log 2>&1 &
echo $! > "$BRIDGE_PID_FILE"
echo "[dev] Bridge PID: $(cat $BRIDGE_PID_FILE)"

# Wait for bridge to be listening
for i in $(seq 1 10); do
  if lsof -i :9876 >/dev/null 2>&1; then
    echo "[dev] Bridge server ready on port 9876"
    break
  fi
  sleep 0.5
done

echo "[dev] Launching Chromium with extension..."
DISPLAY="${DISPLAY:-localhost:10.0}" node packages/bridge/launch-browser.mjs > /tmp/contextual-recall-browser.log 2>&1 &
echo $! > "$BROWSER_PID_FILE"
echo "[dev] Browser PID: $(cat $BROWSER_PID_FILE)"

# Wait for browser + extension
sleep 3
if kill -0 "$(cat $BROWSER_PID_FILE)" 2>/dev/null; then
  echo "[dev] Ready!"
  echo "[dev] Dashboard: check /tmp/contextual-recall-browser.log for URL"
  echo "[dev] Stop with: ./packages/bridge/start-dev.sh --stop"
  cat /tmp/contextual-recall-browser.log 2>/dev/null | grep -E '^\{' | head -1
else
  echo "[dev] Browser failed to start. Check /tmp/contextual-recall-browser.log"
  cat /tmp/contextual-recall-browser.log
fi
