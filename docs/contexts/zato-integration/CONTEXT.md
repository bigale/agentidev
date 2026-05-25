# Zato Integration

The glue layer that lets agentidev talk to Zato REST channels. **The glue is ours; the Zato framework is external.**

## Ownership

- `DS_ENTITY_MAP` — the routing table in `packages/bridge/server.mjs` that maps SmartClient DataSource IDs to Zato URLs and HTTP methods.
- The bridge `/ds/<EntityDS>` endpoint — translates SmartClient's RestDataSource wire-protocol requests to Zato calls. Handles update-merge (partial-field PUTs become full-record PUTs) and response flattening (`category: {id, name}` → `category: "Dogs"`).
- `docker/zato/services/` — project-authored Python services (e.g., `petstore/pet.py`). Hot-deployed to Zato via its pickup directory.
- `docker/zato/setup-channels.sh` + `docker-compose.yml` — provisioning + container orchestration.
- The **Zato side-car portion** of the `EXTERNAL_PLUGINS_DIR` mechanism: when a plugin ships a `zato/` directory (`services/`, optional `schema.sql`, `channels.json`), Zato Integration owns the loader (`loadExternalDataSources()` in `server.mjs`) that merges its `datasources` block into `DS_ENTITY_MAP`, and the provisioner (`setup-channels.mjs`) that deploys services + creates channels. **The external-plugin mechanism itself is not owned here** — it works for pure-browser plugins too (with no `zato/` directory), in which case Zato Integration is uninvolved. See [external-plugin-spec.md](../../external-plugin-spec.md) for the full picture.
- `packages/bridge/api-to-app/specs/petstore-zato.json` — Zato-specific OpenAPI spec used by the test pipeline (also lives in Testing's open question).

## External dependencies (not owned)

- **Zato framework 3.3** — Python ESB running in a Docker container. Third-party. We use it via:
  - REST channels (created via `zato create-rest-channel`)
  - SQLite as the persistence backing (with `journal_mode=WAL`, `busy_timeout=5000`)
  - Hot-deploy via pickup directory

## Invariants

1. SmartClient sends partial fields on UPDATE; the bridge fetches the current record from Zato, merges the changes, then PUTs the full record back. Zato services do not handle partial updates themselves.
2. URL paths must be **unique per channel** — Zato 3.3 doesn't do method-based routing on the same path. Convention: `/api/<entity>/update` for PUT, `/api/<entity>/delete/{id}` for DELETE.
3. `self.request.http.GET` is unreliable for reading query params in Zato services. Use `self.wsgi_environ['QUERY_STRING']` instead.
4. Nested objects in Zato responses are flattened to strings before being returned to SmartClient for grid display.
5. The bridge `/ds/` endpoint and the bridge WebSocket share **one HTTP port (9876)** — the same Node process serves both.
6. **External plugin DataSource IDs must not collide with built-in `DS_ENTITY_MAP` entries** (today: `PetDS`, `OrderDS`). Collisions silently override at boot because `loadExternalDataSources()` runs after the const initialization. This ordering is the documented behavior. Runtime mutations to `DS_ENTITY_MAP` (post-boot adds or removes) are forbidden because they would break the precedence invariant.
7. **Boot/provisioner ordering:** external `channels.json` must be **provisioned in Zato** (via `npm run zato:setup`) before the bridge boots, OR the bridge must be restarted after provisioning. Boot reads `channels.json` and merges into `DS_ENTITY_MAP`; if the channels don't exist in Zato yet, DS calls 404 silently until restart.
8. The provisioner does **not** pass `--method` to `zato create-rest-channel` — channels are identified by `--url-path` alone. URL paths must therefore be **unique across all methods**. Convention: `/api/<entity>/update` for PUT, `/api/<entity>/delete/{id}` for DELETE.

## Public surface

- `GET /ds/<EntityDS>?_operationType=fetch&<filters>&_startRow=N&_endRow=M` — SmartClient fetch.
- `POST /ds/<EntityDS>` with body `{_operationType: add|update|remove, ...fields}` — SmartClient write ops.
- All responses: `{ response: { status: 0|−1, startRow, endRow, totalRows, data: [...] } }`.
- External plugin layout under `EXTERNAL_PLUGINS_DIR`:

```
<plugin-id>/
├── plugin.json              # SmartClient plugin config (Apps concern)
└── zato/
    ├── services/*.py        # Zato services, hot-deployed
    ├── schema.sql           # Optional, called by an init service
    └── channels.json        # { channels: [...], datasources: {...} }
```

## Cross-context dependencies

- **Apps** ↔ Zato Integration: SmartClient RestDataSources point at the bridge's `/ds/` endpoint. The plugin.json side of external plugins is an Apps concern; the zato/ side is a Zato Integration concern. The external-plugin manifest schema is **jointly owned** — see CONTEXT_MAP open questions.
- **Automation** ↔ Zato Integration: both run inside `packages/bridge/server.mjs` (one Node process) but they're separable concerns. Automation does not need Zato to function; Zato Integration could in principle run in a separate process.
- **Testing** ↔ Zato Integration: the api-to-app pipeline (currently under Testing) targets Zato heavily — 239/289 Petstore-Zato tests pass via PICT-generated cases.

## Failure modes

- Zato container down → DataSource fetches return errors via the bridge `/ds/` endpoint; grids show empty + error.
- SQLite concurrency under rapid writes (no WAL or no busy_timeout) → silent corruption. The PICT pipeline exposed this and the fix is `PRAGMA journal_mode=WAL` + `busy_timeout=5000`.
- Channel creation collision → Zato refuses; setup script logs the conflict.
- External plugin path missing or malformed → bridge skips that plugin, logs `[Bridge] Loaded external DataSource: ...` only for successful ones.
