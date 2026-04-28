// dashboard/artifacts.js
// Artifacts grid, preview, code/TSV viewers, assertions.
// Functions: wireArtifactsGrid, ensureArtifactGridEvents, loadArtifactPreview, renderArtifactPreview, openArtifactViewer, openCodeViewer, openTsvGridViewer, updateAssertionsGrid, handleArtifactBroadcast

function wireArtifactsGrid() {
  // Initial wiring attempt — may fail if grid is in a hidden tab.
  // ensureArtifactGridEvents() is also called every time data is loaded.
  var grid = resolveRef('artifactsGrid');
  if (grid) ensureArtifactGridEvents(grid);
}

function ensureArtifactGridEvents(grid) {
  if (!grid || grid._artifactEventsWired) return;
  grid._artifactEventsWired = true;

  grid.recordClick = function (viewer, record) {
    if (!record) return;
    loadArtifactPreview(record);
  };

  grid.recordDoubleClick = function (viewer, record) {
    if (!record) return;
    openArtifactViewer(record);
  };

  // Right-click context menu
  grid.cellContextClick = function (record) {
    if (!record) return false;
    var ct = record.contentType || '';
    var label = record.label || '';
    var isTsv = ct === 'text/tab-separated-values' || label.toLowerCase().includes('tsv') || label.toLowerCase().includes('output');
    var isViewable = record.type === 'text' || ct.startsWith('text/') || ct === 'application/javascript' || label.includes('Model');

    var menuItems = [
      { title: 'Preview', click: function () { loadArtifactPreview(record); } },
    ];
    if (isViewable && !isTsv) {
      menuItems.push({ title: 'Open in Code Viewer', click: function () { openArtifactViewer(record); } });
    }
    if (isTsv) {
      menuItems.push({ title: 'Open in Data Grid', click: function () { openArtifactViewer(record); } });
    }
    if (record.diskPath) {
      menuItems.push({ isSeparator: true });
      menuItems.push({ title: 'Path: ' + (record.diskPath || '').split('/').pop(), enabled: false });
    }

    isc.Menu.create({ data: menuItems }).showContextMenu();
    return false;
  };

  // Formatters
  grid.formatCellValue = function (value, record, rowNum, colNum) {
    var fieldName = this.getFieldName(colNum);
    if (fieldName === 'timestamp' && typeof value === 'number') {
      return new Date(value).toLocaleTimeString();
    }
    if (fieldName === 'size' && typeof value === 'number') {
      if (value < 1024) return value + 'B';
      return Math.round(value / 1024) + 'KB';
    }
    return value == null ? '' : value;
  };
}

function loadArtifactPreview(artifact) {
  var preview = resolveRef('artifactPreview');
  if (!preview) return;

  // If we already have inline data, show it immediately
  if (artifact.data) {
    renderArtifactPreview(preview, artifact, artifact.data);
    return;
  }

  // Need to lazy-load from disk or IndexedDB
  preview.setContents('<div style="padding:8px;color:#888;font-size:11px;">Loading...</div>');

  var payload = {};
  if (artifact.diskPath) {
    payload.diskPath = artifact.diskPath;
  } else if (artifact.id != null) {
    payload.id = artifact.id;
  } else {
    preview.setContents('<div style="padding:8px;color:#f44336;font-size:11px;">No data source for artifact</div>');
    return;
  }

  dispatchActionAsync('SCRIPT_ARTIFACT_GET', payload).then(function (resp) {
    if (resp && resp.success && resp.data) {
      renderArtifactPreview(preview, artifact, resp.data);
    } else {
      var err = (resp && resp.error) || 'Failed to load';
      preview.setContents('<div style="padding:8px;color:#f44336;font-size:11px;">' + escapeHtmlDash(err) + '</div>');
    }
  });
}

