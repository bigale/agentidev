# Zato Petstore Quickstart — Integration Plan

## Goal

Stand up a Zato instance, implement the Petstore API as Zato services with SQLite persistence, connect the agentidev bridge as a proxy, and run the existing PICT test suite against it. Close the loop: the same tests that pass against the public Petstore API should pass against our own Zato implementation.

## Why

This proves the full stack works end-to-end:
- Zato as the backend ESB (services, channels, database)
- Bridge as the frontend ESB (agent, UI, testing)
- SmartClient as the UI (RestDataSource bound to Zato via bridge)
- PICT as the test framework (same models, different target)

## Prerequisites

- Docker installed
- agentidev repo with bridge server
- PICT installed (`/usr/local/bin/pict`)

## Step 1: Start Zato Quickstart

```bash
# Pull and run the Zato quickstart container
docker run -d --name zato \
  -p 11223:11223 \
  -p 8183:8183 \
  zatosource/zato-quickstart

# Wait for it to be ready (~30-60 seconds)
docker logs -f zato 2>&1 | grep -m1 "Ready"
```

Verify:
```bash
curl http://localhost:11223/zato/ping
# Should return: {"zato_env": {"result": "ZATO_OK", ...}}
```

Dashboard: http://localhost:8183 (admin/admin or as shown in logs)

## Step 2: Create Petstore Services

### Pet schema (SQLite)

```sql
-- Create via Zato's built-in SQLite or use an outgoing SQL connection
CREATE TABLE IF NOT EXISTS pets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'available' CHECK(status IN ('available', 'pending', 'sold')),
    category_id INTEGER,
    category_name TEXT,
    photo_urls TEXT DEFAULT '[]',
    tags TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Seed with test data
INSERT INTO pets (id, name, status, category_id, category_name) VALUES
    (1, 'Rex', 'available', 1, 'Dogs'),
    (2, 'Whiskers', 'pending', 2, 'Cats'),
    (3, 'Goldie', 'sold', 3, 'Fish');
```

### Service: get-pets-by-status

```python
# services/petstore/pet.py
from zato.server.service import Service
import json

class GetPetsByStatus(Service):
    """GET /api/pet/findByStatus?status=available"""
    
    class SimpleIO:
        input_optional = ('status',)
    
    def handle(self):
        status = self.request.input.get('status', 'available')
        
        with self.outgoing.sql['petstore-db'].session() as session:
            result = session.execute(
                'SELECT * FROM pets WHERE status = :status',
                {'status': status}
            ).fetchall()
        
        pets = []
        for row in result:
            pets.append({
                'id': row.id,
                'name': row.name,
                'status': row.status,
                'category': {'id': row.category_id, 'name': row.category_name},
                'photoUrls': json.loads(row.photo_urls) if row.photo_urls else [],
                'tags': json.loads(row.tags) if row.tags else [],
            })
        
        self.response.payload = json.dumps(pets)
        self.response.content_type = 'application/json'


class GetPetById(Service):
    """GET /api/pet/{petId}"""
    
    class SimpleIO:
        input_required = ('pet_id',)
    
    def handle(self):
        pet_id = self.request.input.pet_id
        
        with self.outgoing.sql['petstore-db'].session() as session:
            row = session.execute(
                'SELECT * FROM pets WHERE id = :id',
                {'id': pet_id}
            ).fetchone()
        
        if not row:
            self.response.status_code = 404
            self.response.payload = json.dumps({'code': 404, 'message': 'Pet not found'})
            return
        
        self.response.payload = json.dumps({
            'id': row.id,
            'name': row.name,
            'status': row.status,
            'category': {'id': row.category_id, 'name': row.category_name},
            'photoUrls': json.loads(row.photo_urls) if row.photo_urls else [],
            'tags': json.loads(row.tags) if row.tags else [],
        })
        self.response.content_type = 'application/json'


class AddPet(Service):
    """POST /api/pet"""
    
    def handle(self):
        data = json.loads(self.request.raw_request)
        
        with self.outgoing.sql['petstore-db'].session() as session:
            result = session.execute(
                '''INSERT INTO pets (name, status, category_id, category_name, photo_urls, tags)
                   VALUES (:name, :status, :cat_id, :cat_name, :photos, :tags)''',
                {
                    'name': data.get('name', ''),
                    'status': data.get('status', 'available'),
                    'cat_id': data.get('category', {}).get('id'),
                    'cat_name': data.get('category', {}).get('name'),
                    'photos': json.dumps(data.get('photoUrls', [])),
                    'tags': json.dumps(data.get('tags', [])),
                }
            )
            session.commit()
            pet_id = result.lastrowid
        
        self.response.payload = json.dumps({
            'id': pet_id,
            'name': data.get('name'),
            'status': data.get('status', 'available'),
        })
        self.response.content_type = 'application/json'


class DeletePet(Service):
    """DELETE /api/pet/{petId}"""
    
    class SimpleIO:
        input_required = ('pet_id',)
    
    def handle(self):
        pet_id = self.request.input.pet_id
        
        with self.outgoing.sql['petstore-db'].session() as session:
            session.execute('DELETE FROM pets WHERE id = :id', {'id': pet_id})
            session.commit()
        
        self.response.status_code = 200
        self.response.payload = json.dumps({'code': 200, 'message': 'Pet deleted'})
        self.response.content_type = 'application/json'
```

