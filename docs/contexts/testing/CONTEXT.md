# Testing

Runtime testing as a product feature, plus dev-time unit testing. Distinguishes itself from the others because **tests are first-class artifacts** — they run from the dashboard, report assertions in real time, and produce viewable artifacts (screenshots, console buffers).

## Ownership

- ScriptClient SDK — `packages/bridge/script-client.mjs`. The Node-side API: `connect()`, `assert(condition, label)`, `artifact({type,label,filePath,contentType})`, `progress(step, totalSteps)`, `complete({assertions})`, checkpoints.
- CDP plugin testing pattern — port 9222 + `isc.AutoTest` API. Documented in `.claude/rules/tests.md`. Reference impl: `examples/test-csv-analyzer.mjs`.
- Test Results portlet — the dashboard surface that displays Assertions and Artifacts post-run.
- AutoTest locators — string-based SmartClient component selectors (`//Button[ID="..."]`, `//ListGrid[ID="..."]/row[index=0]/col[name="..."]`).
- Jest configuration — for handler-level unit tests in `tests/`. Always backgrounded: `npm test &`.

## Open question (deferred)

**api-to-app pipeline placement.** The user's framing is "api-to-app is really api-to-testapp-to-plugin" — the pipeline produces auto-generated test Scripts (Testapp stage) and conceptually should produce a final Plugin (UI wrapping the API). Currently the pipeline lives under `packages/bridge/api-to-app/` and produces ScriptClient-based test scripts in `examples/`. Owns vocabulary: PICT model, spec analyzer, body shape variants (`valid`, `id_only`, `name_only`, `~malformed`, `omit`), negative case (`~` prefix), workflow test, coverage. **Treated as a subdomain of Testing pending term resolution.**

## Invariants

1. Runtime test Scripts use ScriptClient. They report into the dashboard's Test Results portlet via the same bridge protocol as automation Scripts (Testing reuses Automation's machinery).
2. CDP plugin tests use port 9222 to connect to the **extension** browser. Never use Playwright sessions for extension testing — those spawn separate browsers without the extension loaded.
3. AutoTest locators always start with `//`. Never use CSS selectors for SmartClient components — they change on redraws.
4. DS response assertions check `result.status === 0` (success) or `result.status === -1` (error). **Not** `result.success === true`.
5. Jest is dev-only — it does not connect to the bridge. Use it for handler routing logic that's testable without a browser.

## Public surface

- ScriptClient SDK exported from `packages/bridge/script-client.mjs`. Imported by test Scripts in `examples/test-*.mjs`.
- CDP testing pattern — copy-pasted template from `examples/test-csv-analyzer.mjs`, parameterized by `PLUGIN_MODE` and assertions.
- Dashboard panels: Scripts panel (lists available tests), Script History (live + archive), Assertions tab (real-time), Test Results portlet, Artifacts tab.
- Agent-generated tests — the pi-mono agent has `script_save` and `script_launch` tools that follow the CDP pattern.

## Failure modes

- `isc.AutoTest.waitForSystemDone` can hang indefinitely on pages with data-URI images (QR codes). Workaround: `scAutoWait: false` + explicit waits.
- `typeSC` doesn't reliably resolve `//DynamicForm[ID="X"]/item[name="Y"]` locators. Workaround: drive forms via `setValue()` + verify change handler is wired statically as a separate assertion.
- SC button click handlers don't await async returns. For testing async work: trigger once with `clickSC` + deterministic wait, or use `page.evaluate(() => save())` to get a real promise.
- SectionStack rebuilds inner DOM on animate; chart/canvas content gets orphaned. Use `Label.setContents(htmlString)` instead of direct DOM manipulation.

## Test execution paths

Three live in the codebase today:

1. **Jest** — `npm test &`. Runs in Node, mocks bridge functions. Tests handler logic.
2. **ScriptClient Scripts (runtime)** — `examples/test-*.mjs`, executed by the bridge as Scripts. Report into dashboard. Used for end-to-end flows that don't need browser interaction.
3. **CDP plugin tests** — `examples/test-<plugin>.mjs`. Connect via CDP to port 9222, drive SmartClient via `isc.AutoTest`. Used for plugin UI testing.

Each test path has different setup, but all three eventually produce Assertions visible in dev-time output or the dashboard.