function renderArtifactPreview(preview, artifact, data) {
  var type = artifact.type || '';
  var label = artifact.label || '';

  switch (type) {
    case 'screenshot':
      var src = data.startsWith('data:') ? data : 'data:image/png;base64,' + data;
      preview.setContents(
        '<div style="padding:4px;text-align:center;">'
        + '<img src="' + src + '" style="max-width:100%;cursor:pointer;border:1px solid #333;" '
        + 'onclick="window._openScreenshotViewer && window._openScreenshotViewer(this.src, \'' + escapeHtmlDash(label) + '\')" />'
        + '</div>'
      );
      break;
    case 'snapshot':
      preview.setContents('<pre style="padding:4px;font-size:11px;font-family:monospace;white-space:pre-wrap;color:#ccc;margin:0;max-height:300px;overflow:auto;">' + escapeHtmlDash(data) + '</pre>');
      break;
    case 'console':
      preview.setContents('<pre style="padding:4px;font-size:11px;font-family:monospace;white-space:pre-wrap;color:#aaa;margin:0;max-height:300px;overflow:auto;">' + escapeHtmlDash(data) + '</pre>');
      break;
    case 'debug':
    case 'result':
      var formatted = data;
      try {
        if (typeof data === 'string') formatted = JSON.stringify(JSON.parse(data), null, 2);
      } catch (e) { /* not valid JSON, show as-is */ }
      preview.setContents('<pre style="padding:4px;font-size:11px;font-family:monospace;white-space:pre-wrap;color:#4CAF50;margin:0;max-height:300px;overflow:auto;">' + escapeHtmlDash(formatted) + '</pre>');
      break;
    case 'trace':
      // Trace — launch show-trace local server via bridge, open in new tab
      // Store the path in a global map to avoid JavaScript string escaping of backslashes
      // (Windows paths like C:\Users\bigal\.agentidev\... contain \U, \b which are JS escape sequences)
      if (!window._tracePathMap) window._tracePathMap = {};
      var traceKey = 'trace_' + Date.now();
      window._tracePathMap[traceKey] = artifact.diskPath || '';
      preview.setContents(
        '<div style="padding:12px;font-size:12px;color:#ccc;">'
        + '<b>Playwright Trace</b> (' + (artifact.size ? Math.round(artifact.size / 1024) + ' KB' : '') + ')<br><br>'
        + '<button onclick="window._openTraceViewer && window._openTraceViewer(window._tracePathMap[\'' + traceKey + '\'])" '
        + 'style="padding:6px 16px;background:#1976d2;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:13px;">Open Trace Viewer</button><br><br>'
        + '<span style="color:#666;font-size:11px;">File: ' + escapeHtmlDash(artifact.diskPath || '') + '</span>'
        + '</div>'
      );
      break;
    case 'text':
      // Text artifacts: PICT models, TSV outputs, generated scripts, etc.
      var textColor = '#ccc';
      if (artifact.contentType === 'application/javascript') textColor = '#a8b4ff';
      else if (artifact.contentType === 'text/tab-separated-values') textColor = '#7ee787';
      preview.setContents(
        '<pre style="padding:6px;font-size:11px;font-family:monospace;white-space:pre-wrap;word-break:break-word;'
        + 'color:' + textColor + ';margin:0;max-height:300px;overflow:auto;">'
        + escapeHtmlDash(data) + '</pre>'
      );
      break;
    case 'video':
      // Video — serve via asset server and embed <video> player
      if (artifact.diskPath) {
        preview.setContents('<div style="padding:8px;color:#888;font-size:11px;">Loading video...</div>');
        dispatchActionAsync('SERVE_ARTIFACT', { path: artifact.diskPath }, 10000).then(function (resp) {
          if (resp && resp.success && resp.url) {
            preview.setContents(
              '<div style="padding:8px;text-align:center;">'
              + '<video src="' + resp.url + '" controls style="max-width:100%;max-height:280px;border:1px solid #333;"></video>'
              + '</div>'
            );
          } else {
            preview.setContents('<div style="padding:12px;color:#888;">Video file: ' + escapeHtmlDash(artifact.diskPath || '') + '</div>');
          }
        }).catch(function () {
          preview.setContents('<div style="padding:12px;color:#888;">Video file: ' + escapeHtmlDash(artifact.diskPath || '') + '</div>');
        });
      } else {
        preview.setContents('<div style="padding:12px;color:#888;">No video file path</div>');
      }
      break;
    default:
      // For unknown types, try to display as text if it looks like text
      if (typeof data === 'string' && data.length < 50000 && !data.startsWith('data:')) {
        preview.setContents('<pre style="padding:4px;font-size:11px;font-family:monospace;white-space:pre-wrap;color:#888;margin:0;">' + escapeHtmlDash(data) + '</pre>');
      } else {
        preview.setContents('<div style="padding:8px;color:#888;font-size:11px;">Binary artifact (' + (artifact.size ? Math.round(artifact.size / 1024) + ' KB' : 'unknown size') + ')</div>');
      }
  }
}

