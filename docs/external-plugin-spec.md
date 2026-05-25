# External Plugin Specification

The canonical contract for plugins loaded via the `EXTERNAL_PLUGINS_DIR` mechanism. An external plugin is a **cross-context bundle** spanning [Apps](contexts/apps/CONTEXT.md) + [Automation](contexts/automation/CONTEXT.md). [Zato Integration](contexts/zato-integration/CONTEXT.md) is **only involved if** the plugin ships a `zato/` side-car.

External plugins come in two variants — pick the one that fits your data needs:

| Variant | Files required | DataSource backings | Bridge restart on edit? | Zato required? |
|---|---|---|---|---|
| **Pure-browser** | `plugin.json` only | `clientCustom` (in-iframe `fetch`), IndexedDB-backed (`BRIDGE_BACKENDS` fallback to `smartclient-data` DB), or static data inline | No — bridge serves `plugin.json` fresh each request | **No** |
| **Zato-backed** | `plugin.json` + `zato/{services,channels.json[,schema.sql]}` | `RestDataSource` pointing at the bridge's `/ds/<EntityDS>` endpoint, which routes to Zato | Yes — on `channels.json` changes (so `DS_ENTITY_MAP` re-merges at boot) | Yes |

The two variants share the same `plugin.json` shape and the same `?ext=<id>` URL — the only difference is whether `zato/` is present. The Zato code paths in the bridge (`loadExternalDataSources()`) and provisioner (`setup-channels.mjs`) silently skip plugins without a `zato/` directory, so pure-browser plugins coexist with Zato-backed ones in the same `EXTERNAL_PLUGINS_DIR`.

> Distinct from **in-tree plugins** at `extension/apps/<id>/`. In-tree plugins use `manifest.json`, ship with the repo, and load via `?mode=<id>`. External plugins use `plugin.json`, live in a sibling repo, and load via `?ext=<id>` through the bridge's HTTP server.

## Directory layout

```
<EXTERNAL_PLUGINS_DIR>/
└── <plugin-id>/
    ├── plugin.json                 # REQUIRED — SmartClient config + descriptor
    └── zato/                       # OPTIONAL — only if plugin uses Zato services
        ├── services/*.py           # Hot-deployed into Zato's pickup directory
        ├── schema.sql              # OPTIONAL — called by an init service
        └── channels.json           # REQUIRED if services/ present — channel + datasource bindings
```

`<plugin-id>` is the directory name and must match the `id` field in `plugin.json`. Used in:
- `wrapper.html?ext=<plugin-id>` URL
- Bridge HTTP path `/external-plugins/<plugin-id>/...`
- Container path `/opt/zato/external-plugins/<plugin-id>/zato/...` (for schema files referenced by init services)

## `plugin.json` — SmartClient descriptor

Served by the bridge at `/external-plugins/<plugin-id>/plugin.json`. Consumed by the renderer at runtime.

```json
{
  "id": "string",                   // REQUIRED — must match directory name
  "name": "string",                 // REQUIRED — display name in gallery
  "description": "string",          // OPTIONAL — shown in gallery card
  "version": "string",              // OPTIONAL — semver, conventional but not enforced
  "dataSources": [                  // REQUIRED — SmartClient DataSource declarations
    {
      "ID": "EntityDS",
      "_type": "RestDataSource",
      "dataURL": "http://localhost:9876/ds/EntityDS",
      "fields": [
        { "name": "id", "type": "integer", "primaryKey": true },
        { "name": "name", "type": "text", "required": true }
      ]
    }
  ],
  "layout": {                       // REQUIRED — SmartClient component tree
    "_type": "VLayout",
    "members": [
      { "_type": "ListGrid", "ID": "grid1", "dataSource": "EntityDS", "autoFetchData": true }
    ]
  }
}
```

**Validation rules** (enforced post-load in the renderer):

- `dataSources` must be an array. Each entry must have `ID` and either `_type` (typed DS) or a backing in the `BRIDGE_BACKENDS` registry / IndexedDB fallback.
- `layout._type` must appear in the renderer's `ALLOWED_TYPES` whitelist. See [Apps CONTEXT.md](contexts/apps/CONTEXT.md) for the full list.
- Cross-references (`dataSource: "EntityDS"` in a Component) must resolve to a declared DataSource ID.

### Three DataSource backings (pick correctly)

The renderer branches on `_type` to decide how to fetch data. Picking the wrong backing produces silent failures (click fires, fetch appears to complete, grid stays empty, no popup). The rule:

