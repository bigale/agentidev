// dashboard/layout.js
// Portal layout persistence.
// Functions: saveLayout, debouncedSaveLayout, applyLayout

function saveLayout() {
  var portal = resolveRef('dashPortal');
  if (!portal) return;

  // Read current column widths
  var widths = [];
  try {
    for (var i = 0; i < 3; i++) {
      var col = portal.getColumn(i);
      if (col) widths.push(col.getWidth() + 'px');
    }
  } catch (e) {
    // PortalLayout API may vary — fall back to config defaults
    return;
  }

  if (widths.length === 3) {
    window.parent.postMessage({
      source: 'smartclient-save-layout',
      layout: { columnWidths: widths },
    }, '*');
  }
}

function debouncedSaveLayout() {
  if (_layoutSaveTimer) clearTimeout(_layoutSaveTimer);
  _layoutSaveTimer = setTimeout(saveLayout, 1000);
}

function applyLayout(layout) {
  if (!layout || !layout.columnWidths) return;
  var portal = resolveRef('dashPortal');
  if (!portal) return;

  try {
    // Apply saved column widths
    var widths = layout.columnWidths;
    for (var i = 0; i < widths.length && i < 3; i++) {
      var col = portal.getColumn(i);
      if (col) col.setWidth(widths[i]);
    }
  } catch (e) {
    console.warn('[Dashboard] Failed to apply saved layout:', e.message);
  }
}