function openArtifactViewer(artifact) {
  var ct = artifact.contentType || '';
  var label = artifact.label || '';
  var isTsv = ct === 'text/tab-separated-values' || label.toLowerCase().includes('tsv') || label.toLowerCase().includes('output');
  var isCode = ct === 'application/javascript' || ct === 'text/plain' || label.includes('.pict') || label.includes('Model');

  // Fetch data first, then open the appropriate viewer
  function getData(callback) {
    if (artifact.data) { callback(artifact.data); return; }
    if (!artifact.diskPath) { callback(null); return; }
    dispatchActionAsync('SCRIPT_ARTIFACT_GET', { diskPath: artifact.diskPath }, 15000).then(function (resp) {
      callback(resp && resp.success ? resp.data : null);
    }).catch(function () { callback(null); });
  }

  getData(function (data) {
    if (!data) return;
    if (isTsv) {
      openTsvGridViewer(label, data);
    } else if (isCode) {
      openCodeViewer(label, data, ct);
    }
  });
}

function openCodeViewer(title, content, contentType) {
  // Determine language for coloring
  var isJS = contentType === 'application/javascript' || title.includes('Script') || title.includes('.mjs');
  var isPict = title.includes('PICT') || title.includes('.pict') || title.includes('Model');

  // Basic syntax highlighting via regex
  var highlighted = escapeHtmlDash(content);
  if (isJS) {
    // Highlight JS keywords, strings, comments
    highlighted = highlighted
      .replace(/(\/\/.*)/g, '<span style="color:#6a9955">$1</span>')
      .replace(/\b(import|from|export|const|let|var|function|async|await|return|if|else|for|try|catch|throw|new)\b/g, '<span style="color:#569cd6">$1</span>')
      .replace(/&#x27;([^&#]*?)&#x27;/g, '<span style="color:#ce9178">&#x27;$1&#x27;</span>');
  } else if (isPict) {
    // Highlight PICT: comments, negatives, constraints
    highlighted = highlighted
      .replace(/(#.*)/g, '<span style="color:#6a9955">$1</span>')
      .replace(/(~\w+)/g, '<span style="color:#f44747">$1</span>')
      .replace(/\b(IF|THEN|ELSE|AND|OR|NOT|IN|LIKE)\b/g, '<span style="color:#569cd6">$1</span>');
  }

  var win = isc.Window.create({
    title: title,
    width: 700,
    height: 500,
    canDragResize: true,
    autoCenter: true,
    isModal: false,
    showMinimizeButton: true,
    items: [
      isc.HTMLFlow.create({
        width: '100%',
        height: '100%',
        overflow: 'auto',
        contents: '<pre style="padding:10px;margin:0;font-size:12px;line-height:1.5;'
          + 'font-family:Consolas,Monaco,monospace;background:#1e1e1e;color:#d4d4d4;'
          + 'white-space:pre-wrap;word-break:break-word;min-height:100%;">'
          + highlighted + '</pre>',
      }),
    ],
  });
  win.show();
}

function openTsvGridViewer(title, tsvContent) {
  var lines = tsvContent.trim().split('\n');
  if (lines.length < 2) return;

  var headers = lines[0].split('\t');
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var values = lines[i].split('\t');
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }
    rows.push(row);
  }

  var fields = headers.map(function (h) {
    return { name: h, title: h, width: h.length < 8 ? 80 : '*' };
  });

  var win = isc.Window.create({
    title: title + ' (' + rows.length + ' rows)',
    width: 800,
    height: 450,
    canDragResize: true,
    autoCenter: true,
    isModal: false,
    showMinimizeButton: true,
    items: [
      isc.ListGrid.create({
        width: '100%',
        height: '100%',
        canEdit: false,
        alternateRecordStyles: true,
        data: rows,
        fields: fields,
        showFilterEditor: true,
        autoFitFieldWidths: true,
        autoFitWidthApproach: 'both',
      }),
    ],
  });
  win.show();
}

function updateAssertionsGrid(assertions) {
  var grid = resolveRef('assertionsGrid');
  var label = resolveRef('assertionSummaryLabel');
  if (!grid) return;
  if (!assertions) {
    grid.setData([]);
    if (label) label.setContents('');
    return;
  }
  var results = assertions.results || [];
  grid.setData(results);
  if (label) {
    var total = (assertions.pass || 0) + (assertions.fail || 0);
    var color = assertions.fail > 0 ? '#c33' : '#393';
    label.setContents('<b style="color:' + color + '">' + assertions.pass + '/' + total + ' passed</b>'
      + (assertions.fail > 0 ? ' &mdash; <span style="color:#c33">' + assertions.fail + ' failed</span>' : ''));
  }
  // Auto-switch to Assertions tab if assertions exist
  if (results.length > 0) {
    var tabs = resolveRef('scriptDetailTabs');
    if (tabs) tabs.selectTab(1); // Assertions is tab index 1
  }
}

function handleArtifactBroadcast(payload) {
  if (!payload || !payload.artifact) return;
  var scriptId = payload.scriptId;
  var artifact = payload.artifact;

  // If viewing this script in live mode, append to artifacts grid
  if (_dashState.selectedScriptId && _dashState.selectedScriptId === scriptId) {
    var grid = resolveRef('artifactsGrid');
    if (grid) {
      var data = grid.getData();
      if (Array.isArray(data)) {
        data.push(artifact);
        grid.setData(data);
        // Auto-scroll to latest
        grid.scrollToRow(data.length - 1);
      }
    }
  }
}

// Global hook for screenshot viewer (called from inline onclick in HTMLFlow)
window._openScreenshotViewer = function (src, label) {
  isc.Window.create({
    title: label || 'Screenshot',
    width: Math.min(window.innerWidth - 100, 900),
    height: Math.min(window.innerHeight - 100, 700),
    autoCenter: true,
    canDragResize: true,
    closeClick: function () { this.destroy(); },
    items: [
      isc.Canvas.create({
        width: '100%',
        height: '100%',
        overflow: 'auto',
        contents: '<img src="' + src + '" style="max-width:100%;" />',
      }),
    ],
  }).show();
};

// Global hook for trace viewer (called from inline onclick in HTMLFlow)
window._openTraceViewer = function (diskPath) {
  if (!diskPath) return;
  // Ask bridge to launch show-trace with a local HTTP server
  dispatchActionAsync('TRACE_VIEW', { path: diskPath }, 15000).then(function (resp) {
    if (resp && resp.success && resp.url) {
      // Ask wrapper to open URL in a new browser tab (avoids CSP/sandbox restrictions)
      window.parent.postMessage({
        source: 'smartclient-open-tab',
        url: resp.url,
      }, '*');
    } else {
      isc.warn('Failed to launch trace viewer: ' + (resp && resp.error || 'unknown'));
    }
  }).catch(function (e) {
    isc.warn('Trace viewer error: ' + e.message);
  });
};

