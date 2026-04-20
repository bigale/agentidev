/**
 * Plugin loader — discovers installed plugins, validates their manifests,
 * and registers their handlers on the service-worker dispatch table.
 *
 * Discovery: reads `extension/apps/index.json` for the list of plugin IDs.
 * For each plugin:
 *   1. Fetch + validate `apps/<id>/manifest.json`
 *   2. If the manifest declares a `handlers` module, dynamic-import it
 *      and call `register(handlers, { manifest, host })`
 *   3. Track the loaded plugin in module state for PLUGIN_LIST /
 *      PLUGIN_GET_DASHBOARD lookups
 *
 * Plugins are loaded once at SW boot. The SW restarting (MV3 lifecycle)
 * re-runs the loader so plugins get re-registered without an extension
 * reload.
 *
 * A plugin failing to load is a non-fatal warning — the rest of the
 * extension keeps working. The dispatch table is fail-soft.
 */

import { validateManifest, pluginUrl } from './plugin-manifest.js';
import { PLUGIN_REGISTRARS } from '../apps/_loaded.js';

// Tracks installed plugins by id. Persists across loadPlugins() calls
// within a single SW lifetime.
const _registry = new Map(); // id -> { manifest, source, loadedAt }

/**
 * Load every plugin listed in extension/apps/index.json.
 * Idempotent within a SW lifetime — plugins already in the registry
 * aren't re-loaded.
 *
 * @param {object} handlers  The dispatch table (from createMessageRouter)
 * @returns {Promise<{loaded: string[], failed: Array<{id, error}>}>}
 */
export async function loadPlugins(handlers) {
  const loaded = [];
  const failed = [];

  let indexJson;
  try {
    const indexUrl = chrome.runtime.getURL('apps/index.json');
    const resp = await fetch(indexUrl);
    if (!resp.ok) throw new Error(`apps/index.json fetch failed: ${resp.status}`);
    indexJson = await resp.json();
  } catch (err) {
    console.warn('[PluginLoader] no apps/index.json — no plugins will load:', err.message);
    return { loaded, failed };
  }

  const ids = Array.isArray(indexJson?.plugins) ? indexJson.plugins : [];
  if (ids.length === 0) {
    console.log('[PluginLoader] index.json has no plugins listed');
    return { loaded, failed };
  }

  console.log('[PluginLoader] discovered plugins:', ids.join(', '));

  for (const id of ids) {
    if (_registry.has(id)) {
      console.log(`[PluginLoader] ${id}: already loaded, skipping`);
      loaded.push(id);
      continue;
    }
    try {
      await loadPlugin(id, handlers);
      loaded.push(id);
    } catch (err) {
      console.warn(`[PluginLoader] ${id}: load failed:`, err.message);
      failed.push({ id, error: err.message });
    }
  }

  // ---- Storage-backed plugins (published from Agentiface projects) ----
  // These have no handlers and no files on disk — just a manifest + template
  // in chrome.storage.local under keys like plugin:<id>:manifest.
  try {
    const allStorage = await chrome.storage.local.get(null);
    const storagePluginIds = new Set();
    for (const key of Object.keys(allStorage)) {
      const match = key.match(/^plugin:([^:]+):manifest$/);
      if (match) storagePluginIds.add(match[1]);
    }
    for (const id of storagePluginIds) {
      if (_registry.has(id)) continue;
      const manifest = allStorage['plugin:' + id + ':manifest'];
      if (!manifest || !manifest.id) continue;
      _registry.set(id, {
        manifest,
        source: 'storage',
        loadedAt: Date.now(),
      });
      loaded.push(id);
      console.log(`[PluginLoader] ${id}: loaded from storage (published project)`);
    }
  } catch (err) {
    console.warn('[PluginLoader] storage scan failed:', err.message);
  }

  // Register meta handlers ONCE so the SC sandbox can introspect plugins.
  if (!handlers['PLUGIN_LIST']) {
    handlers['PLUGIN_LIST'] = async () => listPlugins();
  }
  if (!handlers['PLUGIN_GET_MANIFEST']) {
    handlers['PLUGIN_GET_MANIFEST'] = async (msg) => getManifest(msg.id);
  }
  if (!handlers['PLUGIN_GET_TEMPLATE']) {
    handlers['PLUGIN_GET_TEMPLATE'] = async (msg) => getTemplate(msg.id, msg.template || 'dashboard');
  }

  // Publish a project as a plugin (storage-backed)
  if (!handlers['SC_PUBLISH_PLUGIN']) {
    handlers['SC_PUBLISH_PLUGIN'] = async (msg) => publishProjectAsPlugin(msg);
  }
  // Unpublish
  if (!handlers['SC_UNPUBLISH_PLUGIN']) {
    handlers['SC_UNPUBLISH_PLUGIN'] = async (msg) => unpublishPlugin(msg.id);
  }

  // Test a plugin by opening it in the extension's own browser
  if (!handlers['TEST_PLUGIN_IN_TAB']) {
    handlers['TEST_PLUGIN_IN_TAB'] = async (msg) => testPluginInTab(msg.pluginId);
  }

  return { loaded, failed };
}

