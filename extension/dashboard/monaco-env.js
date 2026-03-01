// Must run before loader.js — tells Monaco where to find its web worker.
window.MonacoEnvironment = {
  getWorkerUrl: function () {
    return chrome.runtime.getURL('dashboard/lib/monaco/vs/base/worker/workerMain.js');
  }
};
