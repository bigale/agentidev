# Zato ESB Backend — Petstore API

Enterprise service bus backend for agentidev, running [Zato](https://zato.io) 3.3 in Docker with SQLite persistence. Provides REST API services that the bridge server proxies to SmartClient dashboards.

## Architecture

```mermaid
graph LR
    subgraph Browser
        SC[SmartClient Grid]
    end
    subgraph Bridge Server :9876
        DS[/ds/PetDS endpoint]
    end
    subgraph Docker
        subgraph Zato Container :11223
            CH[REST Channels]
            SVC[Python Services]
            DB[(SQLite petstore.db)]
        end
    end

    SC -->|fetch CRUD| DS
    DS -->|HTTP proxy| CH
    CH --> SVC
    SVC --> DB

    style SC fill:#4a90d9,color:black
    style DS fill:#f5a623,color:black
    style CH fill:#7ed321,color:black
    style SVC fill:#7ed321,color:black
    style DB fill:#9b59b6,color:black
```

## Quick Start

```bash
# 1. Start the Zato container
cd docker/zato
docker compose up -d

# 2. Wait ~60s for Zato to initialize, then run setup
node setup-channels.mjs

# 3. Verify
curl http://localhost:11223/api/pet/findByStatus?status=available
```

That's it. The setup script handles everything: database initialization, REST channel creation, and endpoint verification.

## What Gets Deployed

| Component | Count | Description |
|-----------|-------|-------------|
| Python services | 10 | 6 pet + 4 store/order |
| REST channels | 10 | One per service, mapped to URL paths |
| SQLite tables | 2 | `pets` (5 seed rows), `orders` (2 seed rows) |

### REST API Endpoints

| Method | Path | Service | Description |
|--------|------|---------|-------------|
| GET | `/api/pet/findByStatus?status=` | petstore.pet.find-by-status | List pets by status |
| GET | `/api/pet/id/{petId}` | petstore.pet.get-by-id | Get single pet |
| POST | `/api/pet` | petstore.pet.add | Create pet |
| PUT | `/api/pet/update` | petstore.pet.update | Update pet |
| DELETE | `/api/pet/delete/{petId}` | petstore.pet.delete | Delete pet |
| POST | `/api/pet/init` | petstore.init | Re-initialize database |
| POST | `/api/store/order` | petstore.store.place-order | Place order |
| GET | `/api/store/order/id/{orderId}` | petstore.store.get-order-by-id | Get order |
| DELETE | `/api/store/order/delete/{orderId}` | petstore.store.delete-order | Delete order |
| GET | `/api/store/inventory` | petstore.store.get-inventory | Pet count by status |

## File Layout

```
docker/zato/
  docker-compose.yml          # Container config with named volume
  setup-channels.mjs          # Host-side setup (runs shell script inside container)
  setup-channels.sh           # Container-side setup (channels + DB + verify)
  services/
    petstore/
      pet.py                  # 6 pet services (PetstoreService base class)
      order.py                # 4 store/order services
  sql/
    petstore-schema.sql       # DDL + seed data
    setup-channels.sh         # Copy accessible inside container (bind-mounted)
    petstore-backup.db        # SQLite backup (gitignored, created by backup command)
  enmasse/                    # Reserved for future enmasse import/export
```

## Data Persistence

```mermaid
graph TB
    subgraph Git Tracked
        SVC[services/ - Python code]
        SQL[sql/ - Schema + seeds]
    end
    subgraph Docker Volume: zato-data
        ENV[/opt/zato/env - Zato runtime]
        ODB[ODB - channel definitions]
        PETDB[petstore.db - application data]
    end
    subgraph Container: agentidev-zato
        HD[/opt/zato/hotdeploy]
        SQLM[/opt/zato/sql]
    end

    SVC -->|bind mount, read-only| HD
    SQL -->|bind mount, read-write| SQLM
    ENV --- ODB
    ENV --- PETDB

    style SVC fill:#4a90d9,color:black
    style SQL fill:#4a90d9,color:black
    style ENV fill:#f5a623,color:black
    style ODB fill:#f5a623,color:black
    style PETDB fill:#f5a623,color:black
```

| Data | Location | Survives `down` | Survives `down -v` | In Git |
|------|----------|:-:|:-:|:-:|
| Python services | `./services/` (bind mount) | Yes | Yes | Yes |
| Schema + seeds | `./sql/` (bind mount) | Yes | Yes | Yes |
| Channel definitions | `zato-data` volume (ODB) | Yes | **No** | No* |
| petstore.db | `zato-data` volume | Yes | **No** | No |

*Channel definitions are recreated by `setup-channels.sh`. The setup is fully idempotent.

### Backup Commands

```bash
# Back up SQLite database
docker exec agentidev-zato cp /opt/zato/petstore.db /opt/zato/sql/petstore-backup.db

# Restore from backup (after docker compose down -v && up -d)
docker exec agentidev-zato cp /opt/zato/sql/petstore-backup.db /opt/zato/petstore.db
```

## Full Reset

To completely rebuild from scratch:

```bash
# Destroy everything (volumes, channels, data)
docker compose down -v

# Rebuild
docker compose up -d

# Wait for Zato (~60s), then setup
node setup-channels.mjs
```

This is safe because:
1. Services are in git (bind-mounted, auto-deployed on start)
2. Schema + seed data are in git (bind-mounted)
3. Channels are created by the setup script (idempotent)

## Client Install Guide

### Prerequisites

- Docker Engine 20.10+ (or Docker Desktop)
- Node.js 18+ (for setup script and bridge server)
- Git (to clone the repo)

### Step-by-Step Install

```bash
# 1. Clone the repo
git clone https://github.com/bigale/agentidev.git
cd agentidev

# 2. Install dependencies
npm install

# 3. Start Zato backend
cd docker/zato
docker compose up -d

# 4. Wait for Zato to be ready (~60s)
#    Watch logs until you see "Ready":
docker logs -f agentidev-zato 2>&1 | grep -m1 "Ready"

# 5. Run automated setup
node setup-channels.mjs

# 6. Start the bridge server (from repo root)
cd ../..
npm run bridge &

# 7. Verify the full stack
curl http://localhost:11223/api/pet/findByStatus?status=available   # Zato direct
curl http://localhost:9876/ds/PetDS?_operationType=fetch             # Bridge proxy
```

### Verification Checklist

- [ ] `docker ps` shows `agentidev-zato` running and healthy
- [ ] `curl localhost:11223/zato/ping` returns `ZATO_OK`
- [ ] `curl localhost:11223/api/pet/findByStatus?status=available` returns pets JSON
- [ ] `curl localhost:11223/api/store/inventory` returns status counts
- [ ] Setup script reports all 10 channels EXISTS or CREATED
- [ ] Bridge `/ds/PetDS` returns SmartClient response format
- [ ] Dashboard at `http://localhost:8183` is accessible

### Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Container won't start | Port conflict on 11223 or 8183 | `docker ps -a`, stop conflicting containers |
| Setup script times out | Zato not ready yet | Wait longer, check `docker logs agentidev-zato` |
| Channels not created | Services not deployed | Check `docker exec agentidev-zato ls /opt/zato/env/qs-1/server1/pickup/incoming/services/` |
| 404 on API calls | Channels missing | Re-run `node setup-channels.mjs` |
| SQLite lock errors | Concurrent writes | WAL mode + busy_timeout should handle this; reduce concurrent test parallelism |
| Bridge /ds/ returns error | Zato not reachable from host | Check `ZATO_URL` in bridge server, default `http://localhost:11223` |

## Service Architecture

Services follow [Zato REST tutorial](https://zato.io/en/tutorials/rest-api/python.html) best practices:

- **Base class** (`PetstoreService`): shared `success_response()`, `error_response()`, `get_path_id()`, `parse_category()`, `parse_array_field()`
- **Meta envelope**: `{meta: {cid, is_ok, timestamp}, data: {...}}` for mutation responses
- **Correlation ID**: `self.cid` in every response and log entry
- **Structured logging**: `self.logger.info(f'cid:{self.cid} -> ...')`
- **SQLite tuning**: WAL journal mode, 5s busy timeout for concurrent Zato workers
- **Query params**: Parsed from `wsgi_environ['QUERY_STRING']` (Zato 3.3 compatibility)

### Zato 3.3 Gotchas

- `self.request.http.GET` does not reliably read query params — use `wsgi_environ['QUERY_STRING']` instead
- URL paths must be unique per channel — no method-based routing on the same path
- Hot-deploy via pickup directory; each `.py` file is loaded independently (no cross-file imports)
- The `PetstoreService` base class is duplicated in `pet.py` and `order.py` because Zato loads each file in isolation

## Integration with Bridge Server

The bridge server (`packages/bridge/server.mjs`) acts as a proxy between SmartClient dashboards and Zato:

```
SmartClient ListGrid → fetch(/ds/PetDS?_operationType=fetch&status=available)
  → Bridge translates to → GET http://localhost:11223/api/pet/findByStatus?status=available
  → Zato service queries SQLite → returns JSON
  → Bridge wraps in SmartClient response format → Grid renders data
```

Entity routing is defined in `DS_ENTITY_MAP` in `server.mjs`. See the [RestDataSource documentation](../../packages/ai-context/sources/restdatasource-zato.md) for full details.

## PICT Test Coverage

Run the PICT combinatorial test suite against the Zato backend:

```bash
# Generate and run all tests
node packages/bridge/api-to-app/pipeline.mjs \
  --spec=packages/bridge/api-to-app/specs/petstore-zato.json \
  --base-url=http://localhost:11223/api \
  --endpoint=all --seed=42 --run
```

Current pass rate: 239/289 (82%). Remaining failures are SQLite concurrency under rapid parallel writes — a real bug that PICT testing exposed.
