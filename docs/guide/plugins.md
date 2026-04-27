# Plugin Development

Plugins add custom tools and UIs to agentidev. Each plugin is a directory under `extension/apps/` with a manifest, handlers, and templates.

## Plugin Structure

```
extension/apps/my-plugin/
├── manifest.json       # Plugin metadata
├── handlers.js         # SW handler registration
└── templates/
    └── dashboard.json  # SmartClient UI config
```

## Manifest

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "What it does",
  "modes": ["my-plugin"],
  "templates": {
    "dashboard": "templates/dashboard.json"
  },
  "handlers": "handlers.js",
  "requires": {
    "hostCapabilities": ["network", "exec"],
    "runtimes": ["cheerpx"]
  }
}
```

## Handlers

Handlers are registered in the service worker's dispatch table. They can call any other handler including platform handlers.

```javascript
export function register(handlers) {
  handlers['MY_PLUGIN_ACTION'] = async (msg) => {
    // Call platform handlers
    const data = await handlers['HOST_NETWORK_FETCH']({
      url: msg.url, as: 'text'
    });
    return { success: true, data: data.text };
  };
}
```

### Available Platform Handlers

| Handler | What it does |
|---------|-------------|
| `HOST_NETWORK_FETCH` | Fetch any URL (CORS-free) |
| `HOST_EXEC_SPAWN` | Run command in CheerpX VM |
| `HOST_FS_READ/WRITE/LIST` | VM filesystem operations |
| `HOST_FS_UPLOAD` | Fetch URL → write to VM filesystem |
| `HOST_STORAGE_GET/SET/DEL` | Key-value storage (chrome.storage.local) |
| `PLUGIN_LIST` | List installed plugins |
| `cheerpx-spawn` | Direct CheerpX process execution |
| `cheerpj-runMain` | Run Java class via CheerpJ |

## Dashboard Template

The `dashboard.json` file defines a SmartClient UI config:

```json
{
  "layout": {
    "_type": "VLayout",
    "width": "100%",
    "height": "100%",
    "members": [
      {
        "_type": "Label",
        "height": 28,
        "contents": "<b>My Plugin</b>"
      },
      {
        "_type": "Button",
        "ID": "btnAction",
        "title": "Do Something",
        "_action": "dispatchAndDisplay",
        "_messageType": "MY_PLUGIN_ACTION",
        "_messagePayload": { "url": "https://example.com" },
        "_targetCanvas": "resultFlow",
        "_resultFormatter": "stdoutPre",
        "_timeoutMs": 15000
      },
      {
        "_type": "HTMLFlow",
        "ID": "resultFlow",
        "height": "*",
        "contents": "<em>Click the button</em>"
      }
    ]
  }
}
```

## Actions

Actions wire buttons to handler calls:

| Action | Purpose | Key Props |
|--------|---------|-----------|
| `dispatchAndDisplay` | Call handler, show result in target | `_messageType`, `_messagePayload`, `_targetCanvas`, `_resultFormatter` |
| `fetchAndLoadGrid` | Call handler, load array into grid | `_messageType`, `_targetGrid`, `_payloadFrom`, `_dynamicFields` |
| `fetchUrlAndLoadGrid` | Call URL directly (no handler), load into grid | `_fetchUrl`, `_fetchMethod`, `_payloadFrom`, `_targetGrid`, `_flattenObjects` |
| `streamSpawnAndAppend` | Stream CheerpX output | `_cmd`, `_args`, `_targetCanvas` |
| `dispatch` | Fire-and-forget handler call | `_messageType`, `_messagePayload` |
| `new/save/delete/select` | CRUD on DataSources | `_targetForm`, `_targetGrid` |

`fetchUrlAndLoadGrid` is for storage-backed plugins (published from api-to-app pipeline) that can't register SW handlers. It calls `HOST_NETWORK_FETCH` directly with the API URL.

### Reading Form Values

Use `_payloadFrom` to read form values at click time:

```json
{
  "_type": "Button",
  "_action": "fetchAndLoadGrid",
  "_messageType": "MY_QUERY",
  "_payloadFrom": "queryForm",
  "_targetGrid": "resultsGrid",
  "_dynamicFields": true
}
```

The `_dynamicFields` flag rebuilds grid columns from the response's `columns` array — needed for queries where the schema isn't known upfront.

## Allowed Component Types

`VLayout`, `HLayout`, `ListGrid`, `DynamicForm`, `Button`, `Label`, `TabSet`, `Tab`, `DetailViewer`, `SectionStack` (no nested items — use VLayout instead), `HTMLFlow`, `Window`, `ToolStrip`, `ToolStripButton`, `PortalLayout`, `Portlet`, `Canvas`, `Progressbar`, `ImgButton`, `ToolStripSeparator`, `ToolStripMenuButton`, `Menu`, `ForgeListGrid`

## Result Formatters

| Formatter | Output |
|-----------|--------|
| `stdoutPre` | Monospace preformatted text |
| `json` | Pretty-printed JSON |
| `text` | Plain text |
| `rawHtml` | Raw HTML (use carefully) |

## Registration

To include a plugin in the extension:

1. Add directory to `extension/apps/<id>/`
2. Add ID to `extension/apps/index.json`
3. Add static import to `extension/apps/_loaded.js`
4. Add `!extension/apps/<id>/` to `.gitignore`

## Example: CSV Analyzer

The `csv-analyzer` plugin demonstrates a pure-JS data tool:
- `CSV_LOAD_URL`: fetches CSV via `HOST_NETWORK_FETCH`, parses with inline RFC-4180 parser
- `CSV_QUERY`: filters/sorts/limits rows with simple expression syntax
- `CSV_DESCRIBE`: per-column stats (type, null count, min/max/mean)
- Dashboard: URL input, Load/Describe buttons, query form, dynamic results grid

Key pattern: the extension SW is the "network card" — fetches data via `HOST_NETWORK_FETCH`. All processing happens in JS inside the handler. No CheerpX needed.

## Testing Plugins

Plugins can be tested end-to-end using CDP (Chrome DevTools Protocol) scripts that connect to the extension browser on port 9222. This is the standard pattern — Playwright sessions cannot access `chrome-extension://` URLs because they spawn separate browsers without the extension.

