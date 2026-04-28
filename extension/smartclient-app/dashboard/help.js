// dashboard/help.js
// Help window content + filter.
// Functions: showHelpWindow, _filterHelp, _buildHelpHTML

var _helpWindow = null;

function showHelpWindow() {
  if (_helpWindow && !_helpWindow.destroyed) {
    _helpWindow.show();
    _helpWindow.bringToFront();
    return;
  }

  var helpContent = _buildHelpHTML();

  var searchForm = isc.DynamicForm.create({
    width: '100%',
    height: 30,
    numCols: 2,
    colWidths: [60, '*'],
    fields: [{
      name: 'search',
      title: 'Search',
      type: 'text',
      width: '*',
      changed: function (form, item, value) {
        _filterHelp(helpFlow, value);
      },
    }],
  });

  var helpFlow = isc.HTMLFlow.create({
    width: '100%',
    height: '*',
    overflow: 'auto',
    padding: 12,
    contents: helpContent,
  });

  _helpWindow = isc.Window.create({
    ID: 'helpWindow',
    title: 'Agentidev Dashboard Help',
    width: 640,
    height: 520,
    canDragReposition: true,
    canDragResize: true,
    autoCenter: true,
    showMinimizeButton: true,
    items: [
      isc.VLayout.create({
        width: '100%',
        height: '100%',
        members: [searchForm, helpFlow],
      }),
    ],
  });
}

function _filterHelp(flow, query) {
  if (!flow) return;
  var full = _buildHelpHTML();
  if (!query || query.length < 2) {
    flow.setContents(full);
    return;
  }
  var q = query.toLowerCase();
  // Filter sections: keep only those whose content matches
  var parser = document.createElement('div');
  parser.innerHTML = full;
  var sections = parser.querySelectorAll('.help-section');
  var matched = 0;
  for (var i = 0; i < sections.length; i++) {
    var text = sections[i].textContent.toLowerCase();
    if (text.indexOf(q) === -1) {
      sections[i].style.display = 'none';
    } else {
      sections[i].style.display = '';
      matched++;
    }
  }
  if (matched === 0) {
    flow.setContents('<div style="padding:20px;color:#888;">No matches for <b>' + isc.makeXMLSafe(query) + '</b></div>');
  } else {
    flow.setContents(parser.innerHTML);
  }
}

