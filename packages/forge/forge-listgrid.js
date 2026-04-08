/**
 * ForgeListGrid — Agentiface enhanced ListGrid
 *
 * Extends isc.ListGrid with:
 * - Token-aware default styling
 * - Skeleton loading animation (CSS shimmer on empty rows)
 * - Alternating row styles and rollover by default
 */

isc.defineClass("ForgeListGrid", "ListGrid").addProperties({
  alternateRecordStyles: true,
  showRollOver: true,
  selectionType: "single",
  wrapCells: false,
  cellHeight: 32,

  _skeletonActive: false,
  _skeletonData: null,
  _savedData: null,

  /**
   * Show a skeleton loading state with shimmer rows.
   * @param {number} [rowCount=5] Number of skeleton rows to display
   */
  showSkeleton: function (rowCount) {
    if (this._skeletonActive) return;
    rowCount = rowCount || 5;

    this._skeletonActive = true;
    this._savedData = this.data;

    // Build placeholder records
    var rows = [];
    var fields = this.getFields() || [];
    for (var i = 0; i < rowCount; i++) {
      var row = {};
      for (var j = 0; j < fields.length; j++) {
        row[fields[j].name] = '';
      }
      row._skeleton = true;
      rows.push(row);
    }
    this._skeletonData = rows;

    // Inject skeleton CSS if not already present
    if (!document.getElementById('af-skeleton-style')) {
      var style = document.createElement('style');
      style.id = 'af-skeleton-style';
      style.textContent =
        '@keyframes af-shimmer { 0% { background-position: -200px 0; } 100% { background-position: 200px 0; } }\n' +
        '.af-skeleton-cell { background: linear-gradient(90deg, var(--af-surface-secondary) 25%, var(--af-surface-primary) 50%, var(--af-surface-secondary) 75%); ' +
        'background-size: 400px 100%; animation: af-shimmer 1.5s ease-in-out infinite; border-radius: 3px; height: 14px; margin: 4px 8px; }';
      document.head.appendChild(style);
    }

    // Override formatCellValue to show shimmer bars
    this._savedFormatCell = this.formatCellValue;
    var self = this;
    this.formatCellValue = function (value, record) {
      if (record && record._skeleton) {
        return '<div class="af-skeleton-cell"></div>';
      }
      if (self._savedFormatCell) {
        return self._savedFormatCell.apply(self, arguments);
      }
      return value;
    };

    this.setData(rows);
  },

  /**
   * Remove skeleton state and restore original data.
   */
  hideSkeleton: function () {
    if (!this._skeletonActive) return;
    this._skeletonActive = false;

    if (this._savedFormatCell) {
      this.formatCellValue = this._savedFormatCell;
    } else {
      delete this.formatCellValue;
    }

    if (this._savedData) {
      this.setData(this._savedData);
      this._savedData = null;
    }
    this._skeletonData = null;
  },
});
