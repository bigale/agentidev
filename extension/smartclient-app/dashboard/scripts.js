// dashboard/scripts.js
// Scripts library, editor loading, file save, recipe binding.
// Functions: loadScriptIntoEditor, showOpenScriptDialog, wireScriptsLibraryGrid, refreshScriptsLibrary, selectScriptInHistoryGrid, selectScriptInLibrary, loadVersionHistory, refreshRecipeSelect, loadRecipeForScript, assignRecipeToScript, fileSave, fileSaveAs

function loadScriptIntoEditor(name) {
  if (!name) return;
  _loadedScriptName = name;

  dispatchActionAsync('SCRIPT_LIBRARY_GET', { name: name }).then(function (response) {
    if (!response || !response.success || !response.script) {
      console.warn('[Dashboard] Failed to load script:', name);
      return;
    }

    var source = response.script.source || '';
    _dashState.currentSource = source;

    // Update the read-only source viewer in the portlet
    updateSourceViewer(source);

    // If Monaco Window is open, update it too
    if (_monacoEditor) {
      _monacoEditor.setValue(source);
    }

    // Load recipe — prefer DataSource recipe by recipeId, fall back to embedded
    var scriptRecipeId = toRecipeId(response.script.recipeId);
    if (scriptRecipeId) {
      _dashState.recipeId = scriptRecipeId;
      dispatchActionAsync('DS_FETCH', { dataSource: 'Recipes', criteria: { id: scriptRecipeId } }).then(function (r) {
        var data = (r && r.status === 0 && Array.isArray(r.data)) ? r.data : [];
        if (data.length > 0) {
          _dashState.recipe = {
            preActions: data[0].preActions || [],
            postActions: data[0].postActions || [],
          };
        }
        renderRecipeGrids();
      });
    } else {
      _dashState.recipeId = null;
      var recipe = response.script.recipe;
      if (recipe && (recipe.preActions || recipe.postActions)) {
        _dashState.recipe = {
          preActions: recipe.preActions || [],
          postActions: recipe.postActions || [],
        };
      } else {
        _dashState.recipe = { preActions: [], postActions: [] };
      }
      renderRecipeGrids();
    }

    // Detect checkpoint lines
    _checkpointLines = findCheckpointLines(source);

    // Merge server breakpoints if script is active
    var script = _dashState.selectedScript;
    if (script && script.activeBreakpoints) {
      var serverBp = script.activeBreakpoints;
      for (var i = 0; i < serverBp.length; i++) {
        if (_editorBreakpoints.indexOf(serverBp[i]) < 0) {
          _editorBreakpoints.push(serverBp[i]);
        }
      }
    }

    // Update current checkpoint if paused
    _currentCheckpoint = (script && script.checkpoint) ? script.checkpoint.name : null;

    updateEditorDecorations();
  });
}

