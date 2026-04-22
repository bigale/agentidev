<!-- Generated from packages/ai-context/sources/. Do not edit directly. -->

---
description: api-to-app pipeline — OpenAPI spec to PICT-driven test scripts and API scaffolding
paths: ["packages/bridge/api-to-app/**","examples/test-petstore-*"]
---


# api-to-app Pipeline

PICT-driven test generation from OpenAPI specs. Reads a spec, generates combinatorial test models via PICT, and produces runnable ScriptClient test scripts.

## Architecture

```
OpenAPI Spec (JSON)
  spec-analyzer.mjs → PICT model text
  pict-runner.mjs   → PICT CLI → TSV rows
  test-generator.mjs → .mjs test script (ScriptClient + fetch)
  pipeline.mjs      → orchestrator (bridge script)
```

All modules are in `packages/bridge/api-to-app/`. Specs cached in `specs/`, generated tests in `examples/`.

## Modules

### spec-analyzer.mjs

- `loadSpec(path)` — parse JSON spec file
- `extractEndpoints(spec)` — walk paths, return endpoint descriptors
- `generatePictModel(endpoint, spec)` — generate PICT model text + paramMeta
- Handles both OpenAPI 3.0 and Swagger 2.0
- Resolves `$ref` to definitions/components
- Flattens body objects: scalar fields become PICT params, nested objects become shape variants (`valid`, `id_only`, `name_only`, `~malformed`, `omit`), arrays become count variants

### pict-runner.mjs

- `runPict(modelText, options)` — write model to temp file, execute `pict` CLI, return TSV
- `parseTsv(tsvString)` — split TSV into `{ headers, rows }` objects
- `runAndParse(modelText, options)` — convenience wrapper
- `isPictAvailable()` — check if `pict` binary is on PATH
- Options: `order` (default 2=pairwise), `seed` (deterministic), `seedFile` (TSV), `caseSensitive`

### test-generator.mjs

- `generateTestScript(analysis, rows, options)` — produce a complete `.mjs` test script
  - Builds fetch calls from PICT rows (query params, path params, JSON body, headers)
  - `~`-prefixed values flag negative test cases (expect 4xx or lenient 200)
  - GET/DELETE accept 404 as valid for stateful endpoints (shared server)
  - Uses ScriptClient for assertions and dashboard reporting
- `generateWorkflowTest(analyses, baseUrl, options)` — stateful CRUD test (POST→GET→DELETE)
  - Uses explicit small IDs to avoid JS int64 precision loss
  - Verifies create, read, read-not-found, read-malformed, delete, read-after-delete

### pipeline.mjs (bridge script)

Dashboard-integrated orchestrator. Reports progress, assertions, and artifacts via ScriptClient. Uses dynamic imports to work from any location (repo or `~/.agentidev/scripts/` copy).

```bash
# Generate tests (view in dashboard Artifacts tab)
node packages/bridge/api-to-app/pipeline.mjs \
  --endpoint=all --workflow --seed=42

# Generate AND run tests in one shot
node packages/bridge/api-to-app/pipeline.mjs \
  --endpoint=all --workflow --run --seed=42
```

Options: `--spec`, `--endpoint` (operationId or "all"), `--base-url`, `--output`, `--order`, `--seed`, `--workflow`, `--build`, `--run`, `--dry-run`

### Dashboard workflow

1. Select `api-to-app-pipeline` in Scripts panel → Run
2. Pipeline appears in Script History with live progress
3. Artifacts tab: PICT models, TSV outputs, generated test scripts (rendered inline)
4. Generated tests auto-register in Scripts panel for one-click re-run
5. Schedule with `--run` flag for automated generate+test on a cron

## PICT Model Generation

For each endpoint, the analyzer generates PICT parameters from:

| Source | PICT Parameter | Values |
|--------|---------------|--------|
| Query param with enum | `status` | `available, pending, sold, ~unknown_enum` |
| Path param (integer) | `petId` | `1, 100, 9999, ~-1, ~abc` |
| Body field (string) | `body_name` | `doggie, cat_42, ~empty_string` |
| Body field (enum) | `body_status` | `available, pending, sold, ~unknown_enum, omit` |
| Body field (nested obj) | `body_category_shape` | `valid, id_only, name_only, ~malformed, omit` |
| Body field (array) | `body_photoUrls` | `one_item, multiple_items, ~empty_array` |
| Content-Type (POST/PUT) | `ContentType` | `application_json, application_xml, ~text_plain` |
| Accept header | `Accept` | `application_json, ~text_plain` |
| Auth | `Auth` | `valid_auth, ~no_auth, ~invalid_auth` |

Negative values (`~` prefix) are stripped before sending but flag the test case as expecting error responses.

## Coverage Numbers (Petstore v2)

| Endpoint | Params | PICT Cases | Notes |
|----------|--------|-----------|-------|
| GET /pet/findByStatus | 3 | 13 | query enum + accept + auth |
| POST /pet | 9 | 69 | body fields + content-type + auth |
| GET /pet/{petId} | 3 | 14 | path int + accept + auth |
| DELETE /pet/{petId} | 4 | 25 | path int + header + accept + auth |
| CRUD workflow | — | 6 | stateful: POST→GET→GET(404)→GET(abc)→DELETE→GET(gone) |

## Key Patterns

### Body construction from PICT rows

Body fields are prefixed `body_` in PICT params. The test generator builds JSON from these:
- Scalar: `body_name=doggie` → `{ name: "doggie" }`
- Enum: `body_status=available` → `{ status: "available" }`
- Nested: `body_category_shape=valid` → `{ category: { id: 1, name: "Test" } }`
- Array: `body_photoUrls=one_item` → `{ photoUrls: ["https://..."] }`
- Omit: `body_status=omit` → field excluded from body

### Negative value handling

`~` prefix signals an invalid input. The PICT model includes negatives like `~-1`, `~abc`, `~unknown_enum`, `~empty_string`. In generated tests:
- Value is stripped: `~abc` → `abc` is actually sent
- Test expects 4xx OR lenient 200 (some servers don't validate strictly)
- Console logs whether server was strict or lenient

### Stateful endpoint tolerance

GET/DELETE with path IDs may return 404 on shared servers (resource doesn't exist). Generated tests accept 404 for non-POST positive cases. For strict testing, use the workflow test which creates its own data.

## Adding New Endpoints

1. Add the operationId to `PET_ENDPOINTS` array in pipeline.mjs (or use `--endpoint=operationId`)
2. If the endpoint has a complex body schema with nested `$ref`, check that `spec-analyzer` resolves it correctly
3. Run `--dry-run` first to verify the PICT model looks right
4. The test generator auto-handles GET/POST/PUT/DELETE differences

## PICT Binary

PICT must be installed at `/usr/local/bin/pict` (or on PATH). Install from https://github.com/microsoft/pict. The runner writes temp files to `/tmp/` and cleans up after execution.