async function loadPlugin(id, handlers) {
  // 1. Fetch + parse manifest
  const manifestUrl = pluginUrl(id, 'manifest.json');
  const resp = await fetch(manifestUrl);
  if (!resp.ok) throw new Error(`manifest fetch failed: ${resp.status}`);
  const manifest = await resp.json();

  // 2. Validate
  if (manifest.id !== id) {
    throw new Error(`manifest.id "${manifest.id}" does not match directory "${id}"`);
  }
  const { ok, errors } = validateManifest(manifest);
  if (!ok) {
    throw new Error(`invalid manifest: ${errors.join('; ')}`);
  }

  // 3. Look up the plugin's registrar in the static registry. Service
  // workers cannot use dynamic import() (disallowed by spec), so the map
  // in apps/_loaded.js is our discovery mechanism — see that file for the
  // pattern. A manifest declaring `handlers` but missing from the registry
  // is a build error: the plugin's source landed but _loaded.js wasn't
  // updated.
  if (manifest.handlers) {
    if (manifest.handlers !== 'handlers.js') {
      // Keep it boring for v1: only handlers.js is supported. If a plugin
      // wants to split handlers across files it can re-export from
      // handlers.js — same pattern as our own lib/handlers/*.js modules.
      throw new Error(`unsupported handlers path "${manifest.handlers}"; must be "handlers.js"`);
    }
    const registrar = PLUGIN_REGISTRARS[id];
    if (typeof registrar !== 'function') {
      throw new Error(`no registrar in apps/_loaded.js for "${id}" — add a static import + entry`);
    }
    try {
      registrar(handlers, { manifest });
    } catch (err) {
      throw new Error(`handlers register() threw: ${err.message}`);
    }
  }

  _registry.set(id, {
    manifest,
    loadedAt: Date.now(),
  });
  console.log(`[PluginLoader] ${id}: loaded${manifest.handlers ? ' (with handlers)' : ''}`);
}

/**
 * @returns {Array<{id, name, version, modes, requires}>}
 */
export function listPlugins() {
  const out = [];
  for (const [id, entry] of _registry.entries()) {
    const m = entry.manifest;
    out.push({
      id,
      name: m.name,
      version: m.version,
      description: m.description || '',
      modes: m.modes,
      requires: m.requires || {},
      loadedAt: entry.loadedAt,
    });
  }
  return out;
}

export function getManifest(id) {
  const entry = _registry.get(id);
  if (!entry) return { error: `plugin "${id}" not loaded` };
  return { manifest: entry.manifest };
}

/**
 * Fetch a template JSON for a plugin and return its parsed contents.
 *
 * @param {string} id        plugin id
 * @param {string} template  template name from manifest.templates (default 'dashboard')
 * @returns {Promise<{config, error?}>}
 */