### Quick Test (agent tool)

The agent's `test_plugin` tool opens a plugin in the extension browser and verifies components rendered:

```
test_plugin("csv-analyzer")
→ title: "CSV Analyzer — Agentidev", configLoaded: true, 59 components
```

### Full Test (CDP script)

For comprehensive testing (load data, click buttons, verify results), write a CDP test script:

```javascript
import { ScriptClient } from '../packages/bridge/script-client.mjs';
import http from 'http';
import WebSocket from 'ws';

const client = new ScriptClient('test-my-plugin', { totalSteps: 3 });
await client.connect();

// 1. Open plugin tab via CDP
// PUT http://localhost:9222/json/new?chrome-extension://<extId>/wrapper.html?mode=my-plugin

// 2. Find sandbox iframe target, evaluate SmartClient AutoTest API
// cdpEval(sandbox.ws, `isc.AutoTest.getObject('//Button[ID="btnLoad"]').click()`)

// 3. Verify results
// cdpEval(sandbox.ws, `isc.AutoTest.getObject('//ListGrid[ID="myGrid"]').getTotalRows()`)

client.assert(rows > 0, 'Grid has data');
await client.complete({ assertions: client.getAssertionSummary() });
```

Save to `~/.agentidev/scripts/` and run from the dashboard. See `examples/test-csv-analyzer.mjs` for a complete reference implementation (16 assertions).

## External Plugins (sibling repos)

The framework supports loading plugins from a sibling directory outside this repo. This is the model for private plugin suites (e.g. a consulting business template) that shouldn't ship in the public framework but need first-class integration.

### Three env vars

```bash
export EXTERNAL_PLUGINS_DIR=~/repos/my-suite/plugins
export EXTERNAL_SCRIPTS_DIR=~/repos/my-suite/scripts
export INSTANCE_OVERRIDES_DIR=~/repos/my-instance/overrides
```

When set, the bridge and extension look in these paths in addition to their built-in locations. Unset, everything still works the way it did before.

### External plugin layout

```
my-suite/plugins/<plugin-id>/
├── plugin.json                # SmartClient config (renderer-consumable)
└── zato/                      # Optional: if the plugin has a Zato backend
    ├── services/*.py          # Hot-deployed into Zato on setup
    ├── schema.sql             # Optional, called by an init service
    └── channels.json          # { channels: [...], datasources: {...} }
```

