/**
 * Script integration handlers (Phase 3 + micro-management).
 * Forwards pause/resume/cancel/step/breakpoint to bridge, provides script list.
 * Script progress broadcasts arrive via bridge-client callbacks.
 * Also manages script library (import, save, remove) in chrome.storage.local.
 */
import * as bridgeClient from '../bridge-client.js';
import { upsertShimImport } from '../shim-utils.js';

const STORAGE_KEY = 'bridge-scripts';

async function getLibrary() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

async function saveLibrary(lib) {
  await chrome.storage.local.set({ [STORAGE_KEY]: lib });
}

export function register(handlers) {
  handlers['SCRIPT_LIST'] = async () => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge', scripts: [] };
    }
    const result = await bridgeClient.listScripts();
    return { success: true, ...result };
  };

  handlers['SCRIPT_PAUSE'] = async (msg) => {
    const result = await bridgeClient.pauseScript(msg.scriptId, msg.reason);
    return { success: true, ...result };
  };

  handlers['SCRIPT_RESUME'] = async (msg) => {
    const result = await bridgeClient.resumeScript(msg.scriptId);
    return { success: true, ...result };
  };

  handlers['SCRIPT_CANCEL'] = async (msg) => {
    const result = await bridgeClient.cancelScript(msg.scriptId, msg.reason, msg.force || false);
    return { success: true, ...result };
  };

  handlers['SCRIPT_LAUNCH'] = async (msg) => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    const result = await bridgeClient.launchScript(msg.path, msg.args || []);
    return { success: true, ...result };
  };

  // ---- Debugger actions ----

  handlers['SCRIPT_STEP'] = async (msg) => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    const result = await bridgeClient.stepScript(msg.scriptId, msg.clearAll || false);
    return { success: true, ...result };
  };

  handlers['SCRIPT_SET_BREAKPOINT'] = async (msg) => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    const result = await bridgeClient.setBreakpoint(msg.scriptId, msg.name, msg.active);
    return { success: true, ...result };
  };

  // ---- Script Library (chrome.storage.local) ----

  handlers['SCRIPT_IMPORT'] = async (msg) => {
    const { path: scriptPath } = msg;
    if (!scriptPath) return { success: false, error: 'Path required' };
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    // Read source from disk via bridge
    const fileResult = await bridgeClient.getScriptSource(scriptPath);
    if (!fileResult?.source) {
      return { success: false, error: 'Could not read file' };
    }
    // Derive name from filename
    const name = scriptPath.split('/').pop().replace(/\.(mjs|js)$/, '');
    // Auto-upsert shim import
    const shimPath = bridgeClient.getShimPath();
    const source = upsertShimImport(fileResult.source, shimPath);
    // Store in chrome.storage.local
    const lib = await getLibrary();
    lib[name] = {
      name,
      source,
      originalPath: scriptPath,
      importedAt: Date.now(),
      modifiedAt: Date.now(),
      size: source.length,
    };
    await saveLibrary(lib);
    // Sync to disk via bridge
    try {
      await bridgeClient.saveScript(name, source);
    } catch (err) {
      console.warn('[ScriptHandlers] Sync to disk failed (non-fatal):', err.message);
    }
    return { success: true, script: lib[name] };
  };

  handlers['SCRIPT_LIBRARY_LIST'] = async () => {
    const lib = await getLibrary();
    const scripts = Object.values(lib).map(s => ({
      name: s.name,
      originalPath: s.originalPath,
      importedAt: s.importedAt,
      modifiedAt: s.modifiedAt,
      size: s.size,
    }));
    return { success: true, scripts };
  };

  handlers['SCRIPT_LIBRARY_GET'] = async (msg) => {
    const lib = await getLibrary();
    const script = lib[msg.name];
    if (!script) return { success: false, error: 'Script not found' };
    return { success: true, script };
  };

  handlers['SCRIPT_LIBRARY_SAVE'] = async (msg) => {
    const { name, source: rawSource } = msg;
    if (!name || !rawSource) return { success: false, error: 'name and source required' };
    const lib = await getLibrary();
    const existing = lib[name];
    if (!existing) return { success: false, error: 'Script not found in library' };
    // Auto-upsert shim import
    const shimPath = bridgeClient.getShimPath();
    const source = upsertShimImport(rawSource, shimPath);
    existing.source = source;
    existing.modifiedAt = Date.now();
    existing.size = source.length;
    await saveLibrary(lib);
    // Sync to disk via bridge
    if (bridgeClient.isConnected()) {
      try {
        await bridgeClient.saveScript(name, source);
      } catch (err) {
        console.warn('[ScriptHandlers] Sync to disk failed (non-fatal):', err.message);
      }
    }
    return { success: true, script: existing };
  };

  handlers['SCRIPT_LIBRARY_REMOVE'] = async (msg) => {
    const lib = await getLibrary();
    if (!lib[msg.name]) return { success: false, error: 'Script not found' };
    delete lib[msg.name];
    await saveLibrary(lib);
    return { success: true };
  };
}