| Backing | `_type` value | `dataURL` honored? | Mechanism | When to use |
|---|---|---|---|---|
| External HTTP | `"RestDataSource"` | **Yes** — renderer does `fetch(dataURL + '?_operationType=...')` | The server response **must** match SmartClient wire format: `{response: {status: 0, startRow, endRow, totalRows, data: [...]}}` | Pure-browser plugin calling an external HTTP server you control |
| Bridge / Zato | `"RestDataSource"` + `dataURL: "http://localhost:9876/ds/<EntityDS>"` | Yes | Bridge `/ds/` endpoint speaks SmartClient wire format natively, translates to Zato REST channel calls | Zato-backed variant |
| Local IndexedDB | `"clientCustom"` (no `dataURL`) | **No** — `dataURL` is silently ignored if present | `postMessage → SW → BRIDGE_BACKENDS → IndexedDB fallback`. Auto-creates an object store named after the DS ID in the `smartclient-data` database | Plugin with no server; persistent on-device store |

**Common foot-gun:** `"_type": "clientCustom", "dataURL": "https://..."` looks like it should fetch the URL. It does not. The renderer's `clientCustom` branch ignores `dataURL` and routes through SW message-passing. Use `RestDataSource` for any HTTP target.

The wire-format constraint on `RestDataSource` is enforced in `extension/smartclient-app/renderer.js:836-890`. If the external server cannot return SmartClient wire format directly, options are:

1. Put a thin response-shape adapter in front of the server (a CF Worker that wraps the upstream response in `{response: {status, data}}`).
2. Use the Zato-backed variant — the bridge does the translation for you.
3. Bypass DataSources entirely and use a Button with `_action: "dispatchAndDisplay"` to call a custom handler that renders HTML directly (loses grid behavior).

## `channels.json` — Zato channel + DataSource bindings

Read at **bridge boot** (`server.mjs::loadExternalDataSources`) and at **provisioning time** (`docker/zato/setup-channels.mjs`). Both consumers must agree on the schema — there is no shared parser.

```json
{
  "channels": [
    {
      "name": "string",            // REQUIRED — unique channel name across all plugins
      "method": "GET|POST|PUT|DELETE",  // NOTE: documentary only; provisioner does NOT pass this
      "path": "/api/...",          // REQUIRED — URL path; may contain {placeholders}
      "service": "namespace.service-name"  // REQUIRED — Zato service ID (matches a class in services/*.py)
    }
  ],
  "datasources": {
    "EntityDS": {                  // KEY: SmartClient DataSource ID (must not collide with built-ins)
      "fetch":     { "method": "GET",    "path": "/api/entity/find",        "queryParam": "status" },
      "fetchById": { "method": "GET",    "path": "/api/entity/id/" },
      "add":       { "method": "POST",   "path": "/api/entity" },
      "update":    { "method": "PUT",    "path": "/api/entity/update" },
      "remove":    { "method": "DELETE", "path": "/api/entity/delete/" }
    }
  }
}
```

**Validation rules** (currently convention, not enforced):

- `channels[].name` must be unique across all external plugins (Zato rejects duplicates).
- `channels[].path` must be **unique across all methods** — the provisioner does not pass `--method`, so Zato routes purely by URL path. Convention: `/api/<entity>/update` for PUT, `/api/<entity>/delete/{id}` for DELETE.
- `channels[].service` must match a service class registered by `services/*.py` (e.g., `petstore.pet.find-by-status`).
- `datasources` keys (DS IDs) **must not collide with built-in DS_ENTITY_MAP entries** — today: `PetDS`, `OrderDS`. Collisions silently override at boot; this is the documented behavior, but new built-ins added later would clobber externals.
- `datasources[<id>]` operations (`fetch`, `add`, etc.) must reference channel paths that exist in `channels[]` (or in Zato already from a prior provisioning).

## `services/*.py` — Zato services

Standard Zato 3.3 service classes. Hot-deployed via the pickup mechanism. See `.claude/rules/restdatasource-zato.md` for gotchas (use `self.wsgi_environ['QUERY_STRING']` instead of `self.request.http.GET`; configure SQLite with `journal_mode=WAL`).

Inside the container, the plugin's source files appear at `/opt/zato/external-plugins/<plugin-id>/zato/`. Init services that reference `schema.sql` should use that absolute container path.

## `schema.sql` — Optional DB init

Standard SQL. Called by an init service the plugin author writes (typically `<namespace>.init`, returned as a separate channel). Use the absolute container path `/opt/zato/external-plugins/<plugin-id>/zato/schema.sql` when reading from a service.

## Lifecycle

### Install — pure-browser variant (no Zato)

```bash
export EXTERNAL_PLUGINS_DIR=~/repos/<your-plugin-repo>/plugins
npm run bridge &         # start bridge — serves /external-plugins/* over HTTP
npm run browser          # launch Chromium with extension
# open chrome-extension://<extId>/smartclient-app/wrapper.html?ext=<plugin-id>
```

No Docker, no Zato, no `zato:setup`. The bridge HTTP server picks up `plugin.json` fresh on every request, so iframe reload is enough after edits.

### Install — Zato-backed variant

