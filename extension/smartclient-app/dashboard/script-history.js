// dashboard/script-history.js
// Live/Archive history toggle + Console/Network refresh.
// Functions: refreshSessionConsole, refreshSessionNetwork, wireScriptHistoryToggle, switchToLiveMode, switchToArchiveMode, loadArchiveRuns, handleArchiveRunSelect

function refreshSessionConsole() {
  var sessionId = getSelectedSessionId();
  if (!sessionId) {
    var out = resolveRef('consoleOutput');
    if (out) out.setContents('<div style="padding:8px;color:#888;font-size:11px;">Select a session first</div>');
    return;
  }
  var label = resolveRef('consoleSummaryLabel');
  if (label) label.setContents('<span style="color:#888;">Loading...</span>');
  dispatchActionAsync('BRIDGE_SEND_COMMAND', { sessionId: sessionId, command: 'console' }, 15000).then(function (resp) {
    var output = (resp && resp.output) || '';
    var out = resolveRef('consoleOutput');
    if (!out) return;
    // Parse console output into formatted HTML
    var lines = output.split('\n');
    var html = '';
    var msgCount = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.startsWith('###') || line.startsWith('Total messages') || line.startsWith('- ')) continue;
      msgCount++;
      var color = '#aaa';
      if (line.startsWith('[ERROR]') || line.startsWith('[error]')) color = '#f44336';
      else if (line.startsWith('[WARNING]') || line.startsWith('[warning]')) color = '#ff9800';
      else if (line.startsWith('[INFO]') || line.startsWith('[info]')) color = '#4fc3f7';
      html += '<div style="padding:1px 4px;font-size:11px;font-family:monospace;color:' + color + ';border-bottom:1px solid #333;white-space:pre-wrap;">' + escapeHtmlDash(line) + '</div>';
    }
    if (!html) html = '<div style="padding:8px;color:#888;font-size:11px;">No console messages</div>';
    out.setContents(html);
    // Update summary
    var summaryMatch = output.match(/Total messages: (\d+) \(Errors: (\d+), Warnings: (\d+)\)/);
    if (label && summaryMatch) {
      label.setContents('<span style="font-size:11px;color:#aaa;">' + summaryMatch[1] + ' messages, ' +
        '<span style="color:#f44336;">' + summaryMatch[2] + ' errors</span>, ' +
        '<span style="color:#ff9800;">' + summaryMatch[3] + ' warnings</span></span>');
    } else if (label) {
      label.setContents('<span style="font-size:11px;color:#aaa;">' + msgCount + ' messages</span>');
    }
  }).catch(function () {
    var out = resolveRef('consoleOutput');
    if (out) out.setContents('<div style="padding:8px;color:#f44336;font-size:11px;">Failed to load console</div>');
  });
}

function refreshSessionNetwork() {
  var sessionId = getSelectedSessionId();
  if (!sessionId) {
    var out = resolveRef('networkOutput');
    if (out) out.setContents('<div style="padding:8px;color:#888;font-size:11px;">Select a session first</div>');
    return;
  }
  var label = resolveRef('networkSummaryLabel');
  if (label) label.setContents('<span style="color:#888;">Loading...</span>');
  dispatchActionAsync('BRIDGE_SEND_COMMAND', { sessionId: sessionId, command: 'network' }, 15000).then(function (resp) {
    var output = (resp && resp.output) || '';
    var out = resolveRef('networkOutput');
    if (!out) return;
    // Parse network output: [METHOD] URL => [STATUS] size
    var lines = output.split('\n');
    var html = '';
    var reqCount = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.startsWith('###') || line.startsWith('- ')) continue;
      var match = line.match(/^\[(\w+)\]\s+(\S+)\s+=>\s+\[([^\]]+)\]\s*(.*)/);
      if (match) {
        reqCount++;
        var method = match[1];
        var url = match[2];
        var status = match[3];
        var extra = match[4] || '';
        var statusColor = '#4CAF50';
        if (status.startsWith('4') || status.startsWith('5')) statusColor = '#f44336';
        else if (status === 'FAILED') statusColor = '#f44336';
        else if (status.startsWith('3')) statusColor = '#ff9800';
        // Truncate long URLs
        var displayUrl = url.length > 80 ? url.substring(0, 77) + '...' : url;
        html += '<div style="padding:2px 4px;font-size:11px;font-family:monospace;border-bottom:1px solid #333;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + escapeHtmlDash(url) + '">'
          + '<span style="color:#4fc3f7;width:40px;display:inline-block;">' + escapeHtmlDash(method) + '</span> '
          + '<span style="color:' + statusColor + ';width:50px;display:inline-block;">[' + escapeHtmlDash(status) + ']</span> '
          + '<span style="color:#aaa;">' + escapeHtmlDash(displayUrl) + '</span>'
          + (extra ? ' <span style="color:#666;">' + escapeHtmlDash(extra) + '</span>' : '')
          + '</div>';
      }
    }
    if (!html) html = '<div style="padding:8px;color:#888;font-size:11px;">No network requests</div>';
    out.setContents(html);
    if (label) label.setContents('<span style="font-size:11px;color:#aaa;">' + reqCount + ' requests</span>');
  }).catch(function () {
    var out = resolveRef('networkOutput');
    if (out) out.setContents('<div style="padding:8px;color:#f44336;font-size:11px;">Failed to load network</div>');
  });
}

