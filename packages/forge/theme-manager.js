/**
 * Agentiface ThemeManager — runtime theme controller
 *
 * Sets/gets data-theme attribute on <html>, persists preference via
 * postMessage to parent (which stores in chrome.storage.local).
 * Supports light, dark, and system-preference modes.
 */

window.Agentiface = window.Agentiface || {};

Agentiface.ThemeManager = (function () {
  var _theme = 'light';
  var _listeners = [];
  var _systemQuery = window.matchMedia('(prefers-color-scheme: dark)');
  var _useSystem = false;

  function applyTheme(theme) {
    _theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](theme); } catch (e) { console.error('[ThemeManager]', e); }
    }
  }

  function persistTheme(theme) {
    try {
      window.parent.postMessage({
        source: 'agentiface-theme-set',
        theme: theme,
      }, '*');
    } catch (e) {
      // No parent — ignore
    }
  }

  function onSystemChange(e) {
    if (_useSystem) {
      applyTheme(e.matches ? 'dark' : 'light');
    }
  }

  // Listen for theme response from parent (bridge.js)
  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (msg && msg.source === 'agentiface-theme-response' && msg.theme) {
      if (msg.theme === 'system') {
        _useSystem = true;
        applyTheme(_systemQuery.matches ? 'dark' : 'light');
      } else {
        _useSystem = false;
        applyTheme(msg.theme);
      }
    }
  });

  return {
    /**
     * Initialize the theme manager.
     * @param {string} defaultTheme - 'light', 'dark', or 'system'
     */
    init: function (defaultTheme) {
      defaultTheme = defaultTheme || 'light';

      // Apply default immediately
      if (defaultTheme === 'system') {
        _useSystem = true;
        applyTheme(_systemQuery.matches ? 'dark' : 'light');
      } else {
        _useSystem = false;
        applyTheme(defaultTheme);
      }

      // Listen for system preference changes
      if (_systemQuery.addEventListener) {
        _systemQuery.addEventListener('change', onSystemChange);
      } else if (_systemQuery.addListener) {
        _systemQuery.addListener(onSystemChange);
      }

      // Request saved preference from parent
      try {
        window.parent.postMessage({
          source: 'agentiface-theme-request',
        }, '*');
      } catch (e) {
        // No parent — stay with default
      }

      console.log('[ThemeManager] Initialized with default:', defaultTheme);
    },

    /**
     * Set the theme explicitly.
     * @param {string} theme - 'light', 'dark', or 'system'
     */
    setTheme: function (theme) {
      if (theme === 'system') {
        _useSystem = true;
        applyTheme(_systemQuery.matches ? 'dark' : 'light');
        persistTheme('system');
      } else {
        _useSystem = false;
        applyTheme(theme);
        persistTheme(theme);
      }
    },

    /** @returns {string} Current resolved theme ('light' or 'dark') */
    getTheme: function () {
      return _theme;
    },

    /** Toggle between light and dark */
    toggle: function () {
      var next = _theme === 'light' ? 'dark' : 'light';
      _useSystem = false;
      applyTheme(next);
      persistTheme(next);
      return next;
    },

    /**
     * Read a computed CSS custom property value.
     * @param {string} name - Token name (e.g. '--af-accent-primary')
     * @returns {string} Computed value
     */
    getToken: function (name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    },

    /**
     * Register a theme change listener.
     * @param {function} cb - Called with theme string ('light'|'dark')
     * @returns {function} Unsubscribe function
     */
    onThemeChange: function (cb) {
      _listeners.push(cb);
      return function () {
        var idx = _listeners.indexOf(cb);
        if (idx !== -1) _listeners.splice(idx, 1);
      };
    },
  };
})();
