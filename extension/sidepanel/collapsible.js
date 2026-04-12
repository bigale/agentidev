/**
 * Collapsible section toggle + state persistence for the sidepanel.
 *
 * MV3 CSP forbids inline onclick handlers, so this script wires up
 * the .af-collapsible-header click handlers via addEventListener.
 * Section open/closed state is persisted to localStorage.
 */
(function () {
  'use strict';

  var KEY = 'af-collapsed-sections';
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}

  // Restore collapsed state from localStorage
  document.querySelectorAll('.af-collapsible').forEach(function (el) {
    var section = el.dataset.section;
    if (section && saved[section]) el.classList.add('collapsed');
  });

  // Delegated click handler for all collapsible headers
  document.addEventListener('click', function (e) {
    // Don't toggle if the click was on a button inside the header
    // (e.g., the "+ New" button in the Plugins section)
    if (e.target.closest('button')) return;

    var header = e.target.closest('.af-collapsible-header');
    if (!header) return;

    var container = header.parentElement;
    if (!container || !container.classList.contains('af-collapsible')) return;

    container.classList.toggle('collapsed');

    // Persist state
    var section = container.dataset.section;
    if (section) {
      try {
        var state = JSON.parse(localStorage.getItem(KEY) || '{}');
        if (container.classList.contains('collapsed')) {
          state[section] = true;
        } else {
          delete state[section];
        }
        localStorage.setItem(KEY, JSON.stringify(state));
      } catch (e) {}
    }
  });
})();
