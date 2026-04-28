// dashboard/schedules.js
// Schedules portlet dialogs and form helpers.
// Functions: buildScheduleFormFields, populateScriptDropdown, showNewScheduleDialog, showEditScheduleDialog

function buildScheduleFormFields(scriptOptions) {
  return [
    {
      name: 'name',
      title: 'Name',
      editorType: 'TextItem',
      width: '*',
      colSpan: 3,
      hint: 'my-poller',
      showHintInField: true,
    },
    {
      name: 'scriptName',
      title: 'Script',
      editorType: 'SelectItem',
      width: '*',
      colSpan: 3,
      valueMap: scriptOptions,
      defaultValue: '',
    },
    {
      name: 'scheduleMode',
      title: 'Mode',
      editorType: 'RadioGroupItem',
      colSpan: 3,
      valueMap: { 'interval': 'Interval', 'cron': 'Cron' },
      defaultValue: 'interval',
      vertical: false,
      changed: function (form, item, value) {
        form.getField('interval').setDisabled(value !== 'interval');
        form.getField('unit').setDisabled(value !== 'interval');
        form.getField('cronExpr').setDisabled(value !== 'cron');
      },
    },
    {
      name: 'interval',
      title: 'Every',
      editorType: 'SpinnerItem',
      width: 60,
      colSpan: 1,
      defaultValue: 30,
      min: 1,
    },
    {
      name: 'unit',
      title: '',
      editorType: 'SelectItem',
      width: 60,
      colSpan: 1,
      startRow: false,
      showTitle: false,
      valueMap: { '1000': 'sec', '60000': 'min', '3600000': 'hr' },
      defaultValue: '60000',
    },
    {
      name: 'cronExpr',
      title: 'Cron',
      editorType: 'TextItem',
      width: '*',
      colSpan: 3,
      hint: '0 4 * * *',
      showHintInField: true,
      disabled: true,
    },
    {
      name: 'args',
      title: 'Args',
      editorType: 'TextItem',
      width: '*',
      colSpan: 3,
      hint: '--flag=value',
      showHintInField: true,
    },
    {
      name: 'runNow',
      title: 'Run now',
      editorType: 'CheckboxItem',
      colSpan: 3,
      defaultValue: false,
    },
  ];
}

function populateScriptDropdown(form, statusLabel) {
  var scriptOptions = { '': '-- select script --' };
  var seen = {};
  dispatchActionAsync('SCRIPT_LIBRARY_LIST', {}).then(function (libResp) {
    if (libResp && libResp.success) {
      for (var i = 0; i < (libResp.scripts || []).length; i++) {
        var s = libResp.scripts[i];
        if (!seen[s.name]) {
          seen[s.name] = true;
          scriptOptions[s.name] = s.name;
        }
      }
    }
    return dispatchActionAsync('SCRIPT_LIST', {});
  }).then(function (scriptResp) {
    if (scriptResp && scriptResp.success) {
      for (var j = 0; j < (scriptResp.scripts || []).length; j++) {
        var s = scriptResp.scripts[j];
        var sName = (s.name || '').replace(/\.(mjs|js)$/, '');
        if (sName && !seen[sName]) {
          seen[sName] = true;
          scriptOptions[sName] = sName;
        }
      }
    }
    form.getField('scriptName').setValueMap(scriptOptions);
    if (statusLabel) statusLabel.setContents('');
  }).catch(function () {
    if (statusLabel) statusLabel.setContents('<span style="color:#FF9800;">Could not load scripts — type name manually</span>');
  });
  return scriptOptions;
}

