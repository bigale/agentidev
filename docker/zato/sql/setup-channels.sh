#!/bin/bash
# =============================================================================
# Petstore Zato Setup — Automated channel creation and DB initialization
# =============================================================================
#
# Creates all REST channels and initializes the SQLite database.
# Idempotent — safe to run multiple times.
#
# Usage (from host):
#   docker exec agentidev-zato bash /opt/zato/sql/setup-channels.sh
#
# Usage (inside container):
#   bash /opt/zato/sql/setup-channels.sh
# =============================================================================

set -e

ZATO_CLI="/opt/zato/current/bin/zato"
SERVER_PATH="/opt/zato/env/qs-1/server1"
DB_PATH="/opt/zato/petstore.db"
SCHEMA_PATH="/opt/zato/sql/petstore-schema.sql"

# Suppress git warnings from Zato CLI
export GIT_DISCOVERY_ACROSS_FILESYSTEM=0
git config --global --add safe.directory /opt/zato/3.3 2>/dev/null || true

echo "============================================"
echo "  Petstore Zato Setup"
echo "============================================"
echo ""

# --- Step 1: Initialize SQLite database ---
echo "[1/3] Initializing Petstore database..."
python3 -c "
import sqlite3, os
db = '$DB_PATH'
schema = '$SCHEMA_PATH'
if not os.path.exists(schema):
    print('  ERROR: Schema file not found: ' + schema)
    exit(1)
conn = sqlite3.connect(db)
conn.execute('PRAGMA journal_mode=WAL')
conn.execute('PRAGMA busy_timeout=5000')
with open(schema) as f:
    conn.executescript(f.read())
conn.close()
# Verify
conn = sqlite3.connect(db)
pets = conn.execute('SELECT COUNT(*) FROM pets').fetchone()[0]
orders = conn.execute('SELECT COUNT(*) FROM orders').fetchone()[0]
conn.close()
print(f'  Database: {db}')
print(f'  Tables: pets ({pets} rows), orders ({orders} rows)')
print(f'  WAL mode enabled, busy_timeout=5000ms')
"
echo ""

# --- Step 2: Wait for Zato server to be ready ---
echo "[2/3] Checking Zato server..."
MAX_WAIT=60
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  if $ZATO_CLI service invoke $SERVER_PATH zato.ping --payload '{}' >/dev/null 2>&1; then
    echo "  Zato server is ready."
    break
  fi
  echo "  Waiting for Zato server... (${WAITED}s)"
  sleep 5
  WAITED=$((WAITED + 5))
done

if [ $WAITED -ge $MAX_WAIT ]; then
  echo "  ERROR: Zato server not ready after ${MAX_WAIT}s"
  exit 1
fi
echo ""

# --- Step 3: Create REST channels ---
echo "[3/3] Creating REST channels..."

create_channel() {
  local name="$1"
  local url_path="$2"
  local service="$3"

  # Try to create — suppress "already exists" errors for idempotency
  OUTPUT=$($ZATO_CLI create-rest-channel \
    --path $SERVER_PATH \
    --name "$name" \
    --url-path "$url_path" \
    --service "$service" \
    --is-active true \
    2>&1) || true

  if echo "$OUTPUT" | grep -q "already exists"; then
    echo "  EXISTS:  $name -> $url_path"
  elif echo "$OUTPUT" | grep -q "Error"; then
    echo "  ERROR:   $name -> $(echo "$OUTPUT" | grep -o 'Exception:.*' | head -1)"
  else
    echo "  CREATED: $name -> $url_path -> $service"
  fi
}

# Pet channels
create_channel "pet-find-by-status"   "/api/pet/findByStatus"       "petstore.pet.find-by-status"
create_channel "pet-init"             "/api/pet/init"                "petstore.init"
create_channel "pet-add"              "/api/pet"                     "petstore.pet.add"
create_channel "pet-get-by-id"        "/api/pet/id/{pet_id}"        "petstore.pet.get-by-id"
create_channel "pet-delete"           "/api/pet/delete/{pet_id}"    "petstore.pet.delete"
create_channel "pet-update"           "/api/pet/update"              "petstore.pet.update"

# Store/Order channels
create_channel "store-place-order"    "/api/store/order"             "petstore.store.place-order"
create_channel "store-get-order"      "/api/store/order/id/{orderId}" "petstore.store.get-order-by-id"
create_channel "store-delete-order"   "/api/store/order/delete/{orderId}" "petstore.store.delete-order"
create_channel "store-inventory"      "/api/store/inventory"         "petstore.store.get-inventory"

echo ""

# --- Verify ---
echo "============================================"
echo "  Verification"
echo "============================================"
echo ""
echo "Testing endpoints (from inside container)..."

# Test ping
PING=$(python3 -c "
import urllib.request, json
try:
    r = urllib.request.urlopen('http://localhost:17010/zato/ping')
    d = json.loads(r.read())
    print(d.get('zato_env', {}).get('result', 'unknown'))
except Exception as e:
    print('FAILED: ' + str(e))
" 2>&1)
echo "  Zato ping: $PING"

# Test pet list
PETS=$(python3 -c "
import urllib.request, json
try:
    r = urllib.request.urlopen('http://localhost:17010/api/pet/findByStatus?status=available')
    d = json.loads(r.read())
    if isinstance(d, list):
        print(str(len(d)) + ' available pets')
    else:
        print('unexpected response')
except Exception as e:
    print('FAILED: ' + str(e))
" 2>&1)
echo "  GET /api/pet/findByStatus: $PETS"

# Test inventory
INV=$(python3 -c "
import urllib.request, json
try:
    r = urllib.request.urlopen('http://localhost:17010/api/store/inventory')
    d = json.loads(r.read())
    print(json.dumps(d))
except Exception as e:
    print('FAILED: ' + str(e))
" 2>&1)
echo "  GET /api/store/inventory: $INV"

echo ""
echo "============================================"
echo "  Setup complete!"
echo ""
echo "  REST API:   http://localhost:11223/api/"
echo "  Dashboard:  http://localhost:8183"
echo "  Services:   10 (6 pet + 4 store)"
echo "  Channels:   10 REST channels"
echo "  Database:   $DB_PATH (SQLite + WAL)"
echo "============================================"