export async function getTemplate(id, template = 'dashboard') {
  const entry = _registry.get(id);
  if (!entry) return { error: `plugin "${id}" not loaded` };

  // Storage-backed plugins: read template from chrome.storage.local
  if (entry.source === 'storage') {
    try {
      const key = 'plugin:' + id + ':template:' + template;
      const stored = await chrome.storage.local.get(key);
      if (stored[key]) return { config: stored[key] };
      return { error: `storage plugin "${id}" has no template "${template}"` };
    } catch (err) {
      return { error: err.message };
    }
  }

  // File-backed plugins: fetch from extension directory
  const relPath = entry.manifest.templates && entry.manifest.templates[template];
  if (!relPath) return { error: `plugin "${id}" has no template "${template}"` };
  try {
    const url = pluginUrl(id, relPath);
    const resp = await fetch(url);
    if (!resp.ok) return { error: `template fetch failed: ${resp.status}` };
    const config = await resp.json();
    return { config };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Publish an Agentiface project as a storage-backed plugin.
 * The project's SmartClient config becomes the plugin's dashboard template.
 *
 * @param {object} msg
 * @param {string} msg.projectId   Project ID from the project persistence store
 * @param {string} msg.name        Display name for the plugin
 * @param {string} [msg.description]
 * @param {object} msg.config      The SmartClient config JSON ({ layout, dataSources })
 * @returns {Promise<{success, id, mode}>}
 */
async function publishProjectAsPlugin(msg) {
  if (!msg.name || !msg.config) {
    return { error: 'name and config are required' };
  }
  // Generate a kebab-case id from the name
  const id = msg.projectId || msg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const mode = id;

  const manifest = {
    id,
    name: msg.name,
    version: '0.1.0',
    description: msg.description || 'Published from Agentiface project',
    modes: [mode],
    templates: { dashboard: '__storage__' },
    // No handlers — pure UI template
    source: 'agentiface-project',
    publishedAt: Date.now(),
    projectId: msg.projectId || null,
  };

  // Ensure the config has the { layout } wrapper the renderer expects
  let config = msg.config;
  if (config && !config.layout && config._type) {
    config = { layout: config };
  }

  await chrome.storage.local.set({
    ['plugin:' + id + ':manifest']: manifest,
    ['plugin:' + id + ':template:dashboard']: config,
  });

  // Register in the live registry so it appears immediately in PLUGIN_LIST
  _registry.set(id, { manifest, source: 'storage', loadedAt: Date.now() });

  console.log(`[PluginLoader] published project as plugin: ${id}`);
  return { success: true, id, mode, url: 'smartclient-app/wrapper.html?mode=' + encodeURIComponent(mode) };
}

async function unpublishPlugin(id) {
  if (!id) return { error: 'id is required' };
  await chrome.storage.local.remove([
    'plugin:' + id + ':manifest',
    'plugin:' + id + ':template:dashboard',
  ]);
  _registry.delete(id);
  return { success: true };
}

/**
 * Test a plugin by opening it in the extension's own browser tab.
 * Uses chrome.tabs.create() so the extension is available (unlike Playwright
 * sessions which spawn isolated browsers without extensions).
 *
 * Flow:
 *  1. Verify the plugin exists in the registry
 *  2. Open wrapper.html?mode=<pluginId> in a new tab
 *  3. Wait for SmartClient to render
 *  4. Inject a script to query the sandbox for component status
 *  5. Return rendered component info
 *
 * @param {string} pluginId
 * @returns {Promise<{success, tabId, url, title, components, error?}>}
 */
async function testPluginInTab(pluginId) {
  if (!pluginId) return { error: 'pluginId is required' };

  // Verify plugin exists
  const entry = _registry.get(pluginId);
  if (!entry) {
    return { error: `plugin "${pluginId}" not found. Available: ${[..._registry.keys()].join(', ')}` };
  }

  const pluginUrl = chrome.runtime.getURL(
    'smartclient-app/wrapper.html?mode=' + encodeURIComponent(pluginId)
  );

  // Open tab in background
  let tab;
  try {
    tab = await chrome.tabs.create({ url: pluginUrl, active: false });
  } catch (e) {
    return { error: 'Failed to create tab: ' + e.message };
  }

  // Wait for tab to finish loading
  await new Promise((resolve) => {
    const listener = (tabId, info) => {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // Safety timeout
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 10000);
  });

  // Wait for SmartClient to render (bridge.js → app.js → renderer)
  await new Promise(r => setTimeout(r, 4000));

  // Query the wrapper page for component status via port messaging.
  // chrome.tabs.connect targets extension pages (unlike sendMessage which
  // only reaches content scripts). bridge.js listens on 'wrapper-status' port.
  let statusResult = null;
  try {
    statusResult = await new Promise((resolve) => {
      const port = chrome.tabs.connect(tab.id, { name: 'wrapper-status' });
      port.onMessage.addListener((msg) => {
        try { port.disconnect(); } catch (_) {}
        resolve(msg);
      });
      port.onDisconnect.addListener(() => {
        resolve({ error: 'port disconnected: ' + (chrome.runtime.lastError?.message || 'unknown') });
      });
      port.postMessage({ type: 'GET_STATUS' });
      // Safety timeout
      setTimeout(() => {
        try { port.disconnect(); } catch (_) {}
        resolve({ error: 'status query timed out' });
      }, 5000);
    });
  } catch (e) {
    statusResult = { error: 'connect failed: ' + e.message };
  }

  console.log(`[PluginLoader] test_plugin ${pluginId}: tab=${tab.id}`, statusResult);

  return {
    success: !statusResult.error,
    tabId: tab.id,
    url: pluginUrl,
    title: statusResult.title || '',
    configLoaded: statusResult.configLoaded || false,
    componentCount: statusResult.componentCount || 0,
    components: statusResult.components || [],
    error: statusResult.error || undefined,
  };
}

/** Test/dev helper — wipe the registry so loadPlugins() reloads everything. */
export function _resetRegistry() {
  _registry.clear();
}
