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
    const bp = msg.breakpoints || [];
    const lineBp = msg.lineBreakpoints || [];
    const debug = msg.debug || false;
    const sessionId = msg.sessionId || null;

    // Look up originalPath from library so server can derive CWD for dependencies
    let originalPath = null;
    try {
      const scriptName = (msg.path || '').split('/').pop().replace(/\.(mjs|js)$/, '');
      const lib = await getLibrary();
      if (lib[scriptName]?.originalPath) {
        originalPath = lib[scriptName].originalPath;
      }
    } catch {}

    const preActions = msg.preActions || null;
    const postActions = msg.postActions || null;
    console.log(`[ScriptHandlers] SCRIPT_LAUNCH path=${msg.path} originalPath=${originalPath} breakpoints=[${bp.join(',')}] lineBreakpoints=[${lineBp.join(',')}] debug=${debug} sessionId=${sessionId} pre=${preActions?.length || 0} post=${postActions?.length || 0}`);
    const result = await bridgeClient.launchScript(msg.path, msg.args || [], bp, lineBp, debug, sessionId, originalPath, preActions, postActions);
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

  // ---- V8 Inspector debugging (line-level) ----

  handlers['DBG_STEP_OVER'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected' };
    return { success: true, ...(await bridgeClient.dbgStepOver(msg.scriptId, msg.pid)) };
  };
  handlers['DBG_STEP_INTO'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected' };
    return { success: true, ...(await bridgeClient.dbgStepInto(msg.scriptId, msg.pid)) };
  };
  handlers['DBG_STEP_OUT'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected' };
    return { success: true, ...(await bridgeClient.dbgStepOut(msg.scriptId, msg.pid)) };
  };
  handlers['DBG_CONTINUE'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected' };
    return { success: true, ...(await bridgeClient.dbgContinue(msg.scriptId, msg.pid)) };
  };
  handlers['DBG_SET_BREAKPOINT'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected' };
    return { success: true, ...(await bridgeClient.dbgSetBreakpoint(msg.scriptId, msg.pid, msg.file, msg.line)) };
  };
  handlers['DBG_REMOVE_BREAKPOINT'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected' };
    return { success: true, ...(await bridgeClient.dbgRemoveBreakpoint(msg.scriptId, msg.pid, msg.breakpointId)) };
  };
  handlers['DBG_EVALUATE'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected' };
    return { success: true, ...(await bridgeClient.dbgEvaluate(msg.scriptId, msg.pid, msg.expression, msg.callFrameId)) };
  };
  handlers['DBG_RESTART_FRAME'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected' };
    return { success: true, ...(await bridgeClient.dbgRestartFrame(msg.scriptId, msg.pid, msg.callFrameId)) };
  };

  // ---- Auth capture ----

  handlers['AUTH_CAPTURE_START'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };
    const result = await bridgeClient.startAuthCapture(msg.scriptName, msg.url);
    return { success: true, ...result };
  };

  handlers['AUTH_CAPTURE_SAVE'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };
    const result = await bridgeClient.saveAuthState(msg.sessionId, msg.scriptName);
    return { success: true, ...result };
  };

  handlers['AUTH_CHECK'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };
    const result = await bridgeClient.checkAuthState(msg.scriptName);
    return { success: true, ...result };
  };

  // ---- Scheduling ----

  handlers['SCHEDULE_CREATE'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };

    // Look up originalPath from library so scheduled triggers can derive CWD for dependencies
    if (!msg.originalPath && msg.scriptPath) {
      try {
        const scriptName = msg.scriptPath.split('/').pop().replace(/\.(mjs|js)$/, '');
        const lib = await getLibrary();
        if (lib[scriptName]?.originalPath) {
          msg.originalPath = lib[scriptName].originalPath;
        }
      } catch {}
    }

    return { success: true, ...(await bridgeClient.createSchedule(msg)) };
  };
  handlers['SCHEDULE_UPDATE'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };
    const { scheduleId, ...updates } = msg;
    return { success: true, ...(await bridgeClient.updateSchedule(scheduleId, updates)) };
  };
  handlers['SCHEDULE_DELETE'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };
    return { success: true, ...(await bridgeClient.deleteSchedule(msg.scheduleId)) };
  };
  handlers['SCHEDULE_LIST'] = async () => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge', schedules: [] };
    return { success: true, ...(await bridgeClient.listSchedules()) };
  };
  handlers['SCHEDULE_TRIGGER'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };
    return { success: true, ...(await bridgeClient.triggerSchedule(msg.scheduleId)) };
  };

  // ---- Script Library (chrome.storage.local) ----

  handlers['SCRIPT_IMPORT'] = async (msg) => {
    const scriptPath = (msg.path || '').trim().replace(/^["']+|["']+$/g, '');
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
    const { name, source: rawSource, recipe } = msg;
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
    // Persist recipe if provided
    if (recipe !== undefined) {
      existing.recipe = recipe;
    }
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
