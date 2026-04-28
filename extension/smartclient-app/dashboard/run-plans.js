// dashboard/run-plans.js
// Run plan composition dialogs.
// Functions: showNewRunPlanDialog, showEditStepArgsDialog

function showNewRunPlanDialog(existingPlan) {
  var isEdit = !!existingPlan;
  var defaultPlan = existingPlan || {
    name: 'My Run Plan',
    description: '',
    enabled: true,
    steps: [
      {
        id: 'step_1',
        script: 'verify-selectors',
        enabled: true,
        args: {
          config: '/path/to/probe-config.json',
          baseline: '/path/to/probe-config.baseline.json',
        },
        stopOnFailure: false,
      },
    ],
  };

  var statusLabel = isc.Label.create({
    width: '100%',
    height: 20,
    contents: '',
  });

  var form = isc.DynamicForm.create({
    width: '100%',
    numCols: 2,
    colWidths: [120, '*'],
    fields: [
      { name: 'name', title: 'Name', type: 'text', defaultValue: defaultPlan.name, required: true },
      { name: 'description', title: 'Description', type: 'text', defaultValue: defaultPlan.description || '' },
      {
        name: 'planJson',
        title: 'Plan steps (JSON)',
        type: 'TextAreaItem',
        rowSpan: 6,
        height: 240,
        width: '*',
        colSpan: 2,
        titleOrientation: 'top',
        defaultValue: JSON.stringify({ steps: defaultPlan.steps }, null, 2),
      },
    ],
  });

  var okBtn = isc.Button.create({
    title: isEdit ? 'Save' : 'Create',
    click: function () {
      var vals = form.getValues();
      var name = (vals.name || '').trim();
      if (!name) {
        statusLabel.setContents('<span style="color:#f44336;">Name is required</span>');
        return;
      }
      var parsed;
      try {
        parsed = JSON.parse(vals.planJson || '{}');
      } catch (e) {
        statusLabel.setContents('<span style="color:#f44336;">Invalid JSON: ' + e.message + '</span>');
        return;
      }
      if (!Array.isArray(parsed.steps)) {
        statusLabel.setContents('<span style="color:#f44336;">JSON must contain steps[] array</span>');
        return;
      }

      okBtn.setDisabled(true);
      cancelBtn.setDisabled(true);
      statusLabel.setContents('<span style="color:#888;">Saving plan...</span>');

      var payload = {
        name: name,
        description: (vals.description || '').trim(),
        enabled: defaultPlan.enabled !== false,
        steps: parsed.steps,
      };
      if (isEdit && existingPlan.id) payload.id = existingPlan.id;

      dispatchActionAsync('RUN_PLAN_SAVE', payload).then(function (resp) {
        if (resp && resp.success) {
          var tree = resolveRef('runPlansTree');
          if (tree) tree.invalidateCache();
          dlg.close();
        } else {
          statusLabel.setContents('<span style="color:#f44336;">Save failed: ' + (resp && resp.error || 'unknown') + '</span>');
          okBtn.setDisabled(false);
          cancelBtn.setDisabled(false);
        }
      });
    },
  });
  var cancelBtn = isc.Button.create({
    title: 'Cancel',
    click: function () { dlg.close(); },
  });

  var dlg = isc.Window.create({
    title: isEdit ? ('Edit Run Plan: ' + defaultPlan.name) : 'New Run Plan',
    width: 600,
    height: 480,
    autoCenter: true,
    isModal: true,
    showModalMask: true,
    items: [
      isc.VLayout.create({
        width: '100%',
        height: '100%',
        layoutMargin: 12,
        membersMargin: 8,
        members: [
          form,
          statusLabel,
          isc.HLayout.create({
            height: 30,
            membersMargin: 8,
            align: 'right',
            members: [okBtn, cancelBtn],
          }),
        ],
      }),
    ],
  });
  dlg.show();
}

function showEditStepArgsDialog(planId, stepId) {
  // Fetch the full plan first so we can find the step + preserve other steps.
  dispatchActionAsync('RUN_PLAN_GET', { id: planId }).then(function (resp) {
    if (!resp || !resp.success || !resp.plan) {
      isc.warn('Could not load plan: ' + (resp && resp.error || 'not found'));
      return;
    }
    var plan = resp.plan;
    var step = (plan.steps || []).find(function (s) { return s.id === stepId; });
    if (!step) { isc.warn('Step ' + stepId + ' not found in plan'); return; }

    var statusLabel = isc.Label.create({ width: '100%', height: 20, contents: '' });
    var form = isc.DynamicForm.create({
      width: '100%',
      numCols: 2,
      colWidths: [120, '*'],
      fields: [
        { name: 'script', title: 'Script', type: 'text', defaultValue: step.script, canEdit: true },
        { name: 'enabled', title: 'Enabled', type: 'boolean', defaultValue: step.enabled !== false },
        { name: 'stopOnFailure', title: 'Stop on fail', type: 'boolean', defaultValue: !!step.stopOnFailure },
        {
          name: 'argsJson',
          title: 'Args (JSON)',
          type: 'TextAreaItem',
          rowSpan: 4,
          height: 180,
          width: '*',
          colSpan: 2,
          titleOrientation: 'top',
          defaultValue: JSON.stringify(step.args || {}, null, 2),
        },
      ],
    });

    var saveBtn = isc.Button.create({
      title: 'Save',
      click: function () {
        var vals = form.getValues();
        var parsed;
        try { parsed = JSON.parse(vals.argsJson || '{}'); }
        catch (e) { statusLabel.setContents('<span style="color:#f44336;">Invalid JSON: ' + e.message + '</span>'); return; }
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
          statusLabel.setContents('<span style="color:#f44336;">Args must be a JSON object</span>'); return;
        }
        // Patch the step in place; preserve other steps unchanged
        var patchedSteps = plan.steps.map(function (s) {
          if (s.id !== stepId) return s;
          return Object.assign({}, s, {
            script: (vals.script || s.script || '').trim(),
            enabled: !!vals.enabled,
            stopOnFailure: !!vals.stopOnFailure,
            args: parsed,
          });
        });
        saveBtn.setDisabled(true);
        cancelBtn.setDisabled(true);
        statusLabel.setContents('<span style="color:#888;">Saving...</span>');
        dispatchActionAsync('RUN_PLAN_SAVE', {
          id: plan.id,
          name: plan.name,
          description: plan.description,
          enabled: plan.enabled,
          steps: patchedSteps,
        }).then(function (resp) {
          if (resp && resp.success) {
            var tree = resolveRef('runPlansTree');
            if (tree) tree.invalidateCache();
            dlg.close();
          } else {
            statusLabel.setContents('<span style="color:#f44336;">Save failed: ' + (resp && resp.error || 'unknown') + '</span>');
            saveBtn.setDisabled(false);
            cancelBtn.setDisabled(false);
          }
        });
      },
    });
    var cancelBtn = isc.Button.create({ title: 'Cancel', click: function () { dlg.close(); } });

    var dlg = isc.Window.create({
      title: 'Edit Step: ' + stepId,
      width: 560,
      height: 400,
      autoCenter: true,
      isModal: true,
      showModalMask: true,
      items: [
        isc.VLayout.create({
          width: '100%', height: '100%', layoutMargin: 12, membersMargin: 8,
          members: [form, statusLabel,
            isc.HLayout.create({ height: 30, membersMargin: 8, align: 'right', members: [saveBtn, cancelBtn] }),
          ],
        }),
      ],
    });
    dlg.show();
  });
}
