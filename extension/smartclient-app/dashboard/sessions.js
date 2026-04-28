// dashboard/sessions.js
// Sessions portlet: New Session dialog.
// Functions: showNewSessionDialog

function showNewSessionDialog() {
  var sessionsGrid = resolveRef('sessionsGrid');
  var currentCount = sessionsGrid ? sessionsGrid.getTotalRows() : 0;
  var defaultName = 'session_' + (currentCount + 1);

  var nameForm = isc.DynamicForm.create({
    width: '100%',
    numCols: 2,
    colWidths: [100, '*'],
    fields: [
      {
        name: 'sessionName',
        title: 'Session name',
        editorType: 'TextItem',
        width: '*',
        defaultValue: defaultName,
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
    title: 'OK',
    click: function () {
      var name = (nameForm.getValue('sessionName') || '').trim();
      if (!name) {
        statusLabel.setContents('<span style="color:#f44336;">Please enter a session name</span>');
        return;
      }

      okBtn.setDisabled(true);
      cancelBtn.setDisabled(true);
      nameForm.setDisabled(true);
      statusLabel.setContents(
        '<span style="color:#888;">' +
        '<span style="display:inline-block;width:12px;height:12px;border:2px solid #555;' +
        'border-top-color:#aaa;border-radius:50%;animation:spin .8s linear infinite;' +
        'vertical-align:middle;margin-right:6px;"></span>' +
        'Creating session\u2026</span>'
      );

      dispatchActionAsync('SESSION_CREATE', { name: name, options: {} }).then(function (resp) {
        if (resp && resp.success) {
          dlg.destroy();
          if (sessionsGrid && sessionsGrid.invalidateCache) sessionsGrid.invalidateCache();
        } else {
          okBtn.setDisabled(false);
          cancelBtn.setDisabled(false);
          nameForm.setDisabled(false);
          var err = (resp && resp.error) || 'Failed to create session';
          statusLabel.setContents('<span style="color:#f44336;">' + escapeHtmlDash(err) + '</span>');
        }
      }).catch(function (e) {
        okBtn.setDisabled(false);
        cancelBtn.setDisabled(false);
        nameForm.setDisabled(false);
        statusLabel.setContents('<span style="color:#f44336;">Error: ' + escapeHtmlDash(e.message || String(e)) + '</span>');
      });
    },
  });

  var cancelBtn = isc.Button.create({
    title: 'Cancel',
    click: function () { dlg.destroy(); },
  });

  var dlg = isc.Dialog.create({
    title: 'New Session',
    width: 360,
    height: 160,
    isModal: true,
    showModalMask: true,
    autoCenter: true,
    closeClick: function () { this.destroy(); },
    items: [nameForm, statusLabel],
    buttons: [okBtn, cancelBtn],
  });
  dlg.show();
  nameForm.focusInItem('sessionName');
}
