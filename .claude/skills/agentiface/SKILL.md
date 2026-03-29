---
name: agentiface
description: Agentiface AI-powered SmartClient UI builder architecture, Forge components, sandbox bridge, renderer safety model, config format, deployment portability, and strategic analysis. Use when working on SmartClient app generation, renderer, bridge.js, Forge toolkit, or discussing architecture decisions.
user-invocable: true
disable-model-invocation: false
---

# Agentiface Architecture Skill

Full architecture doc: `docs/agentiface-architecture.md`
Ecosystem doc (capture → clone → meta sites): `docs/ecosystem-architecture.md`

## What Agentiface Is

AI-powered SmartClient UI generation. LLM produces bounded JSON configs; deterministic renderer creates live components in a manifest-sandboxed iframe. Output space is provably bounded (whitelist + descriptor map = no eval of generated code).

## System Layers

1. **Sidepanel AF mode** (`sidepanel/modes/agentiface-mode.js`) — prompt input, actions, app library
2. **Background handlers** (`lib/handlers/smartclient-handlers.js`) — `playgroundSession` state machine (idle/generating/error), broadcasts
3. **Bridge client** (`lib/bridge-client.js`) — WebSocket to server, `generateSmartClientUI(prompt, currentConfig?)`
4. **Bridge server** (`bridge/server.mjs`) — spawns `claude -p --model haiku`, builds system prompt (generate vs modify mode), validates config
5. **Wrapper** (`smartclient-app/wrapper.html` + `bridge.js`) — postMessage relay between chrome.runtime and sandbox
6. **Sandbox** (`smartclient-app/app.html` + `app.js` + `renderer.js`) — SmartClient runtime, Forge toolkit, config rendering
7. **Agentiface toolkit** (`agentiface/` symlinked to `lib/agentiface/`) — 4 CSS + 7 JS files

## Config Format (the portable artifact)

```json
{
  "dataSources": [
    { "ID": "ExampleDS", "fields": [
      { "name": "id", "type": "integer", "primaryKey": true, "hidden": true },
      { "name": "title", "type": "text", "required": true }
    ]}
  ],
  "layout": {
    "_type": "VLayout", "width": "100%", "members": [
      { "_type": "ForgeListGrid", "ID": "grid1", "dataSource": "ExampleDS" },
      { "_type": "DynamicForm", "ID": "form1", "dataSource": "ExampleDS" },
      { "_type": "Button", "title": "Save", "_action": "save", "_targetForm": "form1", "_targetGrid": "grid1" }
    ]
  }
}
```

Key: `_`-prefixed keys are meta (stripped before SC instantiation). `_type` must be in ALLOWED_TYPES whitelist. `_action` maps to ACTION_MAP (no eval). Cross-refs resolved via componentRegistry.

## ALLOWED_TYPES (25)

VLayout, HLayout, ListGrid, DynamicForm, Button, Label, TabSet, Tab, DetailViewer, SectionStack, HTMLFlow, Window, ToolStrip, ToolStripButton, PortalLayout, Portlet, Canvas, Progressbar, ImgButton, ToolStripSeparator, ToolStripMenuButton, Menu, ForgeListGrid, ForgeWizard, ForgeFilterBar

## ACTION_MAP

new, save, delete, select, dispatch, scriptPause, scriptResume, scriptCancel, scriptStep, v8Step, bridgeConnect, bridgeDisconnect

## PostMessage Protocol

Iframe-to-wrapper sources: `smartclient-ai`, `smartclient-ds`, `smartclient-action`, `smartclient-skin-change`, `smartclient-save-layout`, `smartclient-load-layout`, `agentiface-theme-set`, `agentiface-theme-request`

Wrapper-to-iframe sources: `smartclient-ai-response`, `smartclient-ds-response`, `smartclient-action-response`, `smartclient-ds-update`, `smartclient-broadcast`, `smartclient-layout-loaded`, `smartclient-load-dashboard`, `agentiface-theme-response`

## Forge Components

- **ForgeListGrid** — skeleton shimmer loading, extends ListGrid
- **ForgeToast** — notification queue (max 5), info/success/warning/error
- **ForgeWizard** — multi-step forms with validation, step indicators
- **ForgeFilterBar** — search + advanced FilterBuilder, binds to targetGrid
- **ForgeA11y** — ARIA enhancement pass (roles, labels, live regions, focus trap)
- **ForgeRegistry** — 15 pre-registered component types, palette data for builder
- **ThemeManager** — light/dark/system, CSS token-based

## Persistence

- **IndexedDB** (`SC_APP_*`) — auto-save after generation
- **Bridge disk** (`AF_APP_*`) — `~/.contextual-recall/agentiface-apps/*.json`, manual save, has history[]
- Gallery merges both; bridge wins on ID collision

## Portability Strategy

Forge config JSON is the stable artifact. The renderer is swappable:
- Current: `renderer.js` -> `isc.ForgeListGrid.create()` etc (SmartClient)
- Alternative: React renderer -> MUI DataGrid + Forms
- Alternative: Node renderer -> HTML + HTMX (Docker/server deployment)
- Alternative: Native renderer -> Tauri/Electron widgets

The config format has no SmartClient-specific concepts. DataSource schemas map to SQL tables, REST endpoints, or any CRUD backend. System prompt + validation logic runs anywhere Node.js runs.

## Key Architectural Decisions

1. **Sandbox required** because SmartClient needs eval/Function — but sandbox also provides security isolation (net positive)
2. **DS proxy through postMessage** adds latency but keeps storage decoupled — same DS schema works in IndexedDB, SQLite, or Postgres
3. **Haiku model** is a self-imposed limit — system prompt is model-agnostic, should test Sonnet/Opus for complex layouts
4. **Forge-as-abstraction** is the exit strategy from SmartClient if needed — renderer swappable, config stable

## 19 Skins

Tahoe, Obsidian, Graphite, Stratus, Simplicity, SilverWave, Enterprise, EnterpriseBlue, Cascade, TreeFrog, BlackOps, Twilight, fleet, Cupertino, Shiva, ShivaBlue, ShivaDark, Mobile, SmartClient

Switching reloads iframe with `?skin=X`; config preserved via background session state.

## Files Quick Reference

| File | Purpose |
|---|---|
| `smartclient-app/renderer.js` | JSON config to SC components, safety model |
| `smartclient-app/bridge.js` | postMessage relay |
| `smartclient-app/app.js` | Prompt bar, undo stack, AI response handler |
| `smartclient-app/app.html` | Sandboxed page with shims + SC modules |
| `lib/handlers/smartclient-handlers.js` | Session state + all SC_PLAYGROUND_* handlers |
| `lib/handlers/app-persistence.js` | IndexedDB CRUD |
| `lib/bridge-client.js` | WebSocket client |
| `sidepanel/modes/agentiface-mode.js` | AF mode controller |
| `bridge/server.mjs` | BRIDGE_SC_GENERATE_UI + BRIDGE_AF_APP_* handlers |
| `agentiface/*.js, *.css` | Forge toolkit (7 JS + 4 CSS) |