function showNewScheduleDialog() {
  var statusLabel = isc.Label.create({
    width: '100%',
    height: 20,
    contents: '<span style="color:#888;">Loading scripts...</span>',
  });

  var scriptOptions = { '': '-- select script --' };

  var schedForm = isc.DynamicForm.create({
    width: '100%',
    numCols: 4,
    colWidths: [80, '*', 60, 60],
    fields: buildScheduleFormFields(scriptOptions),
  });

  var okBtn = isc.Button.create({
    title: 'Create',
    click: function () {
      var vals = schedForm.getValues();
      if (!vals.scriptName) {
        statusLabel.setContents('<span style="color:#f44336;">Please select a script</span>');
        return;
      }
      var isCron = vals.scheduleMode === 'cron';
      if (isCron && !(vals.cronExpr || '').trim()) {
        statusLabel.setContents('<span style="color:#f44336;">Please enter a cron expression</span>');
        return;
      }
      var intervalMs = isCron ? null : (vals.interval || 30) * parseInt(vals.unit || '60000', 10);
      var cronExpr = isCron ? (vals.cronExpr || '').trim() : null;
      var scheduleName = (vals.name || '').trim() || vals.scriptName;

      okBtn.setDisabled(true);
      cancelBtn.setDisabled(true);
      schedForm.setDisabled(true);
      statusLabel.setContents(
        '<span style="color:#888;">' +
        '<span style="display:inline-block;width:12px;height:12px;border:2px solid #555;' +
        'border-top-color:#aaa;border-radius:50%;animation:spin .8s linear infinite;' +
        'vertical-align:middle;margin-right:6px;"></span>' +
        'Creating schedule\u2026</span>'
      );

      dispatchActionAsync('BRIDGE_GET_INFO', {}).then(function (info) {
        var scriptsDir = (info && info.scriptsDir) || '';
        var scriptPath = scriptsDir + '/' + vals.scriptName + '.mjs';

        return dispatchActionAsync('SCRIPT_LIBRARY_GET', { name: vals.scriptName }).then(function (libResp) {
          var originalPath = (libResp && libResp.success) ? (libResp.script && libResp.script.originalPath) : null;
          var argsArr = vals.args ? vals.args.trim().split(/\s+/) : [];

          var payload = {
            name: scheduleName,
            scriptPath: scriptPath,
            scriptName: vals.scriptName,
            args: argsArr,
            runNow: !!vals.runNow,
            originalPath: originalPath,
          };
          if (isCron) { payload.cronExpr = cronExpr; } else { payload.intervalMs = intervalMs; }

          return dispatchActionAsync('SCHEDULE_CREATE', payload);
        });
      }).then(function (resp) {
        if (resp && resp.success) {
          dlg.destroy();
          var grid = resolveRef('schedulesGrid');
          if (grid && grid.invalidateCache) grid.invalidateCache();
        } else {
          okBtn.setDisabled(false);
          cancelBtn.setDisabled(false);
          schedForm.setDisabled(false);
          var err = (resp && resp.error) || 'Failed to create schedule';
          statusLabel.setContents('<span style="color:#f44336;">' + escapeHtmlDash(err) + '</span>');
        }
      }).catch(function (e) {
        okBtn.setDisabled(false);
        cancelBtn.setDisabled(false);
        schedForm.setDisabled(false);
        statusLabel.setContents('<span style="color:#f44336;">Error: ' + escapeHtmlDash(e.message || String(e)) + '</span>');
      });
    },
  });

  var cancelBtn = isc.Button.create({
    title: 'Cancel',
    click: function () { dlg.destroy(); },
  });

  var dlg = isc.Dialog.create({
    title: 'New Schedule',
    width: 420,
    height: 340,
    isModal: true,
    showModalMask: true,
    autoCenter: true,
    closeClick: function () { this.destroy(); },
    items: [schedForm, statusLabel],
    buttons: [okBtn, cancelBtn],
  });
  dlg.show();

  populateScriptDropdown(schedForm, statusLabel);
}

