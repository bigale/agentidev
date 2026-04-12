# Plan: Deprecate Playground Mode in Favor of Plugin Mode

## Why

Playground mode (`?mode=playground`) and plugin mode (`?mode=<id>`) now
do the same thing:

- Both render SmartClient configs via the renderer
- Both support Inspector, skin switching, AI modification (Phase 3)
- Both support Save that persists to plugin storage (Save fix)
- Both support the sidebar's AF tab for editing

The difference: playground mode uses a temporary session that gets lost.
Plugin mode persists to chrome.storage.local and appears in the Plugins
dropdown. There's no reason to keep the temporary session path.

## What changes

### "+ New" button flow

**Current**: + New → create form → `SC_PLAYGROUND_CREATE_PROJECT` →
opens `?mode=playground`

**Target**: + New → create form → `SC_PUBLISH_PLUGIN` with blank
config (or template config) → opens `?mode=<new-plugin-id>`

The user immediately has a persistent, named plugin. No "publish" step
later.

### "Playground" button in the sidebar

**Current**: the AF tab has a "Playground" button that opens
`?mode=playground`

**Target**: remove the Playground button. The Plugins section replaces
it. Clicking any plugin in the list opens `?mode=<id>`.

### Sidebar AF tab state

**Current**: `SC_PLAYGROUND_STATE` tracks the playground session's
config, name, skin, mode, undo stack.

**Target**: same state machine, but keyed by plugin ID. When a plugin
mode tab is focused, the sidebar's state reflects THAT plugin. The
`playgroundSession` object in smartclient-handlers.js gets a `pluginId`
field so the state tracks which plugin is being edited.

### wrapper.html mode dispatch

**Current**: bridge.js has Mode 3 (`?mode=playground`) and Mode 7
(plugin modes). They're separate code paths with different config
loading, state setup, and broadcast handling.

**Target**: Mode 3 becomes a redirect → `?mode=<last-used-plugin>`
or `?mode=<new-blank-plugin>`. Eventually Mode 3 is removed entirely.

### Gallery (no params)

**Current**: opening wrapper.html with no params shows the app gallery.

**Target**: keep the gallery as the "no mode" landing page. It shows
projects and plugins. Clicking one opens `?mode=<id>`.

## Migration

### Phase D1: + New creates a plugin
- `handleCreateProject` calls `SC_PUBLISH_PLUGIN` with the name,
  description, template config, and skin
- Opens `?mode=<new-plugin-id>` instead of `?mode=playground`
- The plugin appears in the Plugins list immediately
- Remove the "Publish Plugin" button (no longer needed — creation IS
  publishing)

### Phase D2: Playground redirect
- `?mode=playground` redirects to `?mode=<last-edited-plugin>` or
  creates a new blank plugin
- The "Playground" button in the sidebar removed
- Legacy playground sessions migrated to plugins on first access

### Phase D3: Unified state management
- `playgroundSession` in smartclient-handlers.js tracks a `pluginId`
- `SC_PLAYGROUND_STATE` returns the state for the current plugin
- `SC_PLAYGROUND_SAVE` saves to the correct plugin's storage
- Undo stack is per-plugin

### Phase D4: Remove playground code
- Remove Mode 3 from bridge.js
- Remove playground-specific handlers
- Remove "Playground" references from the sidebar
- Keep backward-compat: `?mode=playground` → redirect to latest plugin

## What stays the same

- The renderer, inspector, app.js, bridge.js message relay
- The `SC_PLAYGROUND_*` handler names (just internal, can rename later)
- The AI generation pipeline
- The sidebar's AF tab layout
- The SmartClient sandbox iframe

## Order of work

D1 is the only breaking change. D2-D4 are cleanup. Start with D1.
