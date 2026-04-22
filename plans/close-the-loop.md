# Plan: Close the API-to-App Loop

## The Loop

```
OpenAPI Spec
    |
    v
[Phase 1: DONE] PICT Test Generation
    Spec analyzer → PICT models → 334 API test cases
    Run against live API → pass/fail results
    |
    v
[Phase 2: BUILD] SmartClient App from PICT Results
    Read PICT models + test results
    Generate SmartClient plugin config:
      - ListGrid bound to GET endpoint (fetchAndLoadGrid)
      - DynamicForm for POST/PUT (fetchAndLoadGrid)
      - Filter form for query params (status dropdown)
      - Error handling informed by negative test findings
    Auto-publish as storage-backed plugin (SC_PUBLISH_PLUGIN)
    |
    v
[Phase 3: TEST] CDP UI Tests from PICT Models
    Read PICT models (same ones that drove API tests)
    Generate CDP test script for the published plugin:
      - Open plugin tab via CDP
      - For each PICT row:
        - Fill form fields with PICT values
        - Click action buttons
        - Verify grid updates / status messages
    Run from dashboard, assertions + screenshots
    |
    v
[Phase 4: ITERATE] Fix and Re-test
    If UI tests fail → adjust the app config
    Re-publish → re-test → green
```

## Phase 2: SmartClient App from PICT Results

### What exists
- `app-generator.mjs` — programmatic config from spec (works, deterministic)
- `build-driver.mjs` — LLM-enhanced generation (works with fallback)
- `SC_PUBLISH_PLUGIN` handler — publishes config as storage-backed plugin
- Agentiface mode — generates SmartClient configs from prompts

### What to build
**`app-from-pict.mjs`** — new module that reads PICT models + TSV outputs and generates a smarter SmartClient config than the generic `app-generator.mjs`.

Key improvements over the generic generator:
1. **Filter form fields from PICT parameters** — the PICT model lists all valid values for each query param. Use these as valueMap options in a SelectItem.
2. **Negative case handling** — PICT test results show which inputs cause errors. Add client-side validation or error display for those cases.
3. **Column types from TSV data** — the TSV output shows actual values returned by the API. Use these to infer grid column widths and types.
4. **Action buttons match tested endpoints** — only generate buttons for endpoints that passed API tests.

### Output
A SmartClient plugin config with:
- `PET_LIST` handler — calls GET /pet/findByStatus via HOST_NETWORK_FETCH
- `PET_CREATE` handler — calls POST /pet
- Filter form with status dropdown (values from PICT model: available, pending, sold)
- ListGrid with columns inferred from actual API response shape
- Create form with fields matching the Pet schema
- Status indicators for error cases

Auto-published via `SC_PUBLISH_PLUGIN` → appears in plugin list → openable in wrapper.html.

## Phase 3: CDP UI Tests from PICT Models

### What exists
- `generate_plugin_test` agent tool — creates CDP tests from component IDs
- `test-csv-analyzer.mjs` — reference CDP test (16 assertions)
- CDP testing infrastructure (port 9222, sandbox eval, screenshots)

### What to build
**`ui-test-generator.mjs`** — reads PICT models and generates a CDP test script that exercises the published SmartClient app.

For each PICT row:
1. Set filter form values (e.g., status = "available")
2. Click the Fetch button
3. Verify the grid loaded data (or showed an error for negative cases)
4. Take a screenshot

This is different from the API tests (which call fetch directly) — these test the actual rendered SmartClient UI components via `isc.AutoTest.getObject()`.

### Test structure
```javascript
// For each PICT row:
await cdpEval(sandbox, `(async function() {
  var form = isc.AutoTest.getObject('//DynamicForm[ID="filterForm"]');
  form.setValue('status', '${row.status}');
  var btn = isc.AutoTest.getObject('//Button[ID="btnFetch"]');
  btn.click();
  await new Promise(r => setTimeout(r, 3000));
  var grid = isc.AutoTest.getObject('//ListGrid[ID="mainGrid"]');
  return { rows: grid.getTotalRows(), status: row.status };
})()`);
```

## Phase 4: Pipeline Integration

### Dashboard workflow
Add `--full-loop` flag to `pipeline.mjs`:

```bash
node packages/bridge/api-to-app/pipeline.mjs \
  --endpoint=all --workflow --seed=42 \
  --full-loop   # generates API tests + builds app + publishes + generates UI tests
```

Steps:
1. Generate PICT models → run API tests (existing)
2. Generate SmartClient app from PICT results → publish as plugin (Phase 2)
3. Generate CDP UI test for the plugin → register in script library (Phase 3)
4. Optionally run the UI test (`--run` flag)

All artifacts visible in dashboard: PICT models, API test results, app config, UI test script, UI test assertions + screenshots.

## Implementation Order

1. **`app-from-pict.mjs`** (~200 lines) — reads PICT models + spec, generates SmartClient config + handlers, publishes as plugin
2. **Wire into pipeline** — add `--full-loop` flag, call app-from-pict after API tests
3. **`ui-test-generator.mjs`** (~200 lines) — reads PICT models + plugin component IDs, generates CDP test script
4. **Wire into pipeline** — generate UI test after plugin publish, register in script library
5. **Test end-to-end** — run full pipeline, verify app renders, UI tests pass
6. **Dashboard** — all steps visible as artifacts with viewers

## Success Criteria

One command produces:
- 334 API tests (all pass)
- A published SmartClient plugin with CRUD UI
- A CDP UI test that verifies the plugin renders and responds to inputs
- All visible in the dashboard with artifacts, assertions, screenshots
