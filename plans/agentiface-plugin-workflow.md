# Plan: Agentiface → Plugin Unified Workflow

## The vision

A complete loop: **create → refine → publish → use → modify → republish**.

Today we have the pieces but not the loop. The screenshot shows the
mortgage calculator running as a published plugin (`?mode=proj_...`)
with the Agentiface sidebar open, Inspector bar visible, and the
project loaded in the sidebar's AF tab. The pieces exist:

- **Agentiface playground** generates SmartClient configs from prompts
- **Projects** persist configs in IndexedDB with name/description
- **Inspector** shows the component tree + "Mode: AI" for modification
- **Renderer** maps JSON configs to live SmartClient components
- **Publish Plugin** saves a project as a storage-backed plugin
- **Plugins dropdown** opens published plugins in their own mode
- **Bridge server** provides backend compute, scraping, scheduling
- **CheerpX/CheerpJ runtimes** provide in-browser Java + Linux
- **host.*** surfaces provide the abstraction layer plugins target

## What's missing (the unfinished territory)

### 1. Edit-in-place for published plugins

**Current**: publish is one-way. Once published, the plugin is a static
config. To modify it you have to go back to the playground, edit the
project, and re-publish. The published plugin and the project are
disconnected copies.

**Needed**: when a published plugin is open (`?mode=<id>`), the
Agentiface sidebar should:
- Recognize it's a published plugin (not a playground session)
- Load the plugin's config into the sidebar's editing state
- Allow "Describe changes to malc1..." prompts against the live plugin
- "Save" writes back to the storage-backed plugin (not to the project)
- The live plugin UI updates immediately

**Architecture**: the bridge.js mode dispatcher for plugin modes would
need to also set up the playground editing state (currently only
`?mode=playground` does this). The sidebar's AF tab would work against
the plugin's storage instead of the project persistence store.

### 2. Reverse publish (plugin → project)

**Current**: projects exist in IndexedDB (`sc-projects` database).
Plugins exist in chrome.storage.local. They're separate stores with
separate schemas.

**Needed**: "Import as Project" button on a published plugin that
creates a project from the plugin's config, so you can use the full
project editing workflow (version history, templates, etc.) and then
re-publish.

**Simpler alternative**: just make published plugins editable directly
(item 1 above) and skip the round-trip. Projects become the "source"
and plugins become the "deployed" version. Editing a plugin creates a
new version; the project is the version history.

### 3. Inspector + visual editing maturity

**Current**: the Inspector shows the component tree. "Mode: AI" lets
you describe changes in natural language. "Add Component" dropdown
exists but is rudimentary. The JSON config is the source of truth.

**Needed for declarative editing**:
- **Property inspector**: select a component in the tree → see its
  properties in a form → edit directly (width, title, fields, etc.)
- **Drag-and-drop reorder**: move components in the layout tree
- **Add Component** that inserts properly typed SC components at the
  selected position in the tree
- **Delete Component** with undo
- **DataSource editor**: create/edit DataSources visually (fields,
  primary keys, types)
- **Action editor**: wire button clicks to handlers visually (pick
  from ACTION_MAP or define new dispatch targets)

This is SmartClient's sweet spot — all of this is declarative JSON
manipulation with a known schema. No runtime code generation needed.

### 4. Handler authoring for plugins

**Current**: hello-runtime and horsebread have hand-coded handlers.js
files. Storage-backed plugins (published from projects) have NO
handlers — they're pure UI templates.

**Needed**: a way to add backend behavior to a published plugin:
- **Code editor** in the sidebar for writing handler functions
- **Handler template** library (fetch data, call runtime, transform)
- **Live reload** — save handler code and have it take effect without
  extension reload (this is fundamentally hard in MV3 due to static
  imports; would need eval-in-offscreen or a plugin-handler-interpreter
  pattern)

**Pragmatic alternative**: handlers stay as files on disk (the
assemble.sh pattern). The "publish from Agentiface" path produces
UI-only plugins. Plugins that need handlers are developed as
file-backed plugins with a private repo + assemble script.

### 5. DataSource wiring for published plugins

**Current**: the renderer creates DataSources from the config's
`dataSources[]` array. These route through the bridge.js DS handler
to IndexedDB auto-created stores. Published plugins get their own
namespaced stores (e.g., `plugin:malc1:Scenarios`).

**Needed**:
- DS operations (add/update/remove/fetch) work automatically for
  published plugins — they already do via the existing DS handler
- **Cross-plugin DS isolation** — each plugin's DataSources should be
  namespaced so they don't collide (partially done: DS IDs are unique
  per-config, but the IDB store names aren't namespaced yet)
- **Seed data** — a way to pre-populate a plugin's DataSources with
  fixture records at publish time

### 6. Runtime integration in the Agentiface workflow

**Current**: the AI generates SmartClient configs. CheerpX/CheerpJ are
available via host.runtimes but there's no way to tell the AI
"generate a UI that calls a Java method" or "add a button that runs
a Python script."

**Needed**: the AI system prompt and renderer need to know about:
- The available runtimes and their APIs
- The `dispatchAndDisplay` / `streamSpawnAndAppend` action patterns
- How to generate templates that reference handlers by name
- How to wire buttons to `host.exec.spawn` via the dispatch table

This is the frontier: AI-generated UIs that leverage the full runtime
stack. The building blocks (renderer actions, handler dispatch, runtime
APIs) are all in place — the AI just needs to know about them.

## Recommended phases

### Phase A: Edit published plugins in-place
- Extend bridge.js to set up playground editing state for plugin modes
- "Save" writes back to chrome.storage.local
- The sidebar's AF tab works against the live plugin
- Exit: modify a published plugin's layout from the sidebar

### Phase B: Property inspector
- Select a component → property form in the sidebar
- Edit title, width, fields, etc. → config updates → re-render
- Exit: change a ListGrid's column widths from the inspector

### Phase C: AI-aware runtime actions
- Extend the AI system prompt with runtime action patterns
- AI can generate buttons wired to `dispatchAndDisplay` / `streamSpawnAndAppend`
- Exit: "add a button that runs python3 -c 'print(42)'" generates
  working UI with the CheerpX runtime call

### Phase D: Handler editor + live reload
- Code editor for handler functions in the sidebar
- Eval-in-offscreen or plugin-handler-interpreter for live effect
- Exit: write a handler function in the sidebar, click a button,
  see the result — no file writes, no extension reload

### Phase E: Full project-plugin bidirectional sync
- Projects track their published plugin ID
- Publishing creates a version; editing creates a draft
- "Deploy" pushes the current project state to the published plugin
- Exit: full create → edit → publish → modify → republish loop

## What we have today (remarkable in its own right)

The screenshot shows ALL of these working together:
- AI-generated SmartClient UI running as a published plugin
- Live data entry (scenarios, amortization schedule)
- DataSource persistence across page loads
- Inspector bar + Mode: AI for modification attempts
- Sidebar with project library, history, skin picker
- CheerpJ/CheerpX/BeanShell runtimes available via host.*
- Bridge server with sessions, scripts, schedules
- Asset server for file serving
- The full seven-hop message chain + streaming
- Plugin system with sidebar dropdown discovery

The foundation is solid. The workflow gaps are all about CONNECTING
these pieces, not building new capabilities.