function showEditScheduleDialog(record) {
  var statusLabel = isc.Label.create({
    width: '100%',
    height: 20,
    contents: '',
  });

  var scriptOptions = { '': '-- select script --' };
  if (record.scriptName) scriptOptions[record.scriptName] = record.scriptName;

  var isCron = !!record.cronExpr;
  var fields = buildScheduleFormFields(scriptOptions);
  // Remove runNow from edit dialog
  fields = fields.filter(function (f) { return f.name !== 'runNow'; });

  var schedForm = isc.DynamicForm.create({
    width: '100%',
    numCols: 4,
    colWidths: [80, '*', 60, 60],
    fields: fields,
  });

  // Set initial values from the record
  var unitMs = '60000';
  var intervalNum = 30;
  if (record.intervalMs) {
    if (record.intervalMs >= 3600000) {
      unitMs = '3600000';
      intervalNum = Math.round(record.intervalMs / 3600000);
    } else if (record.intervalMs >= 60000) {
      unitMs = '60000';
      intervalNum = Math.round(record.intervalMs / 60000);
    } else {
      unitMs = '1000';
      intervalNum = Math.round(record.intervalMs / 1000);
    }
  }
  schedForm.setValues({
    name: record.name || '',
    scriptName: record.scriptName || '',
    scheduleMode: isCron ? 'cron' : 'interval',
    interval: intervalNum,
    unit: unitMs,
    cronExpr: record.cronExpr || '',
    args: (record.args || []).join(' '),
  });
  // Apply initial disabled state for mode fields
  schedForm.getField('interval').setDisabled(isCron);
  schedForm.getField('unit').setDisabled(isCron);
  schedForm.getField('cronExpr').setDisabled(!isCron);

  var okBtn = isc.Button.create({
    title: 'Save',
    click: function () {
      var vals = schedForm.getValues();
      var updates = { scheduleId: record.id };
      var editCron = vals.scheduleMode === 'cron';

      if (editCron && !(vals.cronExpr || '').trim()) {
        statusLabel.setContents('<span style="color:#f44336;">Please enter a cron expression</span>');
        return;
      }

      if ((vals.name || '').trim() !== (record.name || '')) updates.name = (vals.name || '').trim();
      if ((vals.scriptName || '') !== (record.scriptName || '')) updates.scriptName = vals.scriptName;

      if (editCron) {
        updates.cronExpr = (vals.cronExpr || '').trim();
      } else {
        updates.intervalMs = (vals.interval || 30) * parseInt(vals.unit || '60000', 10);
      }

      var argsStr = (vals.args || '').trim();
      var argsArr = argsStr ? argsStr.split(/\s+/) : [];
      var oldArgs = (record.args || []).join(' ');
      if (argsStr !== oldArgs) updates.args = argsArr;

      okBtn.setDisabled(true);
      cancelBtn.setDisabled(true);
      schedForm.setDisabled(true);
      statusLabel.setContents(
        '<span style="color:#888;">' +
        '<span style="display:inline-block;width:12px;height:12px;border:2px solid #555;' +
        'border-top-color:#aaa;border-radius:50%;animation:spin .8s linear infinite;' +
        'vertical-align:middle;margin-right:6px;"></span>' +
        'Saving\u2026</span>'
      );

      dispatchActionAsync('SCHEDULE_UPDATE', updates).then(function (resp) {
        if (resp && resp.success) {
          dlg.destroy();
          var grid = resolveRef('schedulesGrid');
          if (grid && grid.invalidateCache) grid.invalidateCache();
        } else {
          okBtn.setDisabled(false);
          cancelBtn.setDisabled(false);
          schedForm.setDisabled(false);
          var err = (resp && resp.error) || 'Failed to update schedule';
          statusLabel.setContents('<span style="color:#f44336;">' + escapeHtmlDash(err) + '</span>');
        }
      }).catch(function (e) {
        okBtn.setDisabled(false);
        cancelBtn.setDisabled(false);
        schedForm.setDisabled(false);
        statusLabel.setContents('<span style="color:#f44336;">Error: ' + escapeHtmlDash(e.message || String(e)) + '</span>');
      });
    },
  });

  var cancelBtn = isc.Button.create({
    title: 'Cancel',
    click: function () { dlg.destroy(); },
  });

  var dlg = isc.Dialog.create({
    title: 'Edit Schedule: ' + (record.name || record.id),
    width: 420,
    height: 320,
    isModal: true,
    showModalMask: true,
    autoCenter: true,
    closeClick: function () { this.destroy(); },
    items: [schedForm, statusLabel],
    buttons: [okBtn, cancelBtn],
  });
  dlg.show();

  populateScriptDropdown(schedForm, null);
}