function wireScriptHistoryToggle() {
  var btnLive = resolveRef('btnHistoryLive');
  var btnArchive = resolveRef('btnHistoryArchive');

  function updateToggleStyle() {
    if (btnLive) {
      btnLive.setTitle(_dashState.scriptHistoryMode === 'live' ? '<b>Live</b>' : 'Live');
    }
    if (btnArchive) {
      btnArchive.setTitle(_dashState.scriptHistoryMode === 'archive' ? '<b>Archive</b>' : 'Archive');
    }
  }

  if (btnLive) {
    btnLive.click = function () {
      if (_dashState.scriptHistoryMode === 'live') return;
      _dashState.scriptHistoryMode = 'live';
      updateToggleStyle();
      switchToLiveMode();
    };
  }

  if (btnArchive) {
    btnArchive.click = function () {
      if (_dashState.scriptHistoryMode === 'archive') return;
      _dashState.scriptHistoryMode = 'archive';
      updateToggleStyle();
      switchToArchiveMode();
    };
  }

  updateToggleStyle();
}

function switchToLiveMode() {
  var grid = resolveRef('scriptsGrid');
  if (!grid) return;
  // Re-bind to BridgeScripts DataSource
  var ds = isc.DataSource.get('BridgeScripts');
  if (ds) grid.setDataSource(ds);
  grid.setFields([
    { name: 'name',       width: '*' },
    { name: 'state',      width: 80, _formatter: 'stateDot' },
    { name: 'step',       width: 35 },
    { name: 'totalSteps', width: 35, title: '/' },
    { name: 'startedAt',  width: 70, title: 'Started' },
  ]);
  grid.fetchData();
  grid.formatCellValue = function (value, record, rowNum, colNum) {
    var fieldName = this.getFieldName(colNum);
    if (fieldName === 'startedAt' && typeof value === 'number') {
      return new Date(value).toLocaleTimeString();
    }
    return value;
  };
}

function switchToArchiveMode() {
  var grid = resolveRef('scriptsGrid');
  if (!grid) return;
  // Unbind DataSource, switch to manual data
  grid.setDataSource(null);
  grid.setFields([
    { name: 'name',          title: 'Script',    width: '*' },
    { name: 'state',         title: 'State',     width: 70 },
    { name: 'startedAt',     title: 'Started',   width: 90 },
    { name: 'durationMs',    title: 'Duration',  width: 60 },
    { name: 'artifactCount', title: 'Artifacts', width: 55 },
  ]);
  loadArchiveRuns();
}

function loadArchiveRuns() {
  dispatchActionAsync('SCRIPT_RUN_LIST', {}).then(function (resp) {
    var grid = resolveRef('scriptsGrid');
    if (!grid || _dashState.scriptHistoryMode !== 'archive') return;
    var runs = (resp && resp.success && resp.runs) ? resp.runs : [];
    grid.setData(runs);

    // Apply formatters
    grid.formatCellValue = function (value, record, rowNum, colNum) {
      var fieldName = this.getFieldName(colNum);
      if (fieldName === 'startedAt' && typeof value === 'number') {
        return new Date(value).toLocaleString();
      }
      if (fieldName === 'durationMs' && typeof value === 'number') {
        return formatDuration(value);
      }
      return value == null ? '' : value;
    };
  });
}

function handleArchiveRunSelect(record) {
  if (!record) return;
  var scriptId = record.scriptId || record.id;

  // Show run summary in debug viewer
  var dv = resolveRef('debugViewer');
  if (dv) dv.setData([record]);

  // Show assertions if available
  updateAssertionsGrid(record.assertions);

  // Load artifacts for this run
  dispatchActionAsync('SCRIPT_RUN_GET', { scriptId: scriptId }).then(function (resp) {
    var artifacts = (resp && resp.success && resp.artifacts) ? resp.artifacts : [];
    _dashState.selectedRunArtifacts = artifacts;
    var artifactsGrid = resolveRef('artifactsGrid');
    if (artifactsGrid) {
      artifactsGrid.setData(artifacts);
      // Wire event handlers every time data is loaded (grid may have been
      // recreated by SmartClient when the tab was shown for the first time)
      ensureArtifactGridEvents(artifactsGrid);
    }

    // Switch to Artifacts tab if there are artifacts (and no assertions already showing)
    if (artifacts.length > 0 && !record.assertions) {
      var tabs = resolveRef('scriptDetailTabs');
      if (tabs) tabs.selectTab(2); // Artifacts is tab index 2 (after State, Assertions)
    }
  });
}
