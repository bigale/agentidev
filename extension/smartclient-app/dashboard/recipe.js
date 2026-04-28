// dashboard/recipe.js
// Recipe (pre/post action) builder.
// Functions: actionSummary, renderRecipeGrids, renderRecipeGrid, wireRecipeGrid, showAddActionMenu, showActionDialog, commitAction, saveRecipe, generateRecipeName

function actionSummary(action) {
  var parts = [action.command];
  var def = window.CLI_COMMANDS[action.command];
  if (def && def.args) {
    for (var i = 0; i < def.args.length; i++) {
      var val = action.args && action.args[def.args[i].name];
      if (val != null && val !== '') parts.push(String(val));
    }
  }
  if (def && def.options) {
    for (var j = 0; j < def.options.length; j++) {
      var oval = action.options && action.options[def.options[j].name];
      if (oval != null && oval !== '' && oval !== false) {
        parts.push('--' + def.options[j].name + '=' + String(oval));
      }
    }
  }
  return parts.join(' ');
}

function renderRecipeGrids() {
  renderRecipeGrid('preActionsGrid', _dashState.recipe.preActions);
  renderRecipeGrid('postActionsGrid', _dashState.recipe.postActions);
}

function renderRecipeGrid(gridId, actions) {
  var grid = resolveRef(gridId);
  if (!grid) return;
  var data = [];
  for (var i = 0; i < actions.length; i++) {
    data.push({ idx: i + 1, summary: actionSummary(actions[i]), _actionIdx: i });
  }
  grid.setData(data);
}

function wireRecipeGrid(gridId, phase) {
  var grid = resolveRef(gridId);
  if (!grid) return;

  // Remove icon click
  grid.recordClick = function (viewer, record, recordNum, field) {
    if (field && field.name === '_remove') {
      var arr = _dashState.recipe[phase];
      var idx = record._actionIdx;
      if (idx >= 0 && idx < arr.length) {
        arr.splice(idx, 1);
        renderRecipeGrid(gridId, arr);
      }
      return false;
    }
    // Double-click to edit
    return true;
  };

  grid.recordDoubleClick = function (viewer, record) {
    var arr = _dashState.recipe[phase];
    var idx = record._actionIdx;
    if (idx >= 0 && idx < arr.length) {
      showActionDialog(phase, arr[idx], idx);
    }
  };

  // Drag reorder sync
  grid.recordDrop = function (dropRecords, targetRecord, index, sourceWidget) {
    // After SC reorders the visual list, rebuild the action array
    var self = this;
    // Defer so SC finishes its internal reorder first
    setTimeout(function () {
      var newArr = [];
      var data = self.getData();
      var oldArr = _dashState.recipe[phase];
      for (var i = 0; i < data.length; i++) {
        var row = data[i];
        if (row._actionIdx >= 0 && row._actionIdx < oldArr.length) {
          newArr.push(oldArr[row._actionIdx]);
        }
      }
      _dashState.recipe[phase] = newArr;
      renderRecipeGrid(gridId, newArr);
    }, 0);
  };
}

function showAddActionMenu(phase) {
  var categories = window.CATEGORIES || {};
  var commands = window.CLI_COMMANDS || {};

  // Build menu items grouped by category
  var menuData = [];
  for (var catKey in categories) {
    var subItems = [];
    for (var cmd in commands) {
      if (commands[cmd].category === catKey) {
        subItems.push({ title: cmd, _command: cmd, _phase: phase });
      }
    }
    if (subItems.length > 0) {
      menuData.push({ title: categories[catKey], submenu: subItems });
    }
  }

  // Destroy previous menu to prevent Canvas leak
  if (showAddActionMenu._lastMenu) {
    showAddActionMenu._lastMenu.destroy();
    showAddActionMenu._lastMenu = null;
  }
  var menu = isc.Menu.create({
    autoDraw: false,
    data: menuData,
    itemClick: function (item) {
      if (item._command) {
        showActionDialog(item._phase, { command: item._command, args: {}, options: {} }, -1);
      }
    },
  });
  showAddActionMenu._lastMenu = menu;
  menu.showContextMenu();
}