### What the framework does with each piece

| Piece | Mechanism |
|---|---|
| `plugin.json` | Bridge serves at `GET /external-plugins/<id>/plugin.json`. Loaded by `wrapper.html?ext=<id>` |
| Zato services | `setup-channels.mjs` copies `*.py` from external dir into Zato pickup, hot-deploys |
| `channels.json` channels | `setup-channels.mjs` registers each via `zato create-rest-channel` |
| `channels.json` datasources | Bridge merges into `DS_ENTITY_MAP` at startup; lets `/ds/<DSId>` proxy work |
| Discovery list | Bridge `GET /external-plugins` returns `[{id, name, description, source:'external'}, ...]` |

### URL mode for external plugins

External plugins open via `?ext=<plugin-id>`:

```
chrome-extension://<ext-id>/smartclient-app/wrapper.html?ext=prospect-crm
```

The host page (`bridge.js`) fetches `http://localhost:9876/external-plugins/<id>/plugin.json` and feeds the config to the sandbox iframe. Same render path as built-in plugins; just a different config source.

### Auto tab dropdown integration

The Auto tab Plugins dropdown shows external plugins under an "External" section header, sorted alphabetically. Click routes to `?ext=<id>`. Built-in plugins appear above, sorted alphabetically, opened via `?mode=<id>`. If the bridge is offline, only built-ins show.

### External scripts

`EXTERNAL_SCRIPTS_DIR` makes `.mjs` files in that directory show up in the dashboard Scripts library alongside `~/.agentidev/scripts/`. The bridge file watcher monitors both directories. On bridge startup and on each extension reconnection, existing external scripts are emitted as `BRIDGE_SCRIPT_FILE_CHANGED` so the extension's library auto-imports them.

Launch by name from the dashboard works the same way for both — `launchScriptInternal` resolves bare names against `SCRIPTS_DIR` first, then `EXTERNAL_SCRIPTS_DIR`, auto-appending `.mjs` if missing.

> **Building scrape/enrich scripts?** See the [Runtime Automation](../runtime-automation.md) doc for the conceptual framing — it explains the dev-time-resolution vs runtime-LLM split and where the `probe-selectors` utility fits as the bridge between paradigms. A QA-automation lens on why deterministic runtime is worth the engineering for repeated tasks.

### Instance overrides

`INSTANCE_OVERRIDES_DIR` is used by external scripts to read business-specific config (target verticals, geo center, branding) without baking it into the script. Convention: scripts read from `<INSTANCE_OVERRIDES_DIR>/<plugin-id>/<config>.json` when no equivalent CLI arg is provided.

### When to use the external pattern vs `extension/apps/`

| Use external | Use `extension/apps/` |
|---|---|
| Plugin shouldn't ship in the public agentidev repo | Plugin is part of the framework or a public reference implementation |
| Plugin has a Zato backend (services + schema + channels) | Plugin is pure browser-side (chrome.runtime handlers + UI) |
| Plugin is part of a "suite" you maintain elsewhere | Standalone plugin |
| Plugin needs RestDataSource over HTTP to a backend | Plugin uses message-passing to SW handlers |

A canonical worked example: `consulting-template/plugins/prospect-crm` — plugin.json + Zato services + RestDataSource grid, loaded via `?ext=prospect-crm`.

## Gotchas

- **SectionStack breaks buttons**: renderer only walks `members`, not `sections[].items[]`. Use VLayout + Labels instead.
- **DynamicForm has getSelectedRecord AND getValues**: `_payloadFrom` prefers `getValues` for forms (not grids).
- **resolveRef only works in dashboard mode**: in plugin mode use `isc.AutoTest.getObject`.
- **External plugins disappear from dropdown when bridge is down**: the discovery list is fetched live. Built-ins still show. Restart the bridge and reopen the dropdown to refresh.
- **POST and GET on the same Zato URL collide**: Zato 3.3 doesn't dispatch by HTTP method on identical paths. Use distinct paths (`/api/foo` GET, `/api/foo/add` POST) — see `restdatasource-zato` rule for the channel layout.