### Deploy services

```bash
# Copy services into the running container
docker cp services/petstore/pet.py zato:/opt/zato/env/server1/pickup/incoming/services/

# Zato hot-deploys automatically from the pickup directory
# Verify in logs:
docker logs zato 2>&1 | tail -5
```

## Step 3: Configure REST Channels (enmasse.yaml)

```yaml
# enmasse/petstore-channels.yaml
channel_rest:
  - name: pet-find-by-status
    service: petstore.pet.get-pets-by-status
    url_path: /api/pet/findByStatus
    method: GET
    data_format: json
    
  - name: pet-get-by-id
    service: petstore.pet.get-pet-by-id
    url_path: /api/pet/{pet_id}
    method: GET
    data_format: json
    
  - name: pet-add
    service: petstore.pet.add-pet
    url_path: /api/pet
    method: POST
    data_format: json
    
  - name: pet-delete
    service: petstore.pet.delete-pet
    url_path: /api/pet/{pet_id}
    method: DELETE
    data_format: json

outgoing_sql:
  - name: petstore-db
    engine: sqlite
    db_name: /opt/zato/petstore.db
    pool_size: 5
```

Deploy:
```bash
# Copy enmasse file and import
docker cp enmasse/petstore-channels.yaml zato:/tmp/
docker exec zato /opt/zato/env/server1/zato enmasse \
  /opt/zato/env/server1 --import --input /tmp/petstore-channels.yaml
```

Verify:
```bash
curl http://localhost:11223/api/pet/findByStatus?status=available
# Should return: [{"id": 1, "name": "Rex", ...}]
```

## Step 4: Connect the Bridge

Add a `ZATO_URL` environment variable to the bridge and create proxy handlers.

```javascript
// packages/bridge/handlers/zato-proxy.mjs
// Generic proxy: any ZATO_* message type gets forwarded to Zato

const ZATO_URL = process.env.ZATO_URL || 'http://localhost:11223';

export function registerZatoProxy(handlers) {
  // Proxy handler: ZATO_PET_LIST → GET /api/pet/findByStatus
  handlers['ZATO_PET_LIST'] = async (msg) => {
    const url = `${ZATO_URL}/api/pet/findByStatus?status=${msg.status || 'available'}`;
    const resp = await fetch(url);
    const data = await resp.json();
    return { success: true, data, totalRows: data.length };
  };
  
  handlers['ZATO_PET_GET'] = async (msg) => {
    const resp = await fetch(`${ZATO_URL}/api/pet/${msg.petId}`);
    if (resp.status === 404) return { success: false, error: 'Not found' };
    return { success: true, data: [await resp.json()], totalRows: 1 };
  };
  
  handlers['ZATO_PET_CREATE'] = async (msg) => {
    const resp = await fetch(`${ZATO_URL}/api/pet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    return { success: true, data: [await resp.json()], totalRows: 1 };
  };
  
  handlers['ZATO_PET_DELETE'] = async (msg) => {
    await fetch(`${ZATO_URL}/api/pet/${msg.petId}`, { method: 'DELETE' });
    return { success: true };
  };
}
```

## Step 5: Run PICT Tests Against Zato

The existing PICT test suite targets `https://petstore.swagger.io/v2`. Retarget it to `http://localhost:11223`:

