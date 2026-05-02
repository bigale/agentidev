#!/usr/bin/env bash
# Start the full development stack: asset-server + bridge server + Chromium
# with extension.
#
# Usage:
#   ./packages/bridge/start-dev.sh          # start all three
#   ./packages/bridge/start-dev.sh --stop   # kill all three
#
# Order matters:
#   1. asset-server (port 9877) — serves CheerpX/CheerpJ binaries; the
#      runtime tab won't load without it
#   2. bridge server (port 9876) — extension auto-connects on launch
#   3. browser — opens with the extension loaded

set -e
cd "$(dirname "$0")/../.."

ASSET_PID_FILE="/tmp/agentidev-asset.pid"
BRIDGE_PID_FILE="/tmp/agentidev-bridge.pid"
BROWSER_PID_FILE="/tmp/agentidev-browser.pid"

stop_all() {
  echo "[dev] Stopping..."
  for pidfile in "$ASSET_PID_FILE" "$BRIDGE_PID_FILE" "$BROWSER_PID_FILE"; do
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
  pkill -f "node packages/bridge/asset-server.mjs" 2>/dev/null || true
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

echo "[dev] Starting asset-server..."
node packages/bridge/asset-server.mjs > /tmp/agentidev-asset.log 2>&1 &
echo $! > "$ASSET_PID_FILE"
echo "[dev] Asset-server PID: $(cat $ASSET_PID_FILE)"

# Wait for asset-server to be listening on 9877
for i in $(seq 1 10); do
  if lsof -i :9877 >/dev/null 2>&1; then
    echo "[dev] Asset-server ready on port 9877"
    break
  fi
  sleep 0.5
done

echo "[dev] Starting bridge server..."
node packages/bridge/server.mjs > /tmp/agentidev-bridge.log 2>&1 &
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
DISPLAY="${DISPLAY:-localhost:10.0}" node packages/bridge/launch-browser.mjs > /tmp/agentidev-browser.log 2>&1 &
echo $! > "$BROWSER_PID_FILE"
echo "[dev] Browser PID: $(cat $BROWSER_PID_FILE)"

# Wait for browser + extension
sleep 3
if kill -0 "$(cat $BROWSER_PID_FILE)" 2>/dev/null; then
  echo "[dev] Ready!"
  echo "[dev] Dashboard: check /tmp/agentidev-browser.log for URL"
  echo "[dev] Stop with: ./packages/bridge/start-dev.sh --stop"
  cat /tmp/agentidev-browser.log 2>/dev/null | grep -E '^\{' | head -1
else
  echo "[dev] Browser failed to start. Check /tmp/agentidev-browser.log"
  cat /tmp/agentidev-browser.log
fi
