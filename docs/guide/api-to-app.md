# API-to-App Pipeline

Generate combinatorial API tests, build a SmartClient app, and verify it with UI tests — all from an OpenAPI spec, in one command.

## The Closed Loop

```
OpenAPI Spec → PICT Models → API Tests (334 pass)
                    ↓
              SmartClient App → Published as Plugin
                    ↓
              CDP UI Tests → Dashboard Assertions
```

## Full-Loop Dashboard Workflow

1. **Select** `api-to-app-pipeline` in the Scripts panel
2. **Click Run** with args: `--endpoint=all --full-loop --seed=42`
3. **Watch** Script History: PICT generation → API test creation → app build → plugin publish → UI test creation
4. **Artifacts tab**: PICT models (.pict), TSV outputs, generated test scripts, app config, handlers
5. **Scripts panel**: generated test scripts auto-register (test-petstore-*, test-ui-pet-app)
6. **Plugins**: pet-app appears in the plugin list — open via wrapper.html?mode=pet-app
7. **Run generated tests**: select any test script, click Run, see assertions

### Scheduling

Run the full loop on a cron schedule:
- Script: `api-to-app-pipeline`
- Args: `--endpoint=all --full-loop --run --seed=42`
- Cron: `0 6 * * *` (daily at 6am)

## Quick Start (CLI)

```bash
# Full loop: API tests + SmartClient app + UI tests
node packages/bridge/api-to-app/pipeline.mjs \
  --endpoint=all --workflow --full-loop --seed=42

# Generate + run API tests only
node packages/bridge/api-to-app/pipeline.mjs \
  --endpoint=all --workflow --run --seed=42

# Single endpoint, dry-run
node packages/bridge/api-to-app/pipeline.mjs \
  --endpoint=findPetsByStatus --dry-run
```

## Pipeline Options

| Flag | Default | Description |
|------|---------|-------------|
| `--spec=<path>` | `specs/petstore-v2.json` | OpenAPI/Swagger spec file |
| `--endpoint=<id>` | `findPetsByStatus` | Operation ID, or `all` for all endpoints |
| `--base-url=<url>` | `https://petstore.swagger.io/v2` | Target API base URL |
| `--seed=<n>` | random | Deterministic PICT seed for reproducibility |
| `--order=<n>` | 2 (pairwise) | Combinatorial order |
| `--workflow` | off | Generate CRUD workflow test (POST->GET->DELETE) |
| `--build` | off | Generate SmartClient app (programmatic) |
| `--full-loop` | off | Build app + publish as plugin + generate UI tests |
| `--run` | off | Execute generated tests after creating them |
| `--dry-run` | off | Print PICT models without generating scripts |

## What Each Phase Produces

### Phase 1: PICT API Tests
- 10 endpoints, 334 test cases, 100% pass rate
- PICT models saved as .pict files (viewable in dashboard Artifacts)
- TSV outputs with all test rows (viewable in data grid viewer)
- Test scripts auto-registered in script library

### Phase 2: SmartClient App (--full-loop)
- PICT-informed config: filter values from PICT params, grid columns from schema
- Uses `fetchUrlAndLoadGrid` action (calls API directly via HOST_NETWORK_FETCH)
- No custom SW handlers needed (storage-backed plugin)
- Auto-published via BRIDGE_PUBLISH_PLUGIN relay to extension

### Phase 3: CDP UI Tests (--full-loop)
- Generated from the same PICT models that drove API tests
- Opens the published plugin via CDP (port 9222)
- For each PICT filter value: fills form, clicks Fetch, verifies grid
- Screenshots captured as artifacts

## Coverage Numbers (Petstore v2)

| Endpoint | PICT Cases | Pass |
|----------|-----------|------|
| GET /pet/findByStatus | 13 | 13 |
| POST /pet | 69 | 69 |
| PUT /pet | 69 | 69 |
| GET /pet/{petId} | 14 | 14 |
| DELETE /pet/{petId} | 25 | 25 |
| POST /pet/{petId}/uploadImage | 25 | 25 |
| POST /store/order | 69 | 69 |
| GET /store/order/{orderId} | 8 | 8 |
| DELETE /store/order/{orderId} | 8 | 8 |
| GET /store/inventory | 4 | 4 |
| CRUD workflow | 6 | 6 |
| **Total** | **310+** | **100%** |

## How PICT Models Are Built

Each endpoint's parameters become PICT parameters with representative values:

- **Enum values**: all options + `~unknown_enum`
- **Integers**: `1, 100, 9999, ~-1, ~abc`
- **Strings**: `doggie, cat_42, ~empty_string`
- **Date-time**: `2026-04-21T12:00:00Z, ~invalid_date`
- **Nested objects**: shape variants (`valid, id_only, name_only, ~malformed, omit`)
- **Arrays**: object arrays `[{id,name}]` or string arrays `["url"]`
- **Headers**: content-type, accept, auth variations

The `~` prefix marks negative test values. Cases with content-type mismatch (JSON body + XML header) or missing required fields are auto-classified as negative.

## The fetchUrlAndLoadGrid Action

Storage-backed plugins (published from the pipeline) use this renderer action to call APIs directly without custom SW handlers:

```json
{
  "_type": "Button",
  "_action": "fetchUrlAndLoadGrid",
  "_fetchUrl": "https://petstore.swagger.io/v2/pet/findByStatus",
  "_fetchMethod": "GET",
  "_payloadFrom": "filterForm",
  "_targetGrid": "mainGrid",
  "_dynamicFields": true,
  "_flattenObjects": true
}
```

Supports GET (query params) and POST/PUT (JSON body). Flattens nested objects and arrays for grid display.

## Using Your Own API

1. Save your OpenAPI spec as JSON in `packages/bridge/api-to-app/specs/`
2. Run: `node packages/bridge/api-to-app/pipeline.mjs --spec=<path> --base-url=<url> --endpoint=<operationId> --full-loop`
3. The pipeline generates tests, builds the app, publishes it, and creates UI tests

## Pipeline Modules

| Module | Purpose |
|--------|---------|
| `spec-analyzer.mjs` | Parse OpenAPI spec, generate PICT models |
| `pict-runner.mjs` | Execute PICT CLI, parse TSV output |
| `test-generator.mjs` | PICT rows to API test scripts |
| `app-from-pict.mjs` | PICT models + spec to SmartClient plugin |
| `app-generator.mjs` | Programmatic app generation (fallback) |
| `build-driver.mjs` | LLM-enhanced generation |
| `ui-test-generator.mjs` | PICT models to CDP UI test scripts |
| `multi-level.mjs` | L0->L1 PICT orchestration with TSV seeding |
| `pipeline.mjs` | Orchestrator (all flags, dashboard integration) |

## Prerequisites

- **PICT**: Install from [github.com/microsoft/pict](https://github.com/microsoft/pict)
- **Node.js 22+**: Uses native `fetch`
- **Bridge server**: Required for dashboard reporting and plugin publish relay
