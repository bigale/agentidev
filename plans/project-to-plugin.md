# Plan: Publish Agentiface Projects as Plugins

Take any SmartClient config created in the Agentiface playground and
"publish" it as a plugin accessible from the sidebar Plugins dropdown.

## Architecture

Agentiface projects are SmartClient JSON configs stored in IndexedDB
(via `project-persistence.js`). Plugins are `extension/apps/<id>/`
directories with manifests + templates. We can't write files to the
extension package at runtime, so project-published plugins are stored
in `chrome.storage.local` instead.

```
Project (IndexedDB)                 Published Plugin (chrome.storage.local)
├── config (SC JSON)        →       ├── plugin:<id>:manifest
├── name                             │   { id, name, modes, templates... }
├── description                      └── plugin:<id>:template
└── capabilities                         { layout, dataSources }
```

The plugin loader discovers BOTH file-backed plugins (from `index.json`)
AND storage-backed plugins (from `chrome.storage.local` keys matching
`plugin:*:manifest`). No `_loaded.js` entry needed — project plugins
don't have handlers (they're pure UI templates).

## Flow

1. User creates a project in the Agentiface playground
2. User clicks "Publish as Plugin" in the sidebar
3. The handler reads the project config + metadata
4. Writes manifest + template to `chrome.storage.local`
5. Plugin appears in the sidebar Plugins dropdown (after a reload
   or via a live-refresh mechanism)
6. Opening the plugin renders the same SmartClient UI as the playground

## What needs to change

### plugin-loader.js
- At boot, scan `chrome.storage.local` for `plugin:*:manifest` keys
- Register each storage-backed plugin in the same `_registry` map
- These plugins have no handlers (handlers-free) — just templates

### PLUGIN_GET_TEMPLATE handler
- Check storage-backed plugins first: if the plugin ID starts with
  a known prefix or is in the storage registry, read the template
  from `chrome.storage.local` instead of fetching a file

### Agentiface sidebar (agentiface-mode.js)
- Add a "Publish as Plugin" button next to "Save as Template"
- Calls `SC_PUBLISH_PLUGIN` handler with the project ID

### New SW handler: SC_PUBLISH_PLUGIN
- Reads the project from the project persistence store
- Generates a manifest (id from project name, modes, templates)
- Stores both in chrome.storage.local
- Returns success + the plugin URL

### Sidebar Plugins dropdown (auto-mode.js)
- Already reads from PLUGIN_LIST — storage-backed plugins will appear
  automatically once the loader registers them

## Exit criteria

1. Create a project in the playground (e.g., mortgage calculator)
2. Click "Publish as Plugin" in the sidebar
3. The plugin appears in the Plugins dropdown
4. Opening it renders the same UI
5. The plugin persists across browser restarts (chrome.storage.local)
