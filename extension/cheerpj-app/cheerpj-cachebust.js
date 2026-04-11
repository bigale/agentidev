// Cache-bust the runtime iframe's src at load time.
// The asset server serves with Cache-Control: max-age=3600, so a constant
// src would reuse the cached version across host page reloads.
document.getElementById('runtimeFrame').src =
  'http://localhost:9877/cheerpj-runtime.html?t=' + Date.now();
