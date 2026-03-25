/**
 * ForgeFilterBar — Agentiface combined search + filter component
 *
 * Combines a search-as-you-type text input with SmartClient's FilterBuilder
 * for advanced filtering. Targets a ListGrid or TreeGrid.
 *
 * Usage:
 *   isc.ForgeFilterBar.create({
 *     targetGrid: myGrid,
 *     searchFields: ['name', 'description'],
 *     showAdvanced: true,
 *   });
 */

isc.defineClass("ForgeFilterBar", "VLayout").addProperties({
  width: "100%",
  height: 1, // auto-size
  overflow: "visible",
  membersMargin: 4,

  /** Target ListGrid/TreeGrid to filter */
  targetGrid: null,

  /** Fields to search across (for the simple text search) */
  searchFields: null,

  /** Debounce delay for search-as-you-type (ms) */
  searchDelay: 300,

  /** Show the advanced FilterBuilder toggle */
  showAdvanced: true,

  /** Placeholder text for the search input */
  placeholder: "Search...",

  // Internal
  _searchForm: null,
  _filterBuilder: null,
  _advancedVisible: false,
  _debounceTimer: null,

  initWidget: function () {
    this.Super("initWidget", arguments);

    var self = this;

    // Simple search bar
    this._searchForm = isc.DynamicForm.create({
      width: "100%",
      numCols: 3,
      colWidths: ["*", 80, 80],
      items: [
        {
          name: "_searchText",
          type: "text",
          showTitle: false,
          hint: this.placeholder,
          showHintInField: true,
          width: "*",
          changed: function (form, item, value) {
            self._onSearchChanged(value);
          },
          keyPress: function (item, form, keyName) {
            if (keyName === "Enter") {
              self._applySearch();
              return false;
            }
            return true;
          },
        },
        {
          name: "_clearBtn",
          type: "button",
          title: "Clear",
          startRow: false,
          click: function () {
            self._clearSearch();
          },
        },
        {
          name: "_advancedBtn",
          type: "button",
          title: "Advanced",
          startRow: false,
          visible: this.showAdvanced,
          click: function () {
            self._toggleAdvanced();
          },
        },
      ],
    });
    this.addMember(this._searchForm);

    // Advanced FilterBuilder (hidden by default)
    if (this.showAdvanced && this.targetGrid) {
      var ds = this.targetGrid.getDataSource
        ? this.targetGrid.getDataSource()
        : null;

      if (ds) {
        this._filterBuilder = isc.FilterBuilder.create({
          dataSource: ds,
          visibility: "hidden",
          width: "100%",
        });

        this._applyBtn = isc.Button.create({
          title: "Apply Filter",
          visibility: "hidden",
          click: function () {
            self._applyAdvancedFilter();
          },
        });

        this._advancedLayout = isc.VLayout.create({
          width: "100%",
          membersMargin: 8,
          visibility: "hidden",
          members: [this._filterBuilder, this._applyBtn],
        });

        this.addMember(this._advancedLayout);
      }
    }
  },

  _onSearchChanged: function (value) {
    var self = this;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(function () {
      self._applySearch();
    }, this.searchDelay);
  },

  _applySearch: function () {
    var grid = this.targetGrid;
    if (!grid) return;

    var text = this._searchForm.getValue("_searchText");
    if (!text || text.trim() === "") {
      // Clear filter
      if (grid.filterData) {
        grid.filterData({});
      } else if (grid.invalidateCache) {
        grid.invalidateCache();
      }
      return;
    }

    text = text.trim();

    // Build OR criteria across searchFields
    var fields = this.searchFields;
    if (!fields || fields.length === 0) {
      // Auto-detect: use all text fields from grid
      fields = [];
      var gridFields = grid.getFields ? grid.getFields() : [];
      for (var i = 0; i < gridFields.length; i++) {
        var f = gridFields[i];
        if (!f.type || f.type === "text" || f.type === "string") {
          fields.push(f.name);
        }
      }
    }

    if (fields.length === 0) return;

    if (fields.length === 1) {
      var criteria = {};
      criteria[fields[0]] = text;
      grid.filterData(criteria);
    } else {
      // AdvancedCriteria OR
      var subcriteria = [];
      for (var j = 0; j < fields.length; j++) {
        subcriteria.push({
          fieldName: fields[j],
          operator: "iContains",
          value: text,
        });
      }
      grid.filterData({
        _constructor: "AdvancedCriteria",
        operator: "or",
        criteria: subcriteria,
      });
    }
  },

  _clearSearch: function () {
    this._searchForm.setValue("_searchText", "");
    if (this._debounceTimer) clearTimeout(this._debounceTimer);

    var grid = this.targetGrid;
    if (grid) {
      if (grid.filterData) {
        grid.filterData({});
      } else if (grid.invalidateCache) {
        grid.invalidateCache();
      }
    }

    // Also clear advanced filter
    if (this._filterBuilder) {
      this._filterBuilder.clearCriteria();
    }
  },

  _toggleAdvanced: function () {
    this._advancedVisible = !this._advancedVisible;
    if (this._advancedLayout) {
      if (this._advancedVisible) {
        this._advancedLayout.show();
      } else {
        this._advancedLayout.hide();
      }
    }
  },

  _applyAdvancedFilter: function () {
    var grid = this.targetGrid;
    if (!grid || !this._filterBuilder) return;

    var criteria = this._filterBuilder.getCriteria();
    if (criteria) {
      grid.filterData(criteria);
    }
  },

  /** Get current search text */
  getSearchText: function () {
    return this._searchForm ? this._searchForm.getValue("_searchText") : "";
  },

  /** Set search text programmatically and apply */
  setSearchText: function (text) {
    if (this._searchForm) {
      this._searchForm.setValue("_searchText", text);
      this._applySearch();
    }
  },
});
