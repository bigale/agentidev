# Apps

The SmartClient-based UI delivery surface. Where users actually interact with the product. Renders both code-shipped Plugins (developer-authored) and dynamically created Apps (AI-generated or cloned).

## Ownership

- Renderer engine — `extension/smartclient-app/renderer.js`. Validates configs against `ALLOWED_TYPES`. Resolves IDs via `componentRegistry`. Maps `_action` strings to functions in `ACTION_MAP`. Applies `_formatter` strings to cells. **No eval.**
- Sandbox iframe architecture — `extension/smartclient-app/wrapper.html` loads `app.html` inside a sandbox. Communication is `postMessage` via `bridge.js` (host) ↔ `app.js` (sandbox).
- Dashboard — `dashboard-config.js` (PortalLayout config), `dashboard-app.js` (wiring, `AUTO_BROADCAST_*` handlers).
- Plugin system — `extension/apps/<id>/manifest.json` + `handlers.js` + `templates/*.json`. Modes loaded via `?mode=<pluginId>`.
- App persistence — `sc-apps` IndexedDB database. Distinct from `smartclient-data` (DataSource backing store).
- DataSource bindings — RestDataSource, clientCustom, IndexedDB-backed. SmartClient wire-protocol response format (`{ status: 0, data: [...] }`).
- Monaco editor host — special-cased to survive SmartClient's `DataView` clobber in Simple Names mode.

## Invariants

1. Always `return true` from `chrome.runtime.onMessage.addListener()` for async responses (any handler invoked by Apps via the SW).
2. The renderer never evals user-supplied strings. `_action` and `_formatter` are mapped through whitelists.
3. SmartClient `ISC_DataBinding.js` is **required for forms to accept input** even when there's no DataSource. Without it, the form looks editable but `handleChange` silently throws.
4. Configs must have `dataSources[]` and `layout._type` to pass `validateConfig()` in the AI-generation path.
5. Wrapper iframe URL params have **three load paths** that must not be mixed:
   - `?mode=<pluginId>` → **in-tree Plugin** from `extension/apps/<id>/manifest.json`
   - `?ext=<pluginId>` → **external Plugin** from `EXTERNAL_PLUGINS_DIR/<id>/plugin.json`, fetched via bridge HTTP at `/external-plugins/<id>/plugin.json`
   - `?app=<id>` → **App** (AI-generated or cloned config) from the `sc-apps` IndexedDB database
   In-tree plugin descriptors are named `manifest.json`; external plugin descriptors are named `plugin.json`. The filename split is convention, not validated. See [external-plugin-spec.md](../../external-plugin-spec.md) for the external variant.
6. External plugins are **Apps-context-sufficient by default**. The `?ext=` path requires only `plugin.json` plus a running bridge to serve it — no Zato, no Docker. The Zato `zato/` side-car is optional and only needed if the plugin's DataSources are `RestDataSource` pointing at `/ds/<EntityDS>`. Pure-browser external plugins use `clientCustom` or IndexedDB-backed DataSources and never touch Zato Integration.
6. `componentRegistry` works only in dashboard mode. In Plugin mode, components are reached via `isc.AutoTest.getObject`.

## Public surface

- The wrapper iframe URL — `chrome-extension://<extId>/smartclient-app/wrapper.html?mode=...|?app=...`.
- DataSource integrations:
  - **RestDataSource** → bridge's `/ds/<EntityDS>` endpoint (Zato Integration handles routing).
  - **clientCustom** → `fetch()` from sandbox iframe (used when XHR can't reach the target).
  - **IndexedDB-backed** → handled by `datasource-handlers.js`, falls through if dsId not in `BRIDGE_BACKENDS`.
- AI generation — `SC_GENERATE_UI` from sandbox → bridge → upstream LLM → validated config → auto-saved to `sc-apps`.
- Cell formatters — extension points for new visualizations.

## Failure modes

- SmartClient bundle stripped too aggressively → silent form bugs (DataBinding requirement).
- AutoTest locators may miss components in non-standard nesting → fall back to tree-walking from the root VLayout.
- CheerpX-backed Plugins are fragile: one hung command jams the spawn queue, extension reload kills CheerpX content script connections.
- Sandbox iframe target ordering in CDP varies — always search by URL content, not index.

## Cross-context dependencies

- Memory: dashboard displays vector DB stats, search results, capture controls.
- Automation: dashboard displays Sessions / Scripts / Schedules grids; toolbar buttons dispatch `BRIDGE_*` messages.
- Testing: Test Results portlet displays ScriptClient assertion summaries.
- Zato Integration: RestDataSources reach Zato services through the bridge's `/ds/` endpoint.

Apps is a **pure consumer** of these contexts — it does not own data, it only renders.
