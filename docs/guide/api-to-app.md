# API-to-App Pipeline

Generate combinatorial API test suites from OpenAPI specs using PICT (Pairwise Independent Combinatorial Testing).

## Dashboard Workflow

The pipeline runs from the SmartClient dashboard like any other script:

1. **Select** `api-to-app-pipeline` in the Scripts panel
2. **Click Run** — pipeline appears in Script History with live progress
3. **Click the run** in Script History to see details
4. **Assertions tab** — shows PICT case counts per endpoint
5. **Artifacts tab** — PICT models (.pict), TSV outputs, generated test scripts all render inline
6. **Scripts panel** — generated test scripts auto-register (test-petstore-findPetsByStatus, etc.)
7. **Select a generated test** and click Run to execute the API tests
8. **Assertions tab** — shows per-case pass/fail results in real-time

To generate AND run tests in one shot, add `--run` to the script args (via the dashboard scheduler or the Args field).

### Scheduling

Use the dashboard Schedules panel to run the pipeline on a cron schedule. Add `--run` to the args so generated tests execute automatically:

- Script: `api-to-app-pipeline`
- Args: `--endpoint=all --workflow --run --seed=42`
- Cron: `0 6 * * *` (daily at 6am)

## Quick Start (CLI)

```bash
# Generate tests for one endpoint
node packages/bridge/api-to-app/pipeline.mjs \
  --endpoint=findPetsByStatus --seed=42

# Generate + run tests for all endpoints
node packages/bridge/api-to-app/pipeline.mjs \
  --endpoint=all --workflow --run --seed=42
```

## What It Does

The pipeline reads an OpenAPI spec and for each endpoint:

1. **Analyzes** parameters, body schema, auth, content types
2. **Generates** a PICT model with valid values + negative (`~`) values per parameter
3. **Runs PICT** to produce a minimal pairwise covering array (every pair of values tested)
4. **Generates** a ScriptClient test script and registers it in the script library
5. **Saves** PICT models and TSV outputs as persistent artifacts
6. **Optionally runs** the generated tests (`--run` flag)

## Pipeline Options

| Flag | Default | Description |
|------|---------|-------------|
| `--spec=<path>` | `specs/petstore-v2.json` | OpenAPI/Swagger spec file |
| `--endpoint=<id>` | `findPetsByStatus` | Operation ID, or `all` for pet CRUD |
| `--base-url=<url>` | `https://petstore.swagger.io/v2` | Target API base URL |
| `--seed=<n>` | random | Deterministic PICT seed for reproducibility |
| `--order=<n>` | 2 (pairwise) | Combinatorial order (3=triple, etc.) |
| `--workflow` | off | Also generate a CRUD workflow test |
| `--run` | off | Execute generated tests after creating them |
| `--dry-run` | off | Print PICT models without generating scripts |

## How PICT Models Are Built

Each endpoint's parameters become PICT parameters with representative values:

- **Enum values**: all options + `~unknown_enum`
- **Integers**: `1, 100, 9999, ~-1, ~abc`
- **Strings**: `doggie, cat_42, ~empty_string`
- **Nested objects**: shape variants (`valid, id_only, name_only, ~malformed, omit`)
- **Arrays**: `one_item, multiple_items, ~empty_array`
- **Headers**: content-type, accept, auth variations

The `~` prefix marks invalid/negative test values. PICT ensures every pair of parameters is tested, producing a compact suite (typically 10-70 cases per endpoint vs. thousands for exhaustive).

## Example: GET /pet/findByStatus

**PICT model** (auto-generated):
```
status: available, pending, sold, ~unknown_enum
Accept: application_json, ~text_plain
Auth: valid_auth, ~no_auth, ~invalid_auth
```

**Output**: 13 test cases covering all pairwise combinations. Each case makes a real HTTP request and asserts the response.

## Example: POST /pet

**PICT model** (auto-generated, 9 parameters):
```
body_id: 1, 100, 9999, ~-1, ~abc, omit
body_category_shape: valid, id_only, name_only, ~malformed, omit
body_name: doggie, cat_42, ~empty_string
body_photoUrls: one_item, multiple_items, ~empty_array
body_tags: one_item, multiple_items, omit, ~empty_array
body_status: available, pending, sold, ~unknown_enum, omit
ContentType: application_json, application_xml, ~text_plain
Accept: application_json, ~text_plain
Auth: valid_auth, ~no_auth, ~invalid_auth
```

**Output**: 69 test cases. The body builder constructs JSON from PICT rows, handling nested objects (category), arrays (tags, photoUrls), and omitted fields.

## Workflow Test

The `--workflow` flag generates a stateful CRUD test:

1. **POST /pet** — create with explicit small ID
2. **GET /pet/{id}** — read it back, verify fields
3. **GET /pet/99999999** — non-existent ID (expect 404)
4. **GET /pet/abc** — malformed ID (expect 4xx)
5. **DELETE /pet/{id}** — remove it
6. **GET /pet/{id}** — verify it's gone (expect 404)

## Generated Test Structure

Tests use the ScriptClient pattern — they report to the bridge dashboard with progress, assertions, and artifacts:

```javascript
import { ScriptClient } from '../packages/bridge/script-client.mjs';
const client = new ScriptClient('test-petstore-findPetsByStatus', { totalSteps: 13 });

await client.connect();
for (const testCase of cases) {
  const resp = await fetch(url, options);
  client.assert(resp.status === 200, 'Case N: returns 200');
}
client.summarize();
await client.complete({ assertions: client.getAssertionSummary() });
```

Run from the dashboard Scripts panel, or from CLI with `node examples/test-petstore-*.mjs`.

## Using Your Own API

1. Save your OpenAPI spec as JSON in `packages/bridge/api-to-app/specs/`
2. Run the pipeline with `--spec=<path>` and `--base-url=<url>`
3. Update the `PET_ENDPOINTS` array in `pipeline.mjs` or use `--endpoint=<operationId>`

## Prerequisites

- **PICT**: Install from [github.com/microsoft/pict](https://github.com/microsoft/pict) — must be on PATH
- **Node.js 22+**: Uses native `fetch`
- **Bridge server**: Required for ScriptClient dashboard reporting (optional for standalone runs)

## What's Next

- **LLM build driver**: Feed failing tests + spec to the agent, have it generate service code that makes tests pass
- **Multi-level PICT**: L0 endpoint selection → L1 per-endpoint → L2 nested schemas with TSV seeding
- **Agent integration**: Wire as an agent tool so the pi-mono agent can generate tests from a spec URL