```bash
export EXTERNAL_PLUGINS_DIR=~/repos/<your-plugin-repo>/plugins
npm run zato:up          # start Zato Docker
npm run zato:setup       # provision channels, hot-deploy services
npm run bridge &         # start bridge — reads EXTERNAL_PLUGINS_DIR + merges channels.json
npm run browser          # launch Chromium with extension
# open chrome-extension://<extId>/smartclient-app/wrapper.html?ext=<plugin-id>
```

### Boot/provisioner ordering invariant (Zato variant only)

For Zato-backed plugins, provisioning **must** happen before (or be followed by a bridge restart) for the merged `DS_ENTITY_MAP` to point at channels that actually exist in Zato. Otherwise DS calls 404 silently. Pure-browser plugins are unaffected by ordering — they have no `DS_ENTITY_MAP` entries to populate.

### Iteration

Pure-browser variant:
- Editing `plugin.json` → reload the wrapper iframe (bridge serves the file fresh each request). No bridge restart needed.

Zato-backed variant (in addition to the above):
- Editing `services/*.py` → re-run `npm run zato:setup` to redeploy + Zato hot-reloads.
- Editing `channels.json` (channel additions) → re-run `npm run zato:setup` then restart the bridge.
- Editing `channels.json` (DataSource bindings only, no new channels) → restart the bridge alone.

### Uninstall

Today there is no clean uninstall. To remove a plugin:

1. Delete the plugin directory under `EXTERNAL_PLUGINS_DIR`.
2. Manually delete channels in Zato (no automated removal).
3. Restart the bridge to remove the stale `DS_ENTITY_MAP` entries.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Plugin missing from gallery | `plugin.json` malformed or absent | Check bridge stdout for `[Bridge] Skipping ...` |
| Plugin renders but DS calls return 404 | Channels not provisioned, or bridge booted before provisioning | Run `npm run zato:setup` then `npm run bridge:restart` |
| DS calls hit wrong service | DS ID collision with built-in (`PetDS`, `OrderDS`) | Rename the external DS ID |
| Channel creation fails | Duplicate `name` or `path` across plugins | Pick unique names; check paths across all installed plugins |
| Service deployment skipped | `services/` directory missing or empty | Check `<plugin-dir>/zato/services/*.py` exists |
| 403 on plugin config fetch | Path traversal guard hit | Plugin ID or filename contains `..` — invalid |
| 500 on plugin config fetch | I/O error reading `plugin.json` | Check file permissions, valid JSON |

## Cross-context contracts at risk

Editing the schema in `plugin.json` or `channels.json` touches multiple code paths that must stay in sync:

| Schema element | Read by | If changed without updating reader |
|---|---|---|
| `plugin.json.id`, `.name`, `.description` | `server.mjs::/external-plugins` (list endpoint) | Plugin missing from gallery list |
| `plugin.json.dataSources`, `.layout` | `renderer.js` in sandbox iframe | Plugin fails to render |
| `channels.json.channels` | `setup-channels.mjs` (provisioner) | Channels not created in Zato |
| `channels.json.datasources` | `server.mjs::loadExternalDataSources` (bridge boot) | DS calls 404 |

The `datasources` block has **two readers** — the bridge (at boot, into `DS_ENTITY_MAP`) and nothing else. The `channels` block has **one reader** — the provisioner. They share a file but not a parser.

## Suggested future improvements

These are deliberately not committed work — surfaced here so the next person to touch this feature sees them.

- **JSON Schema files for `plugin.json` and `channels.json`** — validated by bridge boot and by `setup-channels.mjs`. Eliminates silent-skip-on-typo failures.
- **`npm run plugin:validate <path>`** — dry-run validator that checks both schemas + plugin-vs-builtin DS ID collisions + channel path collisions without requiring Zato to be up.
- **Unified descriptor filename** — pick one of `manifest.json` or `plugin.json` for both in-tree and external. The current split is convention-only and creates a search/lookup footgun.
- **Uninstall command** — `npm run plugin:uninstall <id>` that removes channels in Zato + clears the directory + restarts the bridge.

## Related docs

- [contexts/apps/CONTEXT.md](contexts/apps/CONTEXT.md) — Apps invariants, renderer whitelist
- [contexts/zato-integration/CONTEXT.md](contexts/zato-integration/CONTEXT.md) — DS_ENTITY_MAP, /ds/ endpoint, provisioning details
- [contexts/automation/CONTEXT.md](contexts/automation/CONTEXT.md) — bridge HTTP server hosting external-plugin endpoints
- [CONTEXT_MAP.md](CONTEXT_MAP.md) — cross-context ownership picture
- [UBIQUITOUS_LANGUAGE.md](UBIQUITOUS_LANGUAGE.md) — Plugin, Plugin Manifest, EXTERNAL_PLUGINS_DIR entries
- `.claude/rules/restdatasource-zato.md` — original documented contract (this doc supersedes its schema sections)