```bash
# Generate tests pointing at our Zato instance
node packages/bridge/api-to-app/pipeline.mjs \
  --endpoint=all --workflow --seed=42 \
  --base-url=http://localhost:11223/api

# Run them
node examples/test-petstore-findPetsByStatus.mjs
node examples/test-pet-state-machine.mjs
```

**Expected results**: Same PICT models, same test scripts, different target. Tests that pass against the public Petstore should pass against our Zato implementation. Any failures indicate missing behavior in our services.

## Step 6: SmartClient Dashboard Bound to Zato

Two options:

### Option A: fetchUrlAndLoadGrid (now)

The existing pet-app plugin already works — just change the `_fetchUrl` to point at Zato:

```json
{
  "_action": "fetchUrlAndLoadGrid",
  "_fetchUrl": "http://localhost:11223/api/pet/findByStatus",
  "_payloadFrom": "filterForm",
  "_targetGrid": "mainGrid"
}
```

### Option B: RestDataSource (next)

SmartClient RestDataSource bound to Zato channels via bridge proxy:

```json
{
  "dataSources": [{
    "ID": "PetDS",
    "_type": "RestDataSource",
    "dataURL": "/ds/PetDS",
    "fields": [
      {"name": "id", "type": "integer", "primaryKey": true},
      {"name": "name", "type": "text", "required": true},
      {"name": "status", "type": "text", "valueMap": {"available":"Available","pending":"Pending","sold":"Sold"}}
    ]
  }]
}
```

The bridge implements the SmartClient RestDataSource wire protocol and translates to Zato REST channel calls. This gives SmartClient grids inline editing, add/delete rows, paging, and sorting — all backed by Zato services.

## Step 7: Agent-Driven Zato Development

The agent can now do the full workflow from chat:

```
User: "Add a updatePetStatus service to Zato"

Agent:
1. Generates Python service class (UpdatePetStatus with SIO)
2. Generates enmasse.yaml channel entry (PUT /api/pet/{pet_id}/status)
3. Saves files via bridge script_save
4. Deploys via: docker cp + zato enmasse
5. Generates PICT model for the new endpoint
6. Runs tests to verify
7. Updates the SmartClient dashboard with an "Update Status" button
```

## File Layout

```
agentidev/
├── docker/
│   └── zato/
│       ├── docker-compose.yml
│       ├── services/
│       │   └── petstore/
│       │       └── pet.py              # Zato services
│       ├── enmasse/
│       │   └── petstore-channels.yaml  # REST channel definitions
│       └── sql/
│           └── petstore-schema.sql     # SQLite DDL + seed data
├── packages/bridge/
│   ├── handlers/
│   │   └── zato-proxy.mjs             # Bridge → Zato proxy handlers
│   └── api-to-app/
│       └── specs/
│           └── petstore-zato.json     # Our Zato's OpenAPI spec
```

## Implementation Sequence

1. **Docker setup** (~30 min): docker-compose.yml, verify Zato starts
2. **Schema + seed data** (~15 min): SQLite DDL, insert test pets
3. **Services** (~1 hour): 4 Python services (list, get, create, delete)
4. **Channels** (~15 min): enmasse.yaml, deploy, verify with curl
5. **Bridge proxy** (~30 min): zato-proxy.mjs handlers
6. **PICT retarget** (~15 min): pipeline with --base-url=localhost:11223
7. **Verify** (~15 min): all 254 functional tests pass against Zato

Total estimated time: **~3 hours** to a working Petstore on Zato with PICT test coverage.

## Success Criteria

1. `docker-compose up` starts Zato + bridge
2. `curl localhost:11223/api/pet/findByStatus?status=available` returns pets
3. All 254 PICT functional tests pass against `localhost:11223`
4. State machine test (23 transitions) passes against Zato
5. pet-app SmartClient plugin works with Zato as backend
6. Agent can generate and deploy a new service from chat
