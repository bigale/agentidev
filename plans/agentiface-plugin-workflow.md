# Plan: Agentiface Plugin Authoring (Revised)

## The vision

**The Playground IS the plugin editor. Projects ARE plugins. No separate
publish step.** Think Microsoft Access: design mode (sidebar open) and
view mode (sidebar closed). The sidebar is the design surface. The
canvas is the running app.

```
+ New → creates a plugin → opens in Playground (design mode)
Edit  → sidebar open: AI prompt, inspector, skin, settings
Save  → writes directly to plugin storage (chrome.storage.local)
Run   → sidebar closed: the app runs, users interact
Switch → Plugins dropdown: navigate between apps
Delete → removes from storage
```

This replaces the old "project + publish" two-step flow with a single
concept: plugins that are always editable.

## UX model: Microsoft Access, not VS Code

The inspiration is Access: a self-contained environment where you
design forms, wire data sources, and switch between design mode and
run mode. The sidebar is the property sheet / toolbox. The canvas is
the form.

**Design mode** (sidebar open, AF tab active):
- AI prompt: "describe changes to malc1..."
- Inspector: component tree, select → property editing
- Settings: skin picker, model, capabilities (collapsible sections)
- Plugin list: all plugins, + New, delete
- Save / Undo / History / Reset

**Run mode** (sidebar closed or on a different tab):
- Clean SmartClient app, no editing chrome
- Full data entry, DS persistence, runtime calls

**Navigation**: sidebar Plugins dropdown OR the AF tab's plugin list.

## What comes for free with every plugin

1. **Skin picker** — every plugin gets the full SmartClient skin
   library (Enterprise, Tahoe, Graphite, etc.). The skin is a
   per-plugin setting stored alongside the config.
2. **DataSource persistence** — the renderer's DS handler auto-creates
   IndexedDB stores. CRUD works immediately for any ListGrid/Form.
3. **Inspector** — the component tree is always available in the
   sidebar. Select → see/edit properties.
4. **AI modification** — "describe changes" prompt works against any
   plugin's config, not just playground sessions.
5. **Undo / History** — config versioning comes from the playground's
   existing undo stack, now applied to plugins.

## Sidebar layout (AF tab, collapsible sections)

```
┌─ AF Tab ──────────────────────┐
│ [Plugin Name]  ▾ malc1        │  ← dropdown or editable
│ [Describe changes...]  [Go]   │  ← AI prompt
│                               │
│ ▾ Actions                     │  ← collapsible
│   Save  Undo  History  Reset  │
│                               │
│ ▾ Inspector                   │  ← collapsible
│   [component tree]            │
│   [property form for selected]│
│                               │
│ ▾ Settings                    │  ← collapsible
│   Skin: [Enterprise ▾]       │
│   Model: [Sonnet 4.6 ▾]     │
│   ☑ Skin Picker capability   │
│                               │
│ ▾ Plugins                     │  ← collapsible
│   + New                       │
│   malc1          2 DS    x   │
│   horsebread     ★ bridge x  │
│   hello-runtime  ★ ref   x  │
│                               │
│ ▾ Runtimes (when applicable)  │  ← collapsible
│   cheerpj ● ready             │
│   cheerpx ● ready             │
│   bsh     ● ready             │
└───────────────────────────────┘
```

The key insight: **everything goes in the sidebar.** No separate
"design mode" chrome in the canvas. The canvas always shows the
running app. The sidebar is where you author.

## What needs to change

### 1. Unify projects and plugins (the big refactor)

**Current**: projects live in IndexedDB (`sc-projects`), plugins live
in `chrome.storage.local` (storage-backed) or `extension/apps/`
(file-backed). Two separate concepts.

**Target**: ONE concept — "plugins." The AF tab's "Project Library"
becomes "Plugins." Creating a new plugin saves to chrome.storage.local
immediately. The old project persistence store becomes a compatibility
layer.

**Migration**: existing projects get a one-time migration to
storage-backed plugins. Or: keep the project store as-is and just
make the AF tab read from BOTH (plugins first, projects as legacy).

