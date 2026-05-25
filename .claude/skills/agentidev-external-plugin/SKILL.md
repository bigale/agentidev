---
name: agentidev-external-plugin
description: Scaffold and run an agentidev external plugin (a SmartClient app loaded from EXTERNAL_PLUGINS_DIR). Pure-browser by default, with optional Zato side-car. Use when the user wants to create a new external plugin, work on an existing one, or understand the external-plugin contract. Canonical spec at docs/external-plugin-spec.md.
user-invocable: true
disable-model-invocation: false
---

# Agentidev External Plugin

Scaffolds and supports work on **external plugins** — SmartClient apps loaded from a sibling directory pointed at by `EXTERNAL_PLUGINS_DIR`, served at runtime by the bridge's HTTP server. The canonical contract lives in [`docs/external-plugin-spec.md`](../../../docs/external-plugin-spec.md). This skill is the actionable companion.

> **Distinct from in-tree plugins** (`extension/apps/<id>/manifest.json`, loaded via `?mode=<id>`). External plugins live outside the public repo, use `plugin.json`, and load via `?ext=<id>`. Use this skill for external; use the in-tree convention directly for in-tree.

## Step 0 — Discover DDD documentation (run before anything else)

Before scaffolding, asking variant, or writing any file, **find and read** the project's domain-driven design artifacts. The skill assumes nothing about their exact locations — they may live in `docs/`, in `contexts/<name>/`, or anywhere else the user has placed them.

Run this discovery at the start of every invocation:

```bash
# Find canonical DDD files anywhere in the repo (excluding node_modules, .git, dist, build)
find . \( -type d \( -name node_modules -o -name .git -o -name dist -o -name build -o -name .next \) \) -prune -o \
       -type f \( -name CONTEXT_MAP.md \
               -o -name UBIQUITOUS_LANGUAGE.md \
               -o -name SHARED_KERNEL.md \
               -o -name CONTEXT.md \) \
       -print 2>/dev/null
```

Read every file the search returns. The expected set, in priority order:

| File | What it provides | Skill must use it for |
|---|---|---|
| `CONTEXT_MAP.md` | Bounded contexts + relationships | Identifying which contexts the plugin touches; checking for open questions related to external plugins |
| `UBIQUITOUS_LANGUAGE.md` | Canonical term definitions | Naming choices: plugin id, DataSource IDs, channel names, layout type fields |
| `SHARED_KERNEL.md` (if present) | Cross-context contracts | Validating that the plugin honors shared contracts (request/response envelopes, ID conventions, etc.) |
| `<any>/CONTEXT.md` per context | Per-context invariants, ownership, public surface | Checking that the scaffold doesn't violate per-context invariants |

If **any** of these files is missing, do not silently substitute defaults. Surface the gap:

> "I couldn't find `SHARED_KERNEL.md` — the project may not have one. Proceeding with the canonical files I did find: `CONTEXT_MAP.md`, `UBIQUITOUS_LANGUAGE.md`, and per-context CONTEXT.md files. If shared contracts exist informally, mention them and I'll honor them manually."