function showOpenScriptDialog() {
  // Use local refs instead of global IDs to avoid collisions on re-open
  var pathForm = isc.DynamicForm.create({
    width: '100%',
    numCols: 3,
    colWidths: [90, '*', 70],
    fields: [
      {
        name: 'path',
        title: 'Script path',
        editorType: 'TextItem',
        width: '*',
        colSpan: 1,
        hint: '/home/user/scripts/my-script.mjs',
        showHintInField: true,
      },
      {
        name: '_browse',
        editorType: 'ButtonItem',
        title: 'Browse',
        width: 65,
        startRow: false,
        click: function () {
          var browseBtn = this;
          browseBtn.setDisabled && browseBtn.setDisabled(true);
          statusLabel.setContents('<span style="color:#888;">Opening file dialog... (if you do not see it, check behind the browser window)</span>');
          dispatchActionAsync('FILE_PICKER', {
            title: 'Open Script',
            filter: 'JavaScript files (*.mjs;*.js)|*.mjs;*.js|All files (*.*)|*.*',
          }).then(function (result) {
            if (dlg.destroyed) return;
            browseBtn.setDisabled && browseBtn.setDisabled(false);
            if (result && result.success && result.path) {
              pathForm.setValue('path', result.path);
              statusLabel.setContents('');
            } else if (result && result.cancelled) {
              statusLabel.setContents('');
            } else {
              statusLabel.setContents('<span style="color:#FF9800;">File browser not available — type path manually</span>');
            }
          }).catch(function (err) {
            if (dlg.destroyed) return;
            browseBtn.setDisabled && browseBtn.setDisabled(false);
            statusLabel.setContents('<span style="color:#FF9800;">File browser failed: ' + escapeHtmlDash(err && err.message || String(err)) + ' — type path manually</span>');
          });
        },
      },
    ],
  });

  var statusLabel = isc.Label.create({
    width: '100%',
    height: 20,
    contents: '',
  });

  var dlg = isc.Dialog.create({
    title: 'Open Script',
    width: 520,
    height: 200,
    isModal: true,
    showModalMask: true,
    autoCenter: true,
    closeClick: function () { this.destroy(); },
    items: [pathForm, statusLabel],
    buttons: [
      isc.Button.create({
        title: 'Import',
        click: function () {
          var path = (pathForm.getValue('path') || '').trim();
          if (!path) {
            statusLabel.setContents('<span style="color:#f44336;">Please enter a file path</span>');
            return;
          }
          statusLabel.setContents('<span style="color:#888;">Importing...</span>');
          console.log('[Dashboard] SCRIPT_IMPORT:', path);

          dispatchActionAsync('SCRIPT_IMPORT', { path: path }).then(function (response) {
            console.log('[Dashboard] SCRIPT_IMPORT response:', JSON.stringify(response));
            if (response && response.success) {
              dlg.destroy();
              var grid = resolveRef('scriptsGrid');
              if (grid && grid.invalidateCache) grid.invalidateCache();
              refreshScriptsLibrary();
              var scriptName = (response.script && response.script.name) || response.name;
              if (scriptName) {
                // Select the imported script so Run/Debug buttons enable
                _dashState.selectedScriptId = scriptName;
                _dashState.selectedScript = { id: scriptName, name: scriptName };
                _dashState.selectedLibScript = scriptName;
                loadScriptIntoEditor(scriptName);
                loadVersionHistory(scriptName);
                refreshToolbar();
              }
            } else {
              var err = (response && response.error) || 'Import failed';
              statusLabel.setContents('<span style="color:#f44336;">' + escapeHtmlDash(err) + '</span>');
            }
          }).catch(function (e) {
            console.error('[Dashboard] SCRIPT_IMPORT error:', e);
            statusLabel.setContents('<span style="color:#f44336;">Import error: ' + escapeHtmlDash(e.message || String(e)) + '</span>');
          });
        },
      }),
      isc.Button.create({
        title: 'Cancel',
        click: function () { dlg.destroy(); },
      }),
    ],
  });
  dlg.show();
}

function wireScriptsLibraryGrid() {
  var grid = resolveRef('scriptsLibraryGrid');
  if (!grid) return;

  grid.formatCellValue = function (value, record, rowNum, colNum) {
    var fieldName = this.getFieldName(colNum);
    if (fieldName === 'modifiedAt' && typeof value === 'number') {
      return new Date(value).toLocaleString();
    }
    return value == null ? '' : value;
  };

  grid.recordClick = function (viewer, record) {
    if (!record || !record.name) return;
    _dashState.selectedLibScript = record.name;
    _dashState.recipeId = toRecipeId(record.recipeId);
    // Select script so Run/Debug toolbar buttons become active
    _dashState.selectedScriptId = record.name;
    _dashState.selectedScript = { id: record.name, name: record.name };

    // Load into editor
    loadScriptIntoEditor(record.name);

    // Also select in scriptsGrid if running
    selectScriptInHistoryGrid(record.name);

    // Load version history
    loadVersionHistory(record.name);

    // Update recipe picker
    loadRecipeForScript(record);

    refreshToolbar();
  };

  // Initial load
  refreshScriptsLibrary();
}

function refreshScriptsLibrary() {
  dispatchActionAsync('SCRIPT_LIBRARY_LIST', {}).then(function (resp) {
    var grid = resolveRef('scriptsLibraryGrid');
    if (grid && resp && resp.success) {
      grid.setData(resp.scripts || []);
    }
  });
}

