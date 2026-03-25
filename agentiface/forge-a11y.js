/**
 * ForgeA11y — Agentiface accessibility enhancement layer
 *
 * Rather than patching SmartClient internals, this module adds an
 * ARIA overlay: roles, labels, live region announcements, and
 * keyboard navigation helpers.
 *
 * Usage:
 *   Agentiface.A11y.enhance(myListGrid);
 *   Agentiface.A11y.announce('5 rows loaded');
 *   Agentiface.A11y.enhanceAll();  // auto-enhance all visible SC components
 */

window.Agentiface = window.Agentiface || {};

(function () {
  var _announcer = null;
  var _enhanced = new WeakSet();

  function getAnnouncer() {
    if (_announcer) return _announcer;
    _announcer = document.createElement('div');
    _announcer.id = 'af-announcer';
    _announcer.setAttribute('aria-live', 'polite');
    _announcer.setAttribute('aria-atomic', 'true');
    _announcer.className = 'af-sr-only';
    document.body.appendChild(_announcer);
    return _announcer;
  }

  function setAttr(component, attr, value) {
    var handle = component.getHandle ? component.getHandle() : null;
    if (handle) {
      handle.setAttribute(attr, value);
    }
  }

  function enhanceListGrid(grid) {
    setAttr(grid, 'role', 'grid');
    setAttr(grid, 'aria-label', grid.title || grid.ID || 'Data grid');

    // Announce data load
    if (grid.observe) {
      try {
        grid.observe(grid, 'dataArrived', function () {
          var total = 0;
          try { total = grid.getTotalRows(); } catch (e) { /* ignore */ }
          A11y.announce(total + ' rows loaded');
        });
      } catch (e) {
        // observe may fail if component not fully initialized
      }
    }

    // Announce selection
    var origRecordClick = grid.recordClick;
    grid.recordClick = function (viewer, record, recordNum) {
      if (record) {
        var desc = [];
        var fields = grid.getFields ? grid.getFields() : [];
        for (var i = 0; i < Math.min(fields.length, 3); i++) {
          var val = record[fields[i].name];
          if (val !== undefined && val !== null && val !== '') {
            desc.push(val);
          }
        }
        if (desc.length > 0) {
          A11y.announce('Selected: ' + desc.join(', '));
        }
      }
      if (origRecordClick) {
        return origRecordClick.apply(this, arguments);
      }
    };
  }

  function enhanceDynamicForm(form) {
    setAttr(form, 'role', 'form');
    setAttr(form, 'aria-label', form.title || form.ID || 'Form');

    // Enhance individual fields with labels
    var items = form.getItems ? form.getItems() : [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.getHandle) {
        var handle = item.getHandle();
        if (handle) {
          var input = handle.querySelector('input, select, textarea');
          if (input && item.title) {
            input.setAttribute('aria-label', item.title);
          }
        }
      }
    }
  }

  function enhanceButton(btn) {
    setAttr(btn, 'role', 'button');
    if (btn.title) {
      setAttr(btn, 'aria-label', btn.title);
    }
  }

  function enhanceTabSet(tabSet) {
    setAttr(tabSet, 'role', 'tablist');
    setAttr(tabSet, 'aria-label', tabSet.title || tabSet.ID || 'Tabs');
  }

  function enhanceTreeGrid(tree) {
    setAttr(tree, 'role', 'treegrid');
    setAttr(tree, 'aria-label', tree.title || tree.ID || 'Tree');
  }

  function enhanceWindow(win) {
    setAttr(win, 'role', 'dialog');
    if (win.title) {
      setAttr(win, 'aria-label', win.title);
    }
    setAttr(win, 'aria-modal', 'true');
  }

  function enhanceSectionStack(stack) {
    setAttr(stack, 'role', 'region');
    // Each section header gets accordion role
    var sections = stack.sections || [];
    for (var i = 0; i < sections.length; i++) {
      var header = sections[i].header;
      if (header && header.getHandle) {
        var handle = header.getHandle();
        if (handle) {
          handle.setAttribute('role', 'button');
          handle.setAttribute('aria-expanded', sections[i].isExpanded ? 'true' : 'false');
        }
      }
    }
  }

  var A11y = {
    /**
     * Enhance a SmartClient component with ARIA attributes.
     * Automatically detects component type and applies appropriate enhancements.
     * @param {Object} component - SmartClient component instance
     */
    enhance: function (component) {
      if (!component || _enhanced.has(component)) return;
      _enhanced.add(component);

      try {
        if (isc.isA.ListGrid(component) || isc.isA.ForgeListGrid && isc.isA.ForgeListGrid(component)) {
          enhanceListGrid(component);
        } else if (isc.isA.TreeGrid && isc.isA.TreeGrid(component)) {
          enhanceTreeGrid(component);
        } else if (isc.isA.DynamicForm(component)) {
          enhanceDynamicForm(component);
        } else if (isc.isA.Button(component)) {
          enhanceButton(component);
        } else if (isc.isA.TabSet(component)) {
          enhanceTabSet(component);
        } else if (isc.isA.Window(component)) {
          enhanceWindow(component);
        } else if (isc.isA.SectionStack && isc.isA.SectionStack(component)) {
          enhanceSectionStack(component);
        }
      } catch (e) {
        console.warn('[A11y] Enhancement failed for', component.ID || component.getClassName(), e);
      }
    },

    /**
     * Announce a message to screen readers via ARIA live region.
     * @param {string} message - Text to announce
     * @param {string} [urgency='polite'] - 'polite' or 'assertive'
     */
    announce: function (message, urgency) {
      var announcer = getAnnouncer();
      if (urgency === 'assertive') {
        announcer.setAttribute('aria-live', 'assertive');
      } else {
        announcer.setAttribute('aria-live', 'polite');
      }
      // Clear then set to trigger announcement even if same text
      announcer.textContent = '';
      setTimeout(function () {
        announcer.textContent = message;
      }, 50);
    },

    /**
     * Enhance all visible SC components on the page.
     * Walks the SC component tree and applies ARIA to each.
     */
    enhanceAll: function () {
      if (typeof isc === 'undefined') return;

      var canvases = isc.Canvas._elements;
      if (!canvases) return;

      for (var id in canvases) {
        var comp = canvases[id];
        if (comp && comp.isDrawn && comp.isDrawn() && comp.isVisible && comp.isVisible()) {
          this.enhance(comp);
        }
      }
    },

    /**
     * Add keyboard shortcut to a component.
     * @param {Object} component - SC component
     * @param {string} key - Key to listen for (e.g., 'Escape', 'Enter')
     * @param {Function} handler - Function to call
     */
    addKeyHandler: function (component, key, handler) {
      var handle = component.getHandle ? component.getHandle() : null;
      if (!handle) return;

      handle.setAttribute('tabindex', '0');
      handle.addEventListener('keydown', function (e) {
        if (e.key === key) {
          e.preventDefault();
          handler(e);
        }
      });
    },

    /**
     * Set up focus trap within a container (for dialogs/modals).
     * @param {Object} container - SC component acting as modal
     */
    trapFocus: function (container) {
      var handle = container.getHandle ? container.getHandle() : null;
      if (!handle) return;

      handle.addEventListener('keydown', function (e) {
        if (e.key !== 'Tab') return;

        var focusable = handle.querySelectorAll(
          'input, select, textarea, button, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;

        var first = focusable[0];
        var last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });
    },
  };

  Agentiface.A11y = A11y;
})();
