#!/bin/bash
# Setup Petstore REST channels in the Zato quickstart container.
# Run after the container is up and services are deployed.
#
# Usage: docker exec agentidev-zato bash /opt/zato/sql/setup-channels.sh
# Or:    ./setup-channels.sh (if running inside the container)

ZATO_CLI="/opt/zato/current/bin/zato"
SERVER_PATH="/opt/zato/env/qs-1/server1"

echo "=== Initializing Petstore DB ==="
python3 -c "
import sqlite3, os
db = '/opt/zato/petstore.db'
if not os.path.exists(db):
    print('Creating database...')
    conn = sqlite3.connect(db)
    with open('/opt/zato/sql/petstore-schema.sql') as f:
        conn.executescript(f.read())
    conn.close()
    print('Done: ' + db)
else:
    print('Database already exists: ' + db)
"

echo ""
echo "=== Creating REST channels ==="
echo "Channels will be created via the web admin or API."
echo ""
echo "Manual setup via web admin (http://localhost:8183):"
echo "1. Go to Connections > Channels > REST"
echo "2. Create channels:"
echo "   - Name: pet-find-by-status | URL: /api/pet/findByStatus | Service: petstore.pet.find-by-status | Method: GET"
echo "   - Name: pet-get-by-id     | URL: /api/pet/*            | Service: petstore.pet.get-by-id     | Method: GET"
echo "   - Name: pet-add           | URL: /api/pet              | Service: petstore.pet.add           | Method: POST"
echo "   - Name: pet-update        | URL: /api/pet              | Service: petstore.pet.update        | Method: PUT"
echo "   - Name: pet-delete        | URL: /api/pet/*            | Service: petstore.pet.delete        | Method: DELETE"
echo ""
echo "Or use the Zato API to create them programmatically."