function selectScriptInHistoryGrid(name) {
  var grid = resolveRef('scriptsGrid');
  if (!grid) return;
  var data = grid.getData();
  if (!data || !data.length) return;
  for (var i = 0; i < data.length; i++) {
    if (data[i] && data[i].name === name) {
      grid.selectSingleRecord(data[i]);
      _dashState.selectedScriptId = data[i].id;
      _dashState.selectedScript = data[i];

      var dv = resolveRef('debugViewer');
      if (dv) dv.setData([data[i]]);
      return;
    }
  }
}

function selectScriptInLibrary(name) {
  var grid = resolveRef('scriptsLibraryGrid');
  if (!grid) return;
  var data = grid.getData();
  if (!data || !data.length) return;
  for (var i = 0; i < data.length; i++) {
    if (data[i] && data[i].name === name) {
      grid.selectSingleRecord(data[i]);
      // Trigger normal script selection behavior
      _dashState.selectedLibScript = name;
      _dashState.selectedScriptId = name;
      _dashState.selectedScript = { id: name, name: name };
      loadRecipeForScript(data[i]);
      loadVersionHistory(name);
      refreshToolbar();
      return;
    }
  }
}

function loadVersionHistory(scriptName) {
  dispatchActionAsync('SCRIPT_VERSION_LIST', { scriptName: scriptName }).then(function (resp) {
    var grid = resolveRef('scriptVersionsGrid');
    if (grid && resp && resp.success) {
      grid.setData(resp.versions || []);
    }
  });

  // Wire version grid formatCellValue + recordClick
  var vGrid = resolveRef('scriptVersionsGrid');
  if (vGrid && !vGrid._dashWired) {
    vGrid._dashWired = true;

    vGrid.formatCellValue = function (value, record, rowNum, colNum) {
      var fieldName = this.getFieldName(colNum);
      if (fieldName === 'modifiedAt' && typeof value === 'number') {
        return new Date(value).toLocaleString();
      }
      return value == null ? '' : value;
    };

    vGrid.recordClick = function (viewer, record) {
      if (!record || !record.modifiedAt) return;
      var scriptName = _dashState.selectedLibScript;
      if (!scriptName) return;
      dispatchActionAsync('SCRIPT_VERSION_GET', {
        scriptName: scriptName,
        modifiedAt: record.modifiedAt,
      }).then(function (resp) {
        if (resp && resp.success && resp.version && _monacoEditor) {
          _monacoEditor.setValue(resp.version.source || '');
        }
      });
    };
  }
}

function refreshRecipeSelect() {
  dispatchActionAsync('DS_FETCH', { dataSource: 'Recipes' }).then(function (resp) {
    var select = resolveRef('recipeSelect');
    if (!select) return;
    var valueMap = {};
    var data = (resp && resp.status === 0 && Array.isArray(resp.data)) ? resp.data : [];
    for (var i = 0; i < data.length; i++) {
      valueMap[data[i].id] = data[i].name;
    }
    select.setValueMap(valueMap);
  });
}

function loadRecipeForScript(record) {
  refreshRecipeSelect();
  var rid = toRecipeId(record.recipeId);
  var select = resolveRef('recipeSelect');
  if (select) {
    select.setValue(rid);
  }

  // If script has a recipeId, load its pre/post actions
  if (rid) {
    dispatchActionAsync('DS_FETCH', { dataSource: 'Recipes', criteria: { id: record.recipeId } }).then(function (resp) {
      var data = (resp && resp.status === 0 && Array.isArray(resp.data)) ? resp.data : [];
      if (data.length > 0) {
        _dashState.recipe = {
          preActions: data[0].preActions || [],
          postActions: data[0].postActions || [],
        };
        _dashState.recipeId = data[0].id;
        renderRecipeGrids();
      }
    });
  }
}