### 2. Plugin editing state

**Current**: `SC_PLAYGROUND_STATE` manages the editing state for
`?mode=playground`. Plugin modes don't have editing state.

**Target**: when the AF tab is active and a plugin is selected, the
sidebar's editing state is tied to that plugin's config. Changes
(AI-prompted or manual) update the plugin's config in storage.
`?mode=<plugin-id>` uses the same editing infrastructure as
`?mode=playground`.

### 3. Collapsible sidebar sections

**Current**: the AF tab has a flat layout — prompt, actions, project
library.

**Target**: collapsible sections (Actions, Inspector, Settings,
Plugins, Runtimes). Each remembers its open/closed state.
Settings section holds skin picker, model, capabilities.

### 4. Skin as a per-plugin setting

**Current**: skin is per-playground-session (stored in background
state). Plugins use the default skin (Tahoe).

**Target**: skin is stored in the plugin manifest. Opening a plugin
applies its skin. The skin picker in the Settings section updates
the plugin's manifest when changed.

### 5. Inspector activation for all modes

**Current**: the Inspector bar (Inspector | Mode: AI | Add Component)
renders in the canvas but only activates for `?mode=playground`.

**Target**: Inspector activates for ANY mode when the sidebar's AF
tab is active. The component tree reflects the current plugin's
rendered components. Select → property editing in the sidebar.

### 6. AI system prompt for runtime actions

**Current**: the AI generates standard SmartClient configs (ListGrids,
Forms, Buttons with basic actions like 'new', 'save', 'delete').

**Target**: the AI system prompt includes:
- Available runtime actions: `dispatchAndDisplay`, `streamSpawnAndAppend`
- Available handler names (from the plugin's handler table)
- Available runtimes: cheerpj (Java), cheerpx (Python/Linux), bsh
- Pattern: "to call Python, add a Button with _action:
  dispatchAndDisplay, _messageType: HOST_EXEC_SPAWN, _messagePayload:
  { cmd: '/usr/bin/python3', args: [...] }"

## Recommended phases (revised)

### Phase 1: Plugins as the primary concept
- AF tab's "Project Library" reads from PLUGIN_LIST
- "+ New" calls SC_PUBLISH_PLUGIN with a blank config
- Clicking a plugin opens `?mode=<id>` with editing state
- "Save" writes to plugin storage
- "Delete" removes from storage
- Existing projects shown as "Legacy" (read-only import)

### Phase 2: Collapsible sidebar + Settings
- Refactor AF tab layout into collapsible sections
- Settings section: skin picker, model selector, capabilities
- Skin persisted per-plugin in the manifest
- Section open/closed state persisted

### Phase 3: Inspector for all modes
- Inspector activates when AF tab is active, regardless of mode
- Component tree reflects the running plugin's SC components
- Select → basic property display in the sidebar

### Phase 4: AI-aware runtime actions
- Extend the generation system prompt with runtime patterns
- AI can wire buttons to `dispatchAndDisplay` / `streamSpawnAndAppend`
- AI knows about available handlers and runtimes

### Phase 5: Property editing + DataSource editor
- Select component in inspector → editable property form
- Edit fields, widths, titles, actions → config updates → re-render
- DataSource field editor for adding/removing columns

## File-backed plugins vs storage-backed plugins

Two tiers coexist:

**Storage-backed** (created in the sidebar):
- Pure UI templates, no handlers
- Created/edited/deleted from the AF tab
- Config in chrome.storage.local
- Great for dashboards, calculators, data entry apps
- DataSources auto-created in IndexedDB

**File-backed** (assembled from a private repo):
- Have handlers.js for backend logic
- Assembled via assemble.sh (horsebread pattern)
- Appear in the AF tab alongside storage-backed plugins
- Read-only in the sidebar (edit in your code editor)
- Bridge integration, runtime calls, scheduling

Both show up in the same Plugins list. The AF tab shows a
"★ bridge" badge or similar for file-backed plugins to indicate
they're externally managed.
