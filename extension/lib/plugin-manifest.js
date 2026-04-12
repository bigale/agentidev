/**
 * Plugin manifest schema + validator.
 *
 * The host capability interface plan defines plugins as self-contained
 * bundles that target the agentidev platform. Each plugin ships a
 * manifest.json describing its identity, what UI modes it provides, what
 * host capabilities and runtimes it requires, and where its handlers and
 * templates live.
 *
 * This validator is intentionally lightweight (no external schema lib) —
 * it returns a list of errors for diagnostics rather than throwing,
 * because a malformed plugin should not crash the SW boot.
 *
 * Manifest shape (minimum):
 *
 *   {
 *     "id": "hello-runtime",                       // string, lowercase, kebab-case
 *     "name": "Hello Runtime",                     // string, display name
 *     "version": "0.1.0",                          // semver-ish string
 *     "description": "...",                        // optional
 *     "modes": ["hello-runtime"],                  // string[], URL ?mode=<id> values it claims
 *     "templates": {                               // optional, key -> relative path
 *       "dashboard": "templates/dashboard.json"
 *     },
 *     "handlers": "handlers.js",                   // optional, relative path to handlers module
 *     "requires": {                                // optional
 *       "hostCapabilities": ["message", "storage", ...],
 *       "runtimes": ["cheerpj", "cheerpx", "bsh"]
 *     },
 *     "assets": { "icon": "assets/icon.svg" },     // optional
 *     "rootfs": { ... }                            // optional, for CheerpX rootfs plugins
 *   }
 */

const KNOWN_HOST_CAPABILITIES = ['message', 'storage', 'fs', 'exec', 'network', 'identity', 'runtimes'];
const KNOWN_RUNTIMES = ['cheerpj', 'cheerpx', 'bsh'];

/**
 * Validate a plugin manifest. Returns { ok, errors[] }.
 *
 * @param {any} manifest  Parsed manifest object
 * @param {object} [opts]
 * @param {string[]} [opts.availableRuntimes]  Override the known-runtime list
 *                                              (used by tests / future runtimes)
 */
export function validateManifest(manifest, opts = {}) {
  const errors = [];
  const availableRuntimes = opts.availableRuntimes || KNOWN_RUNTIMES;

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['manifest is not an object'] };
  }

  // id — required, kebab-case lowercase
  if (typeof manifest.id !== 'string' || !manifest.id) {
    errors.push('id is required and must be a non-empty string');
  } else if (!/^[a-z][a-z0-9-]*$/.test(manifest.id)) {
    errors.push('id must be lowercase kebab-case (e.g., "hello-runtime")');
  }

  // name — required
  if (typeof manifest.name !== 'string' || !manifest.name) {
    errors.push('name is required and must be a non-empty string');
  }

  // version — required, loose semver-ish
  if (typeof manifest.version !== 'string' || !manifest.version) {
    errors.push('version is required and must be a non-empty string');
  }

  // description — optional but if present must be a string
  if (manifest.description !== undefined && typeof manifest.description !== 'string') {
    errors.push('description must be a string if present');
  }

  // modes — required, non-empty string array
  if (!Array.isArray(manifest.modes) || manifest.modes.length === 0) {
    errors.push('modes is required and must be a non-empty array');
  } else {
    for (const m of manifest.modes) {
      if (typeof m !== 'string' || !m) {
        errors.push(`modes contains non-string entry: ${JSON.stringify(m)}`);
      }
    }
  }

  // templates — optional, object of name → relative path
  if (manifest.templates !== undefined) {
    if (typeof manifest.templates !== 'object' || Array.isArray(manifest.templates)) {
      errors.push('templates must be an object mapping name → relative path');
    } else {
      for (const [k, v] of Object.entries(manifest.templates)) {
        if (typeof v !== 'string' || !v) {
          errors.push(`templates.${k} must be a non-empty string`);
        } else if (v.startsWith('/') || v.includes('..')) {
          errors.push(`templates.${k} must be a relative path inside the plugin dir`);
        }
      }
    }
  }

  // handlers — optional, relative path
  if (manifest.handlers !== undefined) {
    if (typeof manifest.handlers !== 'string' || !manifest.handlers) {
      errors.push('handlers must be a non-empty relative path');
    } else if (manifest.handlers.startsWith('/') || manifest.handlers.includes('..')) {
      errors.push('handlers must be a relative path inside the plugin dir');
    }
  }

  // requires — optional
  if (manifest.requires !== undefined) {
    if (typeof manifest.requires !== 'object' || Array.isArray(manifest.requires)) {
      errors.push('requires must be an object');
    } else {
      const { hostCapabilities, runtimes } = manifest.requires;
      if (hostCapabilities !== undefined) {
        if (!Array.isArray(hostCapabilities)) {
          errors.push('requires.hostCapabilities must be an array');
        } else {
          for (const cap of hostCapabilities) {
            if (!KNOWN_HOST_CAPABILITIES.includes(cap)) {
              errors.push(`requires.hostCapabilities[]: unknown capability "${cap}"`);
            }
          }
        }
      }
      if (runtimes !== undefined) {
        if (!Array.isArray(runtimes)) {
          errors.push('requires.runtimes must be an array');
        } else {
          for (const r of runtimes) {
            if (!availableRuntimes.includes(r)) {
              errors.push(`requires.runtimes[]: runtime "${r}" not in available list (${availableRuntimes.join(', ')})`);
            }
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Resolve a plugin-relative path to a full chrome-extension URL.
 *
 * @param {string} pluginId
 * @param {string} relPath  e.g. "templates/dashboard.json"
 * @returns {string}        chrome-extension://<id>/apps/<plugin-id>/<relPath>
 */
export function pluginUrl(pluginId, relPath) {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
    throw new Error('pluginUrl requires chrome.runtime context');
  }
  const safe = String(relPath || '').replace(/^\/+/, '');
  return chrome.runtime.getURL(`apps/${pluginId}/${safe}`);
}