function _buildHelpHTML() {
  var css = 'style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; font-size: 13px; line-height: 1.5; color: #222;"';
  var h2 = 'style="font-size: 15px; font-weight: 600; color: #1a5276; margin: 16px 0 6px 0; border-bottom: 1px solid #ddd; padding-bottom: 4px;"';
  var h3 = 'style="font-size: 13px; font-weight: 600; color: #333; margin: 10px 0 4px 0;"';
  var dt = 'style="font-weight: 600; color: #1a5276; margin-top: 6px;"';
  var dd = 'style="margin: 0 0 4px 16px; color: #444;"';
  var note = 'style="background: #fef9e7; border-left: 3px solid #f0b429; padding: 6px 10px; margin: 8px 0; font-size: 12px; color: #555;"';

  return '<div ' + css + '>'

  // Overview
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Overview</h2>'
  + '<p>The Agentidev Dashboard is the central hub for browser automation, script development, testing, and scheduling. '
  + 'It connects to a local <b>bridge server</b> (WebSocket on port 9876) that manages Playwright browser sessions, '
  + 'runs automation scripts, and archives results.</p>'
  + '<p>The dashboard runs inside a sandboxed SmartClient iframe. All data is local — nothing leaves your machine.</p>'
  + '</div>'

  // Toolbar
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Toolbar</h2>'
  + '<dl>'
  + '<dt ' + dt + '>File</dt><dd ' + dd + '>Open a script from disk, Save the current editor, or Save As to a new name.</dd>'
  + '<dt ' + dt + '>Connect / Disconnect</dt><dd ' + dd + '>Toggle the WebSocket connection to the bridge server. The green dot shows connection status.</dd>'
  + '<dt ' + dt + '>Run</dt><dd ' + dd + '>Launch the selected script. If a ready session is selected, the script connects to that browser; otherwise it launches its own.</dd>'
  + '<dt ' + dt + '>Pause / Resume / Stop</dt><dd ' + dd + '>Pause at the next checkpoint, resume execution, or gracefully cancel the script.</dd>'
  + '<dt ' + dt + '>Step / Continue</dt><dd ' + dd + '>Step advances one checkpoint at a time. Continue clears all breakpoints and runs freely. These are script-level controls (checkpoint-based).</dd>'
  + '<dt ' + dt + '>Kill</dt><dd ' + dd + '>Force-terminate the script immediately (SIGTERM then SIGKILL).</dd>'
  + '<dt ' + dt + '>Debug</dt><dd ' + dd + '>Launch the script under the V8 inspector with <code>--inspect-brk</code>. Step Into / Step Out send V8 debugger commands.</dd>'
  + '<dt ' + dt + '>Auth</dt><dd ' + dd + '>Capture browser authentication state (cookies, localStorage) for the current script. Opens the login URL found in the script source, then saves the auth state for reuse on subsequent runs.</dd>'
  + '<dt ' + dt + '>Sync</dt><dd ' + dd + '>Export the extension\'s IndexedDB stores to the bridge for backup and cross-session persistence.</dd>'
  + '<dt ' + dt + '>Capture</dt><dd ' + dd + '>Toggle artifact capture. When enabled, screenshots are taken at each checkpoint during script execution.</dd>'
  + '<dt ' + dt + '>?</dt><dd ' + dd + '>This help window.</dd>'
  + '</dl>'
  + '</div>'

  // Sessions
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Sessions</h2>'
  + '<p>A <b>session</b> is a persistent Playwright-managed browser instance. Sessions stay open so you can observe what automation scripts do in real time.</p>'
  + '<dl>'
  + '<dt ' + dt + '>New</dt><dd ' + dd + '>Create a named session — a headed Chromium browser opens and remains available.</dd>'
  + '<dt ' + dt + '>Destroy</dt><dd ' + dd + '>Close the selected session and its browser.</dd>'
  + '</dl>'
  + '<div ' + note + '><b>Session + Script linking:</b> If you select a session before clicking Run, the script connects to that session\'s browser instead of opening its own. '
  + 'The session must show a <b>ready</b> status (browser running with CDP endpoint). '
  + 'After the script finishes, the session browser stays open so you can inspect the result. '
  + 'The script does not own the session lifecycle — it just borrows the browser.</div>'
  + '</div>'

  // Sessions vs Scripts architecture
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Sessions vs. Scripts</h2>'
  + '<p>There are two ways scripts interact with browsers:</p>'
  + '<h3 ' + h3 + '>Standalone (no session selected)</h3>'
  + '<p>The Playwright shim creates a fresh browser, runs the automation, and the browser closes when the script exits. Every run starts with a clean slate. Best for <b>testing, CI, and scheduled runs</b>.</p>'
  + '<h3 ' + h3 + '>Session-linked (session selected)</h3>'
  + '<p>The script connects to the session\'s existing browser via CDP. The browser persists after the script ends, so state accumulates across runs (cookies, navigation history, DOM changes). Best for <b>development and debugging</b> where you want to observe results.</p>'
  + '<div ' + note + '><b>State responsibility:</b> Scripts are responsible for their own preconditions. If a script needs a clean browser, it should navigate to <code>about:blank</code> or clear cookies at the start. The session is a shared viewport, not a clean room.</div>'
  + '</div>'

  // Scripts Library
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Scripts Library</h2>'
  + '<p>Lists all scripts registered with the bridge. Scripts appear here when:</p>'
  + '<ul style="margin:4px 0 4px 20px;padding:0;">'
  + '<li>Saved to <code>~/.agentidev/scripts/</code> (the bridge file watcher auto-syncs them)</li>'
  + '<li>Opened via File &rarr; Open from the toolbar</li>'
  + '<li>Saved from the editor via File &rarr; Save</li>'
  + '</ul>'
  + '<p>Click a script to load it in the editor. The version sub-grid shows prior saves. The Recipe picker assigns pre/post actions to the script.</p>'
  + '</div>'

  // Script History
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Script History</h2>'
  + '<p><b>Live</b> mode shows currently running and recently launched scripts with real-time step/state updates. '
  + '<b>Archive</b> mode shows completed runs from the database with timing and artifact counts.</p>'
  + '<p>Double-click any entry to open its source in the editor. Right-click for a context menu with Open in Editor and Run Script options.</p>'
  + '</div>'

  // Source Editor
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Source Editor</h2>'
  + '<p>Full Monaco editor (VS Code engine) with JavaScript syntax highlighting, line numbers, and code folding.</p>'
  + '<ul style="margin:4px 0 4px 20px;padding:0;">'
  + '<li>Click the glyph margin to toggle breakpoints at <code>client.checkpoint()</code> lines</li>'
  + '<li>The current paused checkpoint is highlighted in gold</li>'
  + '<li>Ctrl+S saves the script to the library and disk</li>'
  + '</ul>'
  + '</div>'

  // Script Detail
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Script Detail</h2>'
  + '<p>Three tabs for the selected script:</p>'
  + '<dl>'
  + '<dt ' + dt + '>State</dt><dd ' + dd + '>Live view of script name, state, step progress, activity label, and session. Includes Step/Continue/Kill buttons for checkpoint-level debugging.</dd>'
  + '<dt ' + dt + '>Assertions</dt><dd ' + dd + '>Shows individual pass/fail results from <code>client.assert()</code> calls in test scripts, streamed in real time. The summary label shows total pass/fail counts.</dd>'
  + '<dt ' + dt + '>Artifacts</dt><dd ' + dd + '>Lists captured files (screenshots, console logs, results) with a preview pane. Click an artifact to render it inline. Scripts register artifacts via <code>client.artifact()</code>.</dd>'
  + '</dl>'
  + '</div>'

  // Recipes
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Recipes</h2>'
  + '<p>Recipes define ordered <b>pre-actions</b> and <b>post-actions</b> that run before and after a script launch. Examples: navigate to a URL, set a cookie, clear storage, take a screenshot.</p>'
  + '<p>Actions are selected from a command palette, can be reordered by drag, and removed individually. Recipes are saved independently and assigned to scripts via the library picker.</p>'
  + '</div>'

  // Schedules
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Schedules</h2>'
  + '<p>Automatically run scripts on a cron expression or fixed interval. The schedules grid shows name, script, cron/interval, enabled toggle, run count, and next scheduled time.</p>'
  + '<p>Name, script, and enabled state are inline-editable (double-click). The sub-grid shows run history for the selected schedule. Buttons: New, Edit, Trigger (run now), Delete.</p>'
  + '</div>'

  // Test Results
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Test Results</h2>'
  + '<p>Displays pass/fail counts for test scripts that use <code>client.assert()</code>. '
  + '<b>Run All Tests</b> launches the internal test suite. <b>Refresh</b> reloads stored results.</p>'
  + '</div>'

  // Activity
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Activity</h2>'
  + '<p>Scrolling log of bridge commands and events in reverse-chronological order. Shows the message type, summary, and timestamp. Useful for debugging communication between the dashboard and bridge server.</p>'
  + '</div>'

  // Writing Scripts
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Writing Automation Scripts</h2>'
  + '<p>Scripts use the <b>Playwright shim</b> as a drop-in replacement for <code>import { chromium } from \'playwright\'</code>. '
  + 'The shim auto-connects a ScriptClient to the bridge and wraps Page operations (navigate, click, fill, eval, screenshot) as checkpoints.</p>'
  + '<pre style="background:#f4f4f4;padding:8px;border-radius:4px;font-size:12px;overflow-x:auto;">'
  + 'import { chromium, client } from \'../packages/bridge/playwright-shim.mjs\';\n\n'
  + 'const browser = await chromium.launch({ headless: false });\n'
  + 'const page = await browser.newPage();\n'
  + 'await page.goto(\'https://example.com\');\n'
  + 'await client.progress(1, 3, \'Loaded page\');\n\n'
  + '// Assertions for test scripts\n'
  + 'client.assert(await page.title() === \'Example\', \'Page title correct\');\n\n'
  + '// Register artifacts\n'
  + 'await page.screenshot({ path: \'/tmp/shot.png\' });\n'
  + 'await client.artifact({ type: \'screenshot\', label: \'Result\', filePath: \'/tmp/shot.png\', contentType: \'image/png\' });\n\n'
  + 'await client.complete({ assertions: client.getAssertionSummary() });\n'
  + 'await browser.close();\n'
  + '</pre>'
  + '</div>'

  // Bridge CLI
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Bridge CLI</h2>'
  + '<p>All bridge operations are also available from the command line:</p>'
  + '<pre style="background:#f4f4f4;padding:8px;border-radius:4px;font-size:12px;overflow-x:auto;">'
  + 'bcli = node packages/bridge/claude-client.mjs\n\n'
  + 'bcli session:create \'{"name":"my-session"}\'\n'
  + 'bcli session:navigate \'{"sessionId":"ID","url":"https://..."}\'\n'
  + 'bcli session:snapshot \'{"sessionId":"ID"}\'    # accessibility tree\n'
  + 'bcli script:launch \'{"path":"my-script.mjs"}\'\n'
  + 'bcli script:list\n'
  + 'bcli schedule:list\n'
  + '</pre>'
  + '</div>'

  // Keyboard Shortcuts
  + '<div class="help-section">'
  + '<h2 ' + h2 + '>Keyboard Shortcuts</h2>'
  + '<dl>'
  + '<dt ' + dt + '>Ctrl+S</dt><dd ' + dd + '>Save the current script</dd>'
  + '</dl>'
  + '</div>'

  + '</div>';
}
