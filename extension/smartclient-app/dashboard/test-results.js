// dashboard/test-results.js
// Test Results portlet.
// Functions: loadTestResults

function loadTestResults() {
  dispatchActionAsync('SCRIPT_RUN_LIST', {}).then(function (resp) {
    if (!resp || !resp.runs) return;
    // Filter to runs that have assertion data
    var testRuns = resp.runs.filter(function (r) { return r.assertions; });
    var grid = resolveRef('testResultsGrid');
    var statusLabel = resolveRef('testStatusLabel');
    if (!grid) return;

    var records = testRuns.map(function (r) {
      return {
        name: r.name,
        pass: r.assertions ? r.assertions.pass : '',
        fail: r.assertions ? r.assertions.fail : '',
        state: r.state,
        durationMs: r.durationMs,
        completedAt: r.completedAt,
      };
    });
    grid.setData(records);

    if (statusLabel) {
      var totalPass = 0, totalFail = 0;
      for (var i = 0; i < records.length; i++) {
        totalPass += (records[i].pass || 0);
        totalFail += (records[i].fail || 0);
      }
      if (records.length > 0) {
        var color = totalFail > 0 ? '#f44336' : '#4CAF50';
        statusLabel.setContents('<span style="color:' + color + ';">' + records.length + ' runs | ' + totalPass + ' pass | ' + totalFail + ' fail</span>');
      } else {
        statusLabel.setContents('<span style="color:#888;">No test runs yet</span>');
      }
    }
  }).catch(function (err) {
    console.warn('[Dashboard] loadTestResults failed:', err.message);
  });
}