Also read `docs/external-plugin-spec.md` (the canonical schema for this skill's domain) if it exists.

### DDD workflow during scaffolding

When the discovery returns the expected files, use them as **constraints on every decision**:

1. **Identify touched contexts (from CONTEXT_MAP).** A pure-browser external plugin touches Apps + Automation. A Zato-backed one adds Zato Integration. State this explicitly to the user before scaffolding so they know the blast radius.

2. **Map proposed names to canonical vocabulary (from UBIQUITOUS_LANGUAGE).** Before suggesting a name for the plugin, its DataSource(s), or its channels, check whether the project already has terms for the concepts involved. Example: if the user says "I want a plugin to track captures" — the project glossary defines `Capture` as a Memory-context concept tied to vector DB pages. Calling the plugin's data `Capture` would collide with Memory's vocabulary. Surface the collision: "The project already uses `Capture` for Memory's page-capture concept. Pick a different term for this plugin's data, or confirm you want to extend the canonical term."

3. **Check invariants on the touched contexts (from per-context CONTEXT.md).** Examples for the current project:
   - Apps CONTEXT.md invariant 6: external plugins are Apps-sufficient by default — confirm the variant choice aligns.
   - Apps CONTEXT.md invariant 3: `ISC_DataBinding.js` required for forms — flag if scaffold uses forms.
   - Zato Integration CONTEXT.md invariant 6: DS IDs must not collide with built-ins (`PetDS`, `OrderDS`) — validate the user's chosen DS IDs.
   - Zato Integration CONTEXT.md invariant 7: boot/provisioner ordering — surface this in the run instructions.
   - Zato Integration CONTEXT.md invariant 8: channel paths unique across methods — validate generated `channels.json`.

4. **Check SHARED_KERNEL contracts (if file exists).** Any cross-context envelope (e.g., DS response `{status, data}`) or ID convention should be respected by the scaffold. If `SHARED_KERNEL.md` isn't present, note it and continue.

5. **Check open questions in CONTEXT_MAP.** Open questions sometimes reveal in-flight decisions that affect the plugin. If CONTEXT_MAP.md has an open question touching external plugins, surface it before scaffolding.

After the file is scaffolded, **announce which contexts you wrote into** and which canonical terms / invariants you respected. This makes the DDD work visible to the user and to future readers.

## Decision the skill makes first

External plugins come in two variants. **Pure-browser is the default.** Zato Integration is only involved if the user explicitly wants a Zato-backed plugin.

| Variant | When to use | Files | Zato? |
|---|---|---|---|
| **Pure-browser** (default) | Data is local (IndexedDB), fetched from an existing HTTP API the iframe can call directly, or static | `plugin.json` only | No |
| **Zato-backed** | The plugin needs server-side CRUD against a SQL DB, hot-deployable Python services, or wraps an existing Zato-fronted API | `plugin.json` + `zato/{services,channels.json[,schema.sql]}` | Yes |

**Always ask the user which variant they want before scaffolding** — do not assume Zato. Use `AskUserQuestion`:

> Variant for the new external plugin? **Pure-browser** uses local IndexedDB or direct `fetch` from the sandbox iframe — no Docker, no provisioning, faster iteration. **Zato-backed** adds a `zato/` side-car with Python services, channel provisioning, and SQL. Pick Zato only if you need server-side persistence or are wrapping an existing Zato API.

Options:
- Pure-browser (recommended default)
- Zato-backed

If the user is working on an **existing** plugin, skip the question — read `plugin.json` and check if a `zato/` sibling exists to determine the variant.

## When invoked

1. **Check prerequisites**:
   - `EXTERNAL_PLUGINS_DIR` env var set? If not, ask the user for a path (suggest `~/repos/<their>-plugins`) and remind them to `export EXTERNAL_PLUGINS_DIR=<path>` before running the bridge.
   - Bridge running? `curl -s localhost:9876/status` or `bcli status`. If down, tell the user but don't auto-start — they may want a clean slate.

2. **Determine intent**:
   - Create new plugin → ask variant (see above), ask `id` (kebab-case, used as directory name and `id` field), ask `name` (display).
   - Iterate on existing plugin → identify it from `$EXTERNAL_PLUGINS_DIR/<id>/` and proceed without scaffolding.

3. **Scaffold accordingly** (see templates below).

4. **Tell the user how to run it** — emit the exact run sequence for the chosen variant.

## Pure-browser variant scaffold

Directory:
```
$EXTERNAL_PLUGINS_DIR/<plugin-id>/
└── plugin.json
```

**Critical: pick the DataSource backing first.** The renderer treats three values of `_type` differently. Picking the wrong one results in silent failures (clicks fire but no data, no visible error). Choose based on where the plugin's data actually lives:

| Backing | `_type` | Where data lives | Notes |
|---|---|---|---|
| **External HTTP** | `RestDataSource` + `dataURL: "https://..."` | A remote HTTP server (CF Worker, REST API, etc.) | Renderer does `fetch()` with SmartClient wire-protocol. **The server must return `{response: {status: 0, data: [...]}}`** — plain arrays will silently fail to render. |
| **Bridge → Zato** | `RestDataSource` + `dataURL: "http://localhost:9876/ds/<EntityDS>"` | Zato service via the bridge `/ds/` endpoint | The bridge handles wire-format translation; the Zato service can return plain JSON. Use this for the Zato-backed variant. |
| **Local IndexedDB** | `clientCustom` (no `dataURL`) | Browser IndexedDB (`smartclient-data` DB, auto-created object store per DS ID) | Falls through `BRIDGE_BACKENDS`. Persistent on-device. Use when the plugin has no server. Hardcoded built-ins (`PetDS`, `OrderDS`) win at boot — pick a unique DS ID. |

**Common mistake:** using `_type: "clientCustom"` together with `dataURL: "https://..."` thinking the renderer will fetch the URL. **It will not.** `clientCustom` routes through `postMessage → SW → BRIDGE_BACKENDS → IndexedDB fallback`. The `dataURL` field is silently ignored. The button will fire, the fetch will appear to complete, the grid will stay empty.

Template `plugin.json` (External HTTP case — replace placeholders, then drop into the directory):

```json
{
  "id": "<plugin-id>",
  "name": "<Display Name>",
  "description": "<one-line description>",
  "version": "0.1.0",
  "dataSources": [
    {
      "ID": "<EntityDS>",
      "_type": "RestDataSource",
      "dataURL": "https://<your-server>/<endpoint>",
      "fields": [
        { "name": "id", "type": "integer", "primaryKey": true, "hidden": true },
        { "name": "title", "type": "text", "required": true }
      ]
    }
  ],
  "layout": {
    "_type": "VLayout",
    "width": "100%",
    "members": [
      {
        "_type": "DynamicForm",
        "ID": "filterForm",
        "fields": [
          { "name": "query", "title": "Query", "type": "text" }
        ]
      },
      {
        "_type": "HLayout",
        "height": 40,
        "members": [
          {
            "_type": "Button",
            "title": "Run",
            "_action": "dsFetch",
            "_targetGrid": "grid1",
            "_payloadFrom": "filterForm",
            "_statusTarget": "statusLabel"
          },
          {
            "_type": "Label",
            "ID": "statusLabel",
            "contents": "Ready.",
            "wrap": false
          }
        ]
      },
      {
        "_type": "ListGrid",
        "ID": "grid1",
        "dataSource": "<EntityDS>",
        "autoFetchData": false
      }
    ]
  }
}
```

**Defaults the scaffold picks:**
- `_type: "RestDataSource"` with `dataURL` — the renderer does HTTP fetch. **The server MUST return SmartClient wire format `{response: {status: 0, startRow, endRow, totalRows, data: [...]}}`** or the grid stays empty. If the plugin targets a server you don't control and that server returns plain JSON, the plugin needs an intermediate layer (a CF Worker that re-shapes the response, or the Zato-backed variant via the bridge).
- `_statusTarget: "statusLabel"` on the Button — wires fetch success/error feedback into the Label. Without this, fetch failures only surface in DevTools console. See [agentidev/docs/external-plugin-spec.md](../../../docs/external-plugin-spec.md) for the field.
- For an IndexedDB-only plugin (no HTTP), swap `_type` to `"clientCustom"` and drop `dataURL`. The DS will read/write the browser's local store; `autoFetchData: true` works out of the box.

Run sequence:

```bash
export EXTERNAL_PLUGINS_DIR=<path>
npm run bridge &
npm run browser
# open chrome-extension://<extId>/smartclient-app/wrapper.html?ext=<plugin-id>
```

Iteration: edit `plugin.json` → reload the iframe. **No bridge restart needed** (bridge serves the file fresh each request). Confirm by visiting `http://localhost:9876/external-plugins` to see the plugin in the list.

## Zato-backed variant scaffold

Directory:
```
$EXTERNAL_PLUGINS_DIR/<plugin-id>/
├── plugin.json
└── zato/
    ├── services/<plugin-id>.py
    ├── schema.sql              # optional
    └── channels.json
```

Template `plugin.json` (note `RestDataSource` instead of `clientCustom`):

```json
{
  "id": "<plugin-id>",
  "name": "<Display Name>",
  "description": "<one-line description>",
  "version": "0.1.0",
  "dataSources": [
    {
      "ID": "<EntityDS>",
      "_type": "RestDataSource",
      "dataURL": "http://localhost:9876/ds/<EntityDS>",
      "fields": [
        { "name": "id", "type": "integer", "primaryKey": true },
        { "name": "name", "type": "text", "required": true },
        { "name": "status", "type": "text", "valueMap": { "active": "Active", "archived": "Archived" } }
      ]
    }
  ],
  "layout": {
    "_type": "VLayout",
    "members": [
      { "_type": "ListGrid", "ID": "grid1", "dataSource": "<EntityDS>", "autoFetchData": true, "canEdit": true, "canRemoveRecords": true },
      { "_type": "HLayout", "members": [
        { "_type": "Button", "_action": "dsAdd",  "_targetGrid": "grid1", "title": "New" },
        { "_type": "Button", "_action": "dsSave", "_targetGrid": "grid1", "title": "Save" }
      ]}
    ]
  }
}
```

Template `zato/channels.json`:

```json
{
  "channels": [
    { "name": "<plugin-id>-find", "method": "GET",    "path": "/api/<plugin-id>/find",            "service": "<plugin-id>.entity.find" },
    { "name": "<plugin-id>-get",  "method": "GET",    "path": "/api/<plugin-id>/id/{id}",         "service": "<plugin-id>.entity.get" },
    { "name": "<plugin-id>-add",  "method": "POST",   "path": "/api/<plugin-id>",                 "service": "<plugin-id>.entity.add" },
    { "name": "<plugin-id>-upd",  "method": "PUT",    "path": "/api/<plugin-id>/update",          "service": "<plugin-id>.entity.update" },
    { "name": "<plugin-id>-del",  "method": "DELETE", "path": "/api/<plugin-id>/delete/{id}",     "service": "<plugin-id>.entity.delete" }
  ],
  "datasources": {
    "<EntityDS>": {
      "fetch":     { "method": "GET",    "path": "/api/<plugin-id>/find",        "queryParam": "status" },
      "fetchById": { "method": "GET",    "path": "/api/<plugin-id>/id/" },
      "add":       { "method": "POST",   "path": "/api/<plugin-id>" },
      "update":    { "method": "PUT",    "path": "/api/<plugin-id>/update" },
      "remove":    { "method": "DELETE", "path": "/api/<plugin-id>/delete/" }
    }
  }
}
```

Template `zato/services/<plugin-id>.py` (skeleton — mirror `docker/zato/services/petstore/pet.py` for a working reference):

```python
from zato.server.service import Service
import sqlite3, json

DB_PATH = '/opt/zato/<plugin-id>.db'

def _conn():
    c = sqlite3.connect(DB_PATH, timeout=5)
    c.execute('PRAGMA journal_mode=WAL')
    c.execute('PRAGMA busy_timeout=5000')
    c.row_factory = sqlite3.Row
    return c

class EntityFind(Service):
    name = '<plugin-id>.entity.find'
    def handle(self):
        # Use wsgi_environ for query params — self.request.http.GET is unreliable in Zato 3.3
        qs = self.wsgi_environ.get('QUERY_STRING', '')
        # parse qs, build SQL, return rows as list of dicts
        with _conn() as c:
            rows = [dict(r) for r in c.execute('SELECT * FROM entity').fetchall()]
        self.response.payload = rows

# Add EntityGet, EntityAdd, EntityUpdate, EntityDelete classes here.
# See docker/zato/services/petstore/pet.py for the full pattern.
```

Template `zato/schema.sql` (optional, called by an init service the plugin author writes):

```sql
CREATE TABLE IF NOT EXISTS entity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Run sequence:

```bash
export EXTERNAL_PLUGINS_DIR=<path>
npm run zato:up        # starts Zato Docker
npm run zato:setup     # provisions channels + hot-deploys services
npm run bridge &       # reads channels.json at boot, merges into DS_ENTITY_MAP
npm run browser
# open chrome-extension://<extId>/smartclient-app/wrapper.html?ext=<plugin-id>
```

Iteration: see [external-plugin-spec.md § Iteration](../../../docs/external-plugin-spec.md#iteration). Editing `channels.json` requires `npm run bridge:restart` (and `npm run zato:setup` if channels were added).

## Critical invariants the scaffold must respect

These are the things that break silently if violated. Surface them to the user when scaffolding.

1. **`<plugin-id>` matches directory name.** The bridge's gallery uses the directory name when `cfg.id` is absent, but mismatches cause path-routing surprises.
2. **DS IDs must not collide with built-ins** — today `PetDS`, `OrderDS` are reserved. The bridge overrides built-ins with externals at boot (current ordering), but this is not a guarantee — pick a unique ID.
3. **Channel paths must be unique across all methods.** The provisioner does not pass `--method` to Zato. Use distinct paths like `/api/<plugin-id>/update` for PUT and `/api/<plugin-id>/delete/{id}` for DELETE.
4. **Boot/provisioner ordering (Zato variant only):** run `zato:setup` BEFORE starting the bridge, or restart the bridge after `zato:setup`. Otherwise `DS_ENTITY_MAP` points at channels that don't exist yet.
5. **`ISC_DataBinding.js` is required even without a DataSource.** Forms silently break otherwise (see `docs/contexts/apps/CONTEXT.md` invariant 3). The extension's bundled SmartClient already includes it; this matters only if the user customizes the SmartClient bundle.

## How to verify the scaffold works

After scaffolding, verify in this order — short-circuit at the first failure:

1. **Plugin appears in the gallery list:**
   ```bash
   curl -s http://localhost:9876/external-plugins | jq
   ```
   Expect: an object whose `plugins` array contains `{id: "<plugin-id>", name: "<Display Name>", source: "external"}`.

2. **Plugin config serves:**
   ```bash
   curl -s http://localhost:9876/external-plugins/<plugin-id>/plugin.json | jq '.id, .name'
   ```
   Expect: `"<plugin-id>"` and `"<Display Name>"`.

3. **(Zato variant only) DataSource merged into `DS_ENTITY_MAP`:**
   - Check bridge stdout for `[Bridge] Loaded external DataSource: <EntityDS>` at startup.
   - Hit a channel directly: `curl -s "http://localhost:11223/api/<plugin-id>/find" | jq`.

4. **Plugin renders:**
   - Open `chrome-extension://<extId>/smartclient-app/wrapper.html?ext=<plugin-id>`.
   - Open DevTools console — no SmartClient errors, no `[Bridge]` errors.
   - Grid renders + shows at least an empty state.

5. **(Zato variant) End-to-end CRUD:**
   - Click "New" → fill form → save. Expect a row to appear in the grid.
   - Refresh the iframe. Expect the row to persist.

If any step fails, the user can investigate using the failure-modes table in `docs/external-plugin-spec.md`.

## Common gotchas to flag pre-emptively

- **CORS:** the bridge's `/external-plugins/*` endpoints serve with `Access-Control-Allow-Origin: *`. Don't put secrets in `plugin.json`.
- **DataSource backing selection (most common mistake):** see the table at the top of this section. `clientCustom + dataURL` does **not** fetch the URL — it routes to IndexedDB and the dataURL is ignored. Use `RestDataSource + dataURL` for any HTTP target. Surface this explicitly when scaffolding.
- **SmartClient wire-format requirement on RestDataSource:** the renderer's RestDataSource transformRequest expects `{response: {status, data, totalRows, ...}}`. Servers that return plain arrays (or plain JSON) will fail silently. Test this constraint before assuming the server endpoint will Just Work.
- **External plugins do NOT use `handlers.js`** — that file is the in-tree convention. External plugins put everything in `plugin.json` (or in `services/*.py` for the Zato variant).
- **`?mode=` vs `?ext=` mixup:** the user may try `?mode=<plugin-id>` and get a 404 from the in-tree gallery. External plugins must use `?ext=`.
- **Bridge restart vs iframe reload:**
  - Pure-browser: iframe reload only.
  - Zato variant: iframe reload after `plugin.json` edit; bridge restart after `channels.json` edit; `zato:setup` after `services/*.py` edit.

## Skill behavior summary

When invoked, in this order — **do not skip steps 0 or 1**:

0. **Discover DDD docs** (Step 0 above). Run the `find` command. Read every CONTEXT_MAP.md / UBIQUITOUS_LANGUAGE.md / SHARED_KERNEL.md / CONTEXT.md the search returns. State which contexts and invariants will constrain the scaffold.
1. Read `docs/external-plugin-spec.md` for the current canonical schema.
2. Determine prerequisites (`EXTERNAL_PLUGINS_DIR` set? bridge running?).
3. Determine intent (new vs existing).
4. **If new:** ask variant (pure-browser default, Zato opt-in), then `id` (validated against ubiquitous-language collisions), then `name`. Scaffold using canonical terms.
5. **If existing:** read `plugin.json`, detect variant by presence of `zato/`, then help with whatever the user actually wants done — still constrained by the DDD invariants discovered in Step 0.
6. Emit the run sequence for the chosen variant.
7. Offer to verify (steps 1-4 in the verification list — step 5 is interactive).
8. **Announce which contexts were written to** and which canonical terms / invariants were respected. Example:
   > "Scaffolded pure-browser variant in Apps + Automation contexts. Plugin id `<id>` does not collide with UBIQUITOUS_LANGUAGE entries. DS ID `<EntityDS>` does not collide with built-ins (PetDS, OrderDS). No SHARED_KERNEL.md found — no shared-kernel contracts checked."

Default to pure-browser. Only scaffold Zato when the user explicitly asks for it.

## Related skills

- `/agentiface` — SmartClient renderer + Forge toolkit reference. Useful when the plugin needs `ForgeListGrid` / `ForgeWizard` / `ForgeFilterBar` or other advanced components.
- `/ui-testing` — for writing CDP-based tests of the new plugin (the `examples/test-csv-analyzer.mjs` pattern works for external plugins too — substitute `?mode=<id>` for `?ext=<id>`).
- `/domain` — for resolving cross-context terminology questions that surface during plugin work.

## Canonical references

- [`docs/external-plugin-spec.md`](../../../docs/external-plugin-spec.md) — schema, lifecycle, failure modes
- [`docs/contexts/apps/CONTEXT.md`](../../../docs/contexts/apps/CONTEXT.md) — renderer whitelist, invariants
- [`docs/contexts/zato-integration/CONTEXT.md`](../../../docs/contexts/zato-integration/CONTEXT.md) — DS_ENTITY_MAP, provisioning, Zato gotchas
- [`docs/contexts/automation/CONTEXT.md`](../../../docs/contexts/automation/CONTEXT.md) — bridge HTTP server hosting `/external-plugins/*`
- `.claude/rules/restdatasource-zato.md` — older documented contract (superseded by external-plugin-spec.md for schema, still useful for Zato gotchas)
- `docker/zato/services/petstore/pet.py` — working reference for a Zato service implementation
- `extension/apps/csv-analyzer/manifest.json` + `handlers.js` — in-tree plugin reference (NOT the external shape, but useful for SmartClient config patterns)
