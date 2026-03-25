/**
 * ForgeToast — Agentiface notification/toast system
 *
 * Usage:
 *   Agentiface.Toast.show({ message: 'Saved!', type: 'success' });
 *   Agentiface.Toast.show({ title: 'Error', message: 'Failed to save', type: 'error', duration: 0 });
 *   Agentiface.Toast.show({ message: 'Undo?', type: 'info', action: { label: 'Undo', fn: undoFn } });
 *
 * Also available as SmartClient component:
 *   isc.ForgeToast.show({ message: '...', type: 'info' });
 */

window.Agentiface = window.Agentiface || {};

(function () {
  var _container = null;
  var _queue = [];
  var _maxVisible = 5;

  var ICONS = {
    info:    'i',
    success: '\u2713',
    warning: '!',
    error:   '\u2717',
  };

  function getContainer() {
    if (_container) return _container;
    _container = document.createElement('div');
    _container.className = 'af-toast-container';
    document.body.appendChild(_container);
    return _container;
  }

  function createToastEl(opts) {
    var type = opts.type || 'info';
    var el = document.createElement('div');
    el.className = 'af-toast af-toast-item af-toast-' + type;

    var html = '';

    // Icon
    html += '<div class="af-toast-icon af-toast-icon-' + type + '">' + (ICONS[type] || 'i') + '</div>';

    // Body
    html += '<div class="af-toast-body">';
    if (opts.title) {
      html += '<div class="af-toast-title">' + escapeHtml(opts.title) + '</div>';
    }
    html += '<div class="af-toast-message">' + escapeHtml(opts.message || '') + '</div>';
    if (opts.action && opts.action.label) {
      html += '<button class="af-toast-action">' + escapeHtml(opts.action.label) + '</button>';
    }
    html += '</div>';

    // Close button
    html += '<button class="af-toast-close">\u00d7</button>';

    el.innerHTML = html;

    // Wire close
    var closeBtn = el.querySelector('.af-toast-close');
    closeBtn.addEventListener('click', function () {
      dismissToast(el);
    });

    // Wire action
    if (opts.action && opts.action.fn) {
      var actionBtn = el.querySelector('.af-toast-action');
      if (actionBtn) {
        actionBtn.addEventListener('click', function () {
          try { opts.action.fn(); } catch (e) { console.error('[Toast] Action error:', e); }
          dismissToast(el);
        });
      }
    }

    return el;
  }

  function dismissToast(el) {
    if (el._dismissed) return;
    el._dismissed = true;

    if (el._timer) {
      clearTimeout(el._timer);
      el._timer = null;
    }

    el.classList.remove('af-toast');
    el.classList.add('af-toast-exit');

    el.addEventListener('animationend', function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      processQueue();
    });

    // Fallback if animation doesn't fire (reduced motion)
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
      processQueue();
    }, 350);
  }

  function processQueue() {
    var container = getContainer();
    while (_queue.length > 0 && container.children.length < _maxVisible) {
      var opts = _queue.shift();
      showImmediate(opts);
    }
  }

  function showImmediate(opts) {
    var container = getContainer();
    var el = createToastEl(opts);
    container.appendChild(el);

    var duration = opts.duration !== undefined ? opts.duration : 5000;
    if (duration > 0) {
      el._timer = setTimeout(function () {
        dismissToast(el);
      }, duration);
    }

    return el;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Public API
  var Toast = {
    /**
     * Show a toast notification.
     * @param {Object} opts
     * @param {string} opts.message - Toast message text
     * @param {string} [opts.title] - Optional bold title
     * @param {string} [opts.type='info'] - 'info'|'success'|'warning'|'error'
     * @param {number} [opts.duration=5000] - Auto-dismiss ms (0 = sticky)
     * @param {Object} [opts.action] - { label: string, fn: function }
     */
    show: function (opts) {
      var container = getContainer();
      if (container.children.length >= _maxVisible) {
        _queue.push(opts);
      } else {
        showImmediate(opts);
      }
    },

    /** Show an info toast (shorthand) */
    info: function (message, opts) {
      this.show(Object.assign({ message: message, type: 'info' }, opts || {}));
    },

    /** Show a success toast (shorthand) */
    success: function (message, opts) {
      this.show(Object.assign({ message: message, type: 'success' }, opts || {}));
    },

    /** Show a warning toast (shorthand) */
    warning: function (message, opts) {
      this.show(Object.assign({ message: message, type: 'warning' }, opts || {}));
    },

    /** Show an error toast (shorthand) */
    error: function (message, opts) {
      this.show(Object.assign({ message: message, type: 'error' }, opts || {}));
    },

    /** Dismiss all visible toasts */
    clear: function () {
      _queue = [];
      var container = getContainer();
      var children = Array.prototype.slice.call(container.children);
      for (var i = 0; i < children.length; i++) {
        dismissToast(children[i]);
      }
    },

    /** Set max visible toasts (default 5) */
    setMaxVisible: function (n) {
      _maxVisible = n;
    },
  };

  Agentiface.Toast = Toast;

  // Also register as SC class for renderer compatibility
  if (typeof isc !== 'undefined') {
    isc.ForgeToast = {
      show: function (opts) { return Toast.show(opts); },
      info: function (msg, opts) { return Toast.info(msg, opts); },
      success: function (msg, opts) { return Toast.success(msg, opts); },
      warning: function (msg, opts) { return Toast.warning(msg, opts); },
      error: function (msg, opts) { return Toast.error(msg, opts); },
      clear: function () { return Toast.clear(); },
    };
  }
})();
