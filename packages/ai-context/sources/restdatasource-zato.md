---
description: RestDataSource → Bridge → Zato ESB data chain for SmartClient CRUD apps
globs: ["packages/bridge/server.mjs","extension/smartclient-app/renderer.js","docker/zato/**","examples/app-pet-restds*"]
alwaysApply: false
---

# RestDataSource → Bridge → Zato Data Chain

## Architecture

```
SmartClient ListGrid (canEdit, canRemoveRecords)
    ↓ fetch() from sandbox iframe
    ↓ (XHR blocked cross-origin, fetch() works)
Bridge Server :9876 /ds/<EntityDS>
    ↓ HTTP to Zato Docker
Zato REST Channel :11223
    ↓ Python service (SIO)
SQLite Database
```

SmartClient grids get full CRUD (inline edit, add row, delete row) backed by Zato services. The bridge server translates between SmartClient's RestDataSource wire protocol and Zato's REST channels.

## How It Works

### 1. SmartClient DataSource (sandbox iframe)

The renderer creates a `clientCustom` DataSource that uses `fetch()` internally (not XHR, because sandbox XHR is blocked cross-origin):

```javascript
// renderer.js — when config has _type: "RestDataSource"
ds = isc.DataSource.create({
  ID: 'PetDS',
  dataProtocol: 'clientCustom',
  fields: [...],
  transformRequest: function(dsRequest) {
    var url = dataURL + '?_operationType=' + dsRequest.operationType;
    // Add criteria as query params for fetch, JSON body for add/update/remove
    fetch(url, fetchOpts).then(resp => resp.json()).then(result => {
      this.processResponse(dsRequest.requestId, result.response);
    });
  }
});
```

Key: `isc.RPCManager.allowCrossDomainCalls = true` must be set to suppress SmartClient's cross-origin warning dialog.

### 2. Bridge /ds/ Endpoint (HTTP)

The bridge server handles `/ds/<EntityDS>` requests on the same HTTP port (9876):

**Request format** (SmartClient RestDataSource wire protocol):
- Fetch: `GET /ds/PetDS?_operationType=fetch&status=available&_startRow=0&_endRow=75`
- Add: `POST /ds/PetDS` body: `{"_operationType":"add","name":"Rex","status":"available"}`
- Update: `POST /ds/PetDS` body: `{"_operationType":"update","id":4,"name":"New Name"}`
- Remove: `POST /ds/PetDS` body: `{"_operationType":"remove","id":4}`

**Response format** (SmartClient expects):
```json
{
  "response": {
    "status": 0,
    "startRow": 0,
    "endRow": 6,
    "totalRows": 7,
    "data": [{"id": 4, "name": "Buddy", "status": "available", ...}]
  }
}
```

**Entity routing** (`DS_ENTITY_MAP` in server.mjs):
```javascript
PetDS: {
  fetch:     { method: 'GET',    path: '/api/pet/findByStatus', queryParam: 'status' },
  fetchById: { method: 'GET',    path: '/api/pet/id/' },
  add:       { method: 'POST',   path: '/api/pet' },
  update:    { method: 'PUT',    path: '/api/pet/update' },
  remove:    { method: 'DELETE', path: '/api/pet/delete/' },
}
```

**Update merge**: SmartClient sends only changed fields. The bridge fetches the current record from Zato, merges with changes, then PUTs the full record.

**Response flattening**: Nested objects (`category: {id:1, name:"Dogs"}`) are flattened to strings (`category: "Dogs"`) for grid display.

### 3. Zato REST Channels (Docker)

Zato 3.3 quickstart in Docker. Services hot-deployed via pickup directory.

**Services** (in `docker/zato/services/petstore/pet.py`):
- `petstore.pet.find-by-status` — GET, filters by status query param
- `petstore.pet.get-by-id` — GET, returns single pet by ID
- `petstore.pet.add` — POST, creates pet from JSON body
- `petstore.pet.update` — PUT, updates pet from JSON body
- `petstore.pet.delete` — DELETE, removes pet by ID

**Zato 3.3 gotchas**:
- `self.request.http.GET` doesn't reliably read query params. Use `self.wsgi_environ['QUERY_STRING']` instead.
- SQLite needs `PRAGMA journal_mode=WAL` and `busy_timeout=5000` for concurrent access from Zato workers.
- URL paths must be unique per channel (no method-based routing on same path). Use `/api/pet/update` for PUT, `/api/pet/delete/{id}` for DELETE.
- Channel creation: `zato create-rest-channel --path /opt/zato/env/qs-1/server1 --name <name> --url-path <path> --service <service>`

### 4. Plugin Config

```json
{
  "dataSources": [{
    "ID": "PetDS",
    "_type": "RestDataSource",
    "dataURL": "http://localhost:9876/ds/PetDS",
    "fields": [
      {"name": "id", "type": "integer", "primaryKey": true},
      {"name": "name", "type": "text", "required": true},
      {"name": "status", "type": "text", "valueMap": {"available":"Available","pending":"Pending","sold":"Sold"}}
    ]
  }],
  "layout": {
    "_type": "VLayout",
    "members": [
      {"_type": "ListGrid", "ID": "petGrid", "dataSource": "PetDS",
       "autoFetchData": true, "canEdit": true, "canRemoveRecords": true},
      {"_type": "Button", "_action": "dsFetch", "_targetGrid": "petGrid", "_payloadFrom": "filterForm"},
      {"_type": "Button", "_action": "dsAdd", "_targetGrid": "petGrid"},
      {"_type": "Button", "_action": "dsSave", "_targetGrid": "petGrid"}
    ]
  }
}
```

### 5. Renderer Actions for DataSource Grids

| Action | What it does |
|--------|-------------|
| `dsFetch` | Calls `grid.fetchData(criteria)` with form values from `_payloadFrom` |
| `dsAdd` | Calls `grid.startEditingNew()` — opens inline edit for a new row |
| `dsSave` | Calls `grid.saveAllEdits()` — commits all pending edits |

These are in addition to `fetchUrlAndLoadGrid` (for plugins without DataSource binding) and `fetchAndLoadGrid` (for handler-based data loading).

## Docker Setup

```bash
cd docker/zato && docker compose up -d   # Start Zato
# Services auto-deployed from docker/zato/services/ volume mount
# Channels created via: docker exec agentidev-zato /opt/zato/current/bin/zato create-rest-channel ...
```

## PICT Testing Against Zato

The same PICT test suite runs against Zato:
```bash
node packages/bridge/api-to-app/pipeline.mjs \
  --spec=packages/bridge/api-to-app/specs/petstore-zato.json \
  --base-url=http://localhost:11223/api \
  --endpoint=all --seed=42
```

239/289 pass (82%). Failures are SQLite concurrency under rapid writes — a real bug PICT exposed.

## Key Files

- `packages/bridge/server.mjs` — `/ds/` endpoint, `DS_ENTITY_MAP`, `handleRestDataSource()`
- `extension/smartclient-app/renderer.js` — RestDataSource creation, `dsFetch`/`dsAdd`/`dsSave` actions
- `docker/zato/services/petstore/pet.py` — Zato services with SQLite
- `docker/zato/docker-compose.yml` — Zato 3.3 quickstart container
- `examples/app-pet-restds-config.json` — Plugin config for RestDataSource CRUD
- `packages/bridge/api-to-app/specs/petstore-zato.json` — Zato-specific OpenAPI spec
