---
name: ui-testing
description: Agentidev UI testing via CDP — screenshots, SmartClient AutoTest locators, plugin creation, sidebar interaction. Use when testing the extension UI, verifying visual state, debugging rendering issues, or creating/modifying plugins programmatically.
user-invocable: true
disable-model-invocation: false
---

# UI Testing Skill

Test the agentidev extension UI from Claude Code using CDP (Chrome DevTools Protocol) and SmartClient AutoTest locators.

## Prerequisites

- Browser running with `--remote-debugging-port=9222` (`npm run browser`)
- Extension loaded and enabled
- Bridge server running (`npm run bridge`)

## Core Tools

### Screenshot any page/iframe

```bash
# Find the target
curl -s http://localhost:9222/json | python3 -c "
import sys,json; ts=json.load(sys.stdin)
for t in ts:
    if t['type'] in ('page','iframe'):
        print(f'{t[\"type\"]:8s} {t.get(\"title\",\"\")[:35]:35s} {t[\"url\"][:70]}')
"

# Screenshot by WebSocket URL
node packages/bridge/scripts/cdp-screenshot.mjs "<ws-url>" /tmp/screenshot.png
```

### Eval in the SmartClient sandbox iframe

```bash
# Find the sandbox iframe (app.html) for a specific plugin mode
# The iframe is listed AFTER its parent wrapper page in the CDP target list

node packages/bridge/scripts/iframe-click.mjs "<sandbox-ws-url>" "<js-expression>"
```

### Eval in the service worker

```bash
node packages/bridge/scripts/sw-eval.mjs "<js-expression>"
```

### SmartClient AutoTest Locators

Inside the sandbox iframe, use `isc.AutoTest.getObject()` with these patterns:

```javascript
// By component ID
isc.AutoTest.getObject('//Button[ID="btnFetch"]')
isc.AutoTest.getObject('//ListGrid[ID="alertsGrid"]')
isc.AutoTest.getObject('//VLayout[ID="weatherRoot"]')

// By type
isc.AutoTest.getObject('//DynamicForm[ID="taskForm"]')

// Read grid data
var grid = isc.AutoTest.getObject('//ListGrid[ID="alertsGrid"]');
grid.getTotalRows()
grid.getRecord(0)

// Read form values
var form = isc.AutoTest.getObject('//DynamicForm[ID="taskForm"]');
form.getValues()

// Click a button
var btn = isc.AutoTest.getObject('//Button[ID="btnSave"]');
btn.click()
```

### Modify config via Inspector API

```javascript
// In the sandbox iframe:
var config = window._currentConfig;
var newConfig = ConfigInspector.setPropertyOnConfig(config, 'layout.members[0]', 'title', 'New Title');
window._currentConfig = JSON.parse(JSON.stringify(newConfig));
window.parent.postMessage({ source: 'smartclient-config-updated', config: newConfig }, '*');
```

## Plugin Operations (via SW handlers)

### Create a plugin

```bash
node packages/bridge/scripts/sw-eval.mjs "(async () => {
  return await globalThis.__handlers['SC_PUBLISH_PLUGIN']({
    name: 'My Plugin',
    description: 'What it does',
    config: {
      layout: {
        _type: 'VLayout', width: '100%', height: '100%',
        members: [
          { _type: 'Label', height: 28, contents: 'Hello World' }
        ]
      }
    }
  });
})()"
```

### List plugins

```bash
node packages/bridge/scripts/sw-eval.mjs "(async () => {
  return (await globalThis.__handlers['PLUGIN_LIST']({})).map(p => p.id);
})()"
```

### Delete a plugin

```bash
node packages/bridge/scripts/sw-eval.mjs "(async () => {
  return await globalThis.__handlers['SC_UNPUBLISH_PLUGIN']({ id: 'my-plugin' });
})()"
```

### Read a plugin's template

```bash
node packages/bridge/scripts/sw-eval.mjs "(async () => {
  var t = await globalThis.__handlers['PLUGIN_GET_TEMPLATE']({ id: 'my-plugin', template: 'dashboard' });
  return { hasConfig: !!t.config };
})()"
```

## Testing Workflow

### 1. Visual regression check

```bash
# Screenshot before
node packages/bridge/scripts/cdp-screenshot.mjs "$WS_URL" /tmp/before.png

# Make changes...

# Screenshot after
node packages/bridge/scripts/cdp-screenshot.mjs "$WS_URL" /tmp/after.png

# View both
```

### 2. Verify grid data loaded

```bash
node packages/bridge/scripts/iframe-click.mjs "$SANDBOX_WS" "(async () => {
  var btn = isc.AutoTest.getObject('//Button[ID=\"btnFetch\"]');
  btn.click();
  await new Promise(r => setTimeout(r, 8000));
  var grid = isc.AutoTest.getObject('//ListGrid[ID=\"alertsGrid\"]');
  return { rows: grid.getTotalRows(), first: grid.getRecord(0) };
})()"
```

### 3. Test save persistence

```bash
# Change something
node packages/bridge/scripts/iframe-click.mjs "$SANDBOX_WS" "(async () => {
  var config = window._currentConfig;
  var newConfig = ConfigInspector.setPropertyOnConfig(config, 'path', 'prop', 'value');
  window._currentConfig = JSON.parse(JSON.stringify(newConfig));
  window.parent.postMessage({ source: 'smartclient-config-updated', config: newConfig }, '*');
  return 'changed';
})()"

# Save via SW
node packages/bridge/scripts/sw-eval.mjs "(async () => {
  await globalThis.__handlers['SC_PLAYGROUND_SAVE']({});
  var state = await globalThis.__handlers['SC_PLAYGROUND_STATE']({});
  await globalThis.__handlers['SC_PUBLISH_PLUGIN']({
    name: state.projectName,
    projectId: state.pluginId,
    config: state.config,
  });
  return 'saved';
})()"

# Verify persisted
node packages/bridge/scripts/sw-eval.mjs "(async () => {
  var t = await globalThis.__handlers['PLUGIN_GET_TEMPLATE']({ id: 'my-plugin', template: 'dashboard' });
  return t.config.layout.members[0].title;
})()"
```

## Available Actions for Generated UIs

| Action | Purpose | Key props |
|--------|---------|-----------|
| `dispatchAndDisplay` | Call SW handler, show result | `_messageType`, `_messagePayload`, `_targetCanvas`, `_resultFormatter` |
| `fetchAndLoadGrid` | Fetch API → load into ListGrid | `_messageType`, `_messagePayload`, `_targetGrid`, `_statusCanvas` |
| `streamSpawnAndAppend` | Stream CheerpX command output | `_cmd`, `_args`, `_targetCanvas` |
| `new/save/delete/select` | CRUD on DataSources | `_targetForm`, `_targetGrid` |
| `compute` | Client-side math | `_sourceForm`, `_targetForm`, `_formulas` |
| `dispatch` | Fire-and-forget handler call | `_messageType`, `_messagePayload` |

## User Request

$ARGUMENTS