function assignRecipeToScript() {
  var scriptName = _dashState.selectedLibScript;
  if (!scriptName) {
    isc.say('No script selected — select a script first.');
    return;
  }
  var form = resolveRef('recipePickerForm');
  var recipeId = toRecipeId(form ? form.getValue('recipeId') : null);

  dispatchActionAsync('SCRIPT_LIBRARY_UPDATE', {
    name: scriptName,
    recipeId: recipeId,
  }).then(function (resp) {
    if (resp && resp.success) {
      _dashState.recipeId = recipeId;
      // If assigned, load recipe actions
      if (recipeId) {
        dispatchActionAsync('DS_FETCH', { dataSource: 'Recipes', criteria: { id: recipeId } }).then(function (r) {
          var data = (r && r.status === 0 && Array.isArray(r.data)) ? r.data : [];
          if (data.length > 0) {
            _dashState.recipe = {
              preActions: data[0].preActions || [],
              postActions: data[0].postActions || [],
            };
            renderRecipeGrids();
          }
        });
      } else {
        _dashState.recipe = { preActions: [], postActions: [] };
        renderRecipeGrids();
      }
      refreshScriptsLibrary();
    } else {
      isc.warn('Failed to assign recipe: ' + ((resp && resp.error) || 'unknown error'));
    }
  });
}

function fileSave() {
  var source = _monacoEditor ? _monacoEditor.getValue() : _dashState.currentSource;
  if (!_loadedScriptName || !source) {
    isc.say('No script loaded.');
    return;
  }
  dispatchActionAsync('SCRIPT_LIBRARY_SAVE', {
    name: _loadedScriptName,
    source: source,
    recipeId: toRecipeId(_dashState.recipeId),
  }).then(function (resp) {
    if (resp && resp.success) {
      refreshScriptsLibrary();
      loadVersionHistory(_loadedScriptName);
    } else {
      isc.warn('Save failed: ' + ((resp && resp.error) || 'unknown error'));
    }
  });
}

function fileSaveAs() {
  if (!_monacoEditor && !_dashState.currentSource) {
    isc.say('No script loaded.');
    return;
  }

  var nameForm = isc.DynamicForm.create({
    width: '100%',
    numCols: 2,
    colWidths: [80, '*'],
    fields: [
      {
        name: 'newName',
        title: 'Name',
        editorType: 'TextItem',
        width: '*',
        defaultValue: (_loadedScriptName || '') + '-copy',
        selectOnFocus: true,
      },
    ],
  });

  var statusLabel = isc.Label.create({
    width: '100%',
    height: 20,
    contents: '',
  });

  var okBtn = isc.Button.create({
    title: 'Save',
    click: function () {
      var newName = (nameForm.getValue('newName') || '').trim();
      if (!newName) {
        statusLabel.setContents('<span style="color:#f44336;">Please enter a name</span>');
        return;
      }

      okBtn.setDisabled(true);
      statusLabel.setContents('<span style="color:#888;">Saving...</span>');

      dispatchActionAsync('SCRIPT_LIBRARY_SAVE', {
        name: newName,
        source: _monacoEditor ? _monacoEditor.getValue() : (_dashState.currentSource || ''),
        recipeId: toRecipeId(_dashState.recipeId),
      }).then(function (resp) {
        if (resp && resp.success) {
          _loadedScriptName = newName;
          _dashState.selectedLibScript = newName;
          dlg.destroy();
          refreshScriptsLibrary();
          loadVersionHistory(newName);
        } else {
          okBtn.setDisabled(false);
          var err = (resp && resp.error) || 'Save failed';
          statusLabel.setContents('<span style="color:#f44336;">' + escapeHtmlDash(err) + '</span>');
        }
      });
    },
  });

  var dlg = isc.Dialog.create({
    title: 'Save As',
    width: 360,
    height: 150,
    isModal: true,
    showModalMask: true,
    autoCenter: true,
    closeClick: function () { this.destroy(); },
    items: [nameForm, statusLabel],
    buttons: [
      okBtn,
      isc.Button.create({
        title: 'Cancel',
        click: function () { dlg.destroy(); },
      }),
    ],
  });
  dlg.show();
  nameForm.focusInItem('newName');
}