function showActionDialog(phase, action, editIdx) {
  var cmd = action.command;
  var def = window.CLI_COMMANDS[cmd];
  if (!def) return;

  var fields = [];
  // Build form fields from command args
  if (def.args) {
    for (var i = 0; i < def.args.length; i++) {
      var arg = def.args[i];
      var field = {
        name: 'arg_' + arg.name,
        title: arg.name,
        width: '*',
        defaultValue: (action.args && action.args[arg.name]) || '',
      };
      if (arg.type === 'enum' && arg.values) {
        field.editorType = 'SelectItem';
        var vm = {};
        for (var v = 0; v < arg.values.length; v++) vm[arg.values[v]] = arg.values[v];
        field.valueMap = vm;
        field.defaultValue = (action.args && action.args[arg.name]) || arg.values[0];
      } else if (arg.type === 'number') {
        field.editorType = 'SpinnerItem';
        field.defaultValue = (action.args && action.args[arg.name]) || '';
      } else if (arg.type === 'boolean') {
        field.editorType = 'CheckboxItem';
        field.defaultValue = !!(action.args && action.args[arg.name]);
      } else if (arg.type === 'code') {
        field.editorType = 'TextAreaItem';
        field.height = 60;
      } else {
        field.editorType = 'TextItem';
      }
      if (arg.placeholder) field.hint = arg.placeholder;
      fields.push(field);
    }
  }
  // Build form fields from command options
  if (def.options) {
    for (var j = 0; j < def.options.length; j++) {
      var opt = def.options[j];
      var oField = {
        name: 'opt_' + opt.name,
        title: opt.name,
        width: '*',
        defaultValue: (action.options && action.options[opt.name]) || '',
      };
      if (opt.type === 'enum' && opt.values) {
        oField.editorType = 'SelectItem';
        var ovm = { '': '(none)' };
        for (var ov = 0; ov < opt.values.length; ov++) ovm[opt.values[ov]] = opt.values[ov];
        oField.valueMap = ovm;
      } else if (opt.type === 'number') {
        oField.editorType = 'SpinnerItem';
      } else if (opt.type === 'boolean') {
        oField.editorType = 'CheckboxItem';
        oField.defaultValue = !!(action.options && action.options[opt.name]);
      } else {
        oField.editorType = 'TextItem';
      }
      if (opt.placeholder) oField.hint = opt.placeholder;
      fields.push(oField);
    }
  }

  if (fields.length === 0) {
    // No args/options — just add the action directly
    commitAction(phase, cmd, def, {}, editIdx);
    return;
  }

  var form = isc.DynamicForm.create({
    width: '100%',
    numCols: 2,
    colWidths: [100, '*'],
    fields: fields,
  });

  var dlg = isc.Dialog.create({
    title: cmd,
    width: 400,
    height: Math.min(80 + fields.length * 40, 400),
    isModal: true,
    showModalMask: true,
    autoCenter: true,
    closeClick: function () { this.destroy(); },
    items: [form],
    buttons: [
      isc.Button.create({
        title: 'OK',
        click: function () {
          var vals = form.getValues();
          commitAction(phase, cmd, def, vals, editIdx);
          dlg.destroy();
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

function commitAction(phase, cmd, def, formVals, editIdx) {
  var actionObj = { command: cmd, args: {}, options: {} };

  if (def.args) {
    for (var i = 0; i < def.args.length; i++) {
      var name = def.args[i].name;
      var val = formVals['arg_' + name];
      if (val != null && val !== '') actionObj.args[name] = val;
    }
  }
  if (def.options) {
    for (var j = 0; j < def.options.length; j++) {
      var oName = def.options[j].name;
      var oVal = formVals['opt_' + oName];
      if (oVal != null && oVal !== '' && oVal !== false) actionObj.options[oName] = oVal;
    }
  }

  var arr = _dashState.recipe[phase];
  if (editIdx >= 0 && editIdx < arr.length) {
    arr[editIdx] = actionObj;
  } else {
    arr.push(actionObj);
  }

  var gridId = phase === 'preActions' ? 'preActionsGrid' : 'postActionsGrid';
  renderRecipeGrid(gridId, arr);
}

function saveRecipe() {
  if (!_loadedScriptName) {
    isc.say('No script loaded — select a script first.');
    return;
  }
  var pre = _dashState.recipe.preActions || [];
  var post = _dashState.recipe.postActions || [];
  var recipeName = generateRecipeName(pre, post);

  // Save to Recipes DataSource (IndexedDB)
  var recipeData = {
    name: recipeName,
    preActions: pre,
    postActions: post,
    modifiedAt: Date.now(),
  };

  if (_dashState.recipeId) {
    // Update existing recipe
    recipeData.id = _dashState.recipeId;
    dispatchActionAsync('DS_UPDATE', { dataSource: 'Recipes', data: recipeData }).then(function (resp) {
      if (resp && resp.status === 0) {
        isc.say('Recipe saved.');
        refreshRecipeSelect();
      } else {
        var err = (resp && typeof resp.data === 'string') ? resp.data : 'unknown error';
        isc.warn('Failed to save recipe: ' + err);
      }
    });
  } else {
    // Create new recipe
    dispatchActionAsync('DS_ADD', { dataSource: 'Recipes', data: recipeData }).then(function (resp) {
      if (resp && resp.status === 0) {
        var newId = toRecipeId(resp.data && resp.data[0] && resp.data[0].id);
        if (newId) {
          _dashState.recipeId = newId;
          // Auto-assign to current script
          if (_dashState.selectedLibScript) {
            dispatchActionAsync('SCRIPT_LIBRARY_UPDATE', {
              name: _dashState.selectedLibScript,
              recipeId: newId,
            });
          }
          var recipeSelect = resolveRef('recipeSelect');
          if (recipeSelect) recipeSelect.setValue(newId);
        }
        isc.say('Recipe saved.');
        refreshRecipeSelect();
      } else {
        var err = (resp && typeof resp.data === 'string') ? resp.data : 'unknown error';
        isc.warn('Failed to save recipe: ' + err);
      }
    });
  }
}

function generateRecipeName(preActions, postActions) {
  var allActions = (preActions || []).concat(postActions || []);
  if (allActions.length === 0) return 'empty-recipe';
  var parts = [];
  for (var i = 0; i < allActions.length; i++) {
    var cmd = allActions[i].command || '';
    parts.push(cmd.substring(0, 3));
  }
  return parts.join('-');
}
