/**
 * Script integration handlers (Phase 3 + micro-management).
 * Forwards pause/resume/cancel/step/breakpoint to bridge, provides script list.
 * Script progress broadcasts arrive via bridge-client callbacks.
 * Also manages script library (import, save, remove) in chrome.storage.local.
 */
import * as bridgeClient from '../bridge-client.js';
import { upsertShimImport } from '../shim-utils.js';
import { dsAdd, dsFetch } from './datasource-handlers.js';

const STORAGE_KEY = 'bridge-scripts';
const VERSIONS_KEY = 'script-versions';

// Coerce recipeId to integer or null — guards against string "undefined"/"null"
function sanitizeRecipeId(val) {
  if (val == null || val === '' || val === 'undefined' || val === 'null') return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

async function getLibrary() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || {};
}

async function saveLibrary(lib) {
  await chrome.storage.local.set({ [STORAGE_KEY]: lib });
}

async function getVersions() {
  const data = await chrome.storage.local.get(VERSIONS_KEY);
  return data[VERSIONS_KEY] || [];
}

async function saveVersions(versions) {
  await chrome.storage.local.set({ [VERSIONS_KEY]: versions });
}

async function addVersion(scriptName, source, originalPath) {
  const versions = await getVersions();
  versions.push({
    scriptName,
    modifiedAt: Date.now(),
    source,
    originalPath: originalPath || null,
    size: source.length,
  });
  // Prune to latest 20 per scriptName
  const byName = {};
  for (const v of versions) {
    if (!byName[v.scriptName]) byName[v.scriptName] = [];
    byName[v.scriptName].push(v);
  }
  const pruned = [];
  for (const name in byName) {
    const arr = byName[name].sort((a, b) => b.modifiedAt - a.modifiedAt);
    pruned.push(...arr.slice(0, 20));
  }
  await saveVersions(pruned);
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
    const scriptId = msg.scriptId || msg.id;
    const result = await bridgeClient.pauseScript(scriptId, msg.reason);
    return { success: true, ...result };
  };

  handlers['SCRIPT_RESUME'] = async (msg) => {
    const scriptId = msg.scriptId || msg.id;
    const result = await bridgeClient.resumeScript(scriptId);
    return { success: true, ...result };
  };

  handlers['SCRIPT_CANCEL'] = async (msg) => {
    const scriptId = msg.scriptId || msg.id;
    const result = await bridgeClient.cancelScript(scriptId, msg.reason, msg.force || false);
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
      const scriptName = (msg.path || '').split(/[/\\]/).pop().replace(/\.(mjs|js)$/, '');
      const lib = await getLibrary();
      if (lib[scriptName]?.originalPath) {
        originalPath = lib[scriptName].originalPath;
      }
    } catch {}

    const preActions = msg.preActions || null;
    const postActions = msg.postActions || null;
    const captureArtifacts = msg.captureArtifacts || false;
    console.log(`[ScriptHandlers] SCRIPT_LAUNCH path=${msg.path} originalPath=${originalPath} breakpoints=[${bp.join(',')}] lineBreakpoints=[${lineBp.join(',')}] debug=${debug} sessionId=${sessionId} pre=${preActions?.length || 0} post=${postActions?.length || 0} capture=${captureArtifacts}`);
    const result = await bridgeClient.launchScript(msg.path, msg.args || [], bp, lineBp, debug, sessionId, originalPath, preActions, postActions, captureArtifacts);
    return { success: true, ...result };
  };

  // ---- Debugger actions ----

  handlers['SCRIPT_STEP'] = async (msg) => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    const result = await bridgeClient.stepScript(msg.scriptId || msg.id, msg.clearAll || false);
    return { success: true, ...result };
  };

  handlers['SCRIPT_SET_BREAKPOINT'] = async (msg) => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    const result = await bridgeClient.setBreakpoint(msg.scriptId || msg.id, msg.name, msg.active);
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
        const scriptName = msg.scriptPath.split(/[/\\]/).pop().replace(/\.(mjs|js)$/, '');
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
    const scheduleId = msg.scheduleId || msg.id;
    const { scheduleId: _sid, id: _id, type: _type, ...updates } = msg;
    return { success: true, ...(await bridgeClient.updateSchedule(scheduleId, updates)) };
  };
  handlers['SCHEDULE_DELETE'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };
    return { success: true, ...(await bridgeClient.deleteSchedule(msg.scheduleId || msg.id)) };
  };
  handlers['SCHEDULE_LIST'] = async () => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge', schedules: [] };
    return { success: true, ...(await bridgeClient.listSchedules()) };
  };
  handlers['SCHEDULE_TRIGGER'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };
    return { success: true, ...(await bridgeClient.triggerSchedule(msg.scheduleId || msg.id)) };
  };
  handlers['SCHEDULE_HISTORY'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };
    return { success: true, ...(await bridgeClient.scheduleHistory(msg.scheduleId || msg.id)) };
  };

  // ---- Run Plans ----
  handlers['RUN_PLAN_LIST'] = async () => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge', plans: [] };
    return { success: true, ...(await bridgeClient.listRunPlans()) };
  };
  handlers['RUN_PLAN_GET'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };
    return { success: true, ...(await bridgeClient.getRunPlan(msg.id)) };
  };
  handlers['RUN_PLAN_SAVE'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };
    // Strip handler-routing fields (type) before forwarding payload to bridge
    const { type, ...plan } = msg;
    return { success: true, ...(await bridgeClient.saveRunPlan(plan)) };
  };
  handlers['RUN_PLAN_DELETE'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };
    return { success: true, ...(await bridgeClient.deleteRunPlan(msg.id)) };
  };
  handlers['RUN_PLAN_EXECUTE'] = async (msg) => {
    if (!bridgeClient.isConnected()) return { success: false, error: 'Not connected to bridge' };
    return { success: true, ...(await bridgeClient.executeRunPlan(msg.id)) };
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
    // Derive name from filename (handle both / and \ separators)
    const name = scriptPath.split(/[/\\]/).pop().replace(/\.(mjs|js)$/, '');
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
    // Create initial version snapshot
    try {
      await addVersion(name, source, scriptPath);
    } catch (err) {
      console.warn('[ScriptHandlers] Version save failed (non-fatal):', err.message);
    }
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
      recipeId: sanitizeRecipeId(s.recipeId),
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
    const { name, source: rawSource, recipe, recipeId: newRecipeId } = msg;
    if (!name || !rawSource) return { success: false, error: 'name and source required' };
    const lib = await getLibrary();
    // If script doesn't exist yet (Save As), create a new entry
    if (!lib[name]) {
      lib[name] = {
        name,
        importedAt: Date.now(),
      };
    }
    const entry = lib[name];
    // Auto-upsert shim import
    const shimPath = bridgeClient.getShimPath();
    const source = upsertShimImport(rawSource, shimPath);
    entry.source = source;
    entry.modifiedAt = Date.now();
    entry.size = source.length;
    // Persist recipe if provided (legacy embedded recipe)
    if (recipe !== undefined) {
      entry.recipe = recipe;
    }
    // Persist recipeId if provided
    if (newRecipeId !== undefined) {
      entry.recipeId = sanitizeRecipeId(newRecipeId);
    }
    await saveLibrary(lib);
    // Create version snapshot
    try {
      await addVersion(name, source, entry.originalPath);
    } catch (err) {
      console.warn('[ScriptHandlers] Version save failed (non-fatal):', err.message);
    }
    // Sync to disk via bridge
    if (bridgeClient.isConnected()) {
      try {
        await bridgeClient.saveScript(name, source);
      } catch (err) {
        console.warn('[ScriptHandlers] Sync to disk failed (non-fatal):', err.message);
      }
    }
    return { success: true, script: entry };
  };

  handlers['SCRIPT_LIBRARY_REMOVE'] = async (msg) => {
    const lib = await getLibrary();
    if (!lib[msg.name]) return { success: false, error: 'Script not found' };
    delete lib[msg.name];
    await saveLibrary(lib);
    return { success: true };
  };

  handlers['SCRIPT_LIBRARY_UPDATE'] = async (msg) => {
    const { name, recipeId } = msg;
    if (!name) return { success: false, error: 'name required' };
    const lib = await getLibrary();
    const entry = lib[name];
    if (!entry) return { success: false, error: 'Script not found in library' };
    if (recipeId !== undefined) {
      entry.recipeId = sanitizeRecipeId(recipeId);
    }
    entry.modifiedAt = Date.now();
    await saveLibrary(lib);
    return { success: true, script: entry };
  };

  // ---- Script Run Archive (IndexedDB via DS_ADD/DS_FETCH) ----

  handlers['SCRIPT_RUN_SAVE'] = async (msg) => {
    const { run, artifacts } = msg;
    if (!run || !run.scriptId) return { success: false, error: 'run with scriptId required' };

    // Store run record directly via dsAdd (avoids chrome.runtime.sendMessage self-messaging which fails in MV3 SW)
    try {
      const resp = await dsAdd({ dataSource: 'ScriptRuns', data: run });
      if (resp.status !== 0) console.warn('[ScriptHandlers] Failed to save run record:', resp.data);
    } catch (err) {
      console.warn('[ScriptHandlers] Failed to save run record:', err.message);
    }

    // Store each artifact directly via dsAdd
    if (Array.isArray(artifacts)) {
      for (const artifact of artifacts) {
        try {
          const resp = await dsAdd({
            dataSource: 'ScriptArtifacts',
            data: {
              runId: run.scriptId,
              type: artifact.type,
              timestamp: artifact.timestamp,
              label: artifact.label || '',
              data: artifact.data || null,
              diskPath: artifact.diskPath || null,
              size: artifact.size || 0,
              contentType: artifact.contentType || 'application/octet-stream',
            },
          });
          if (resp.status !== 0) console.warn('[ScriptHandlers] Failed to save artifact:', resp.data);
        } catch (err) {
          console.warn('[ScriptHandlers] Failed to save artifact:', err.message);
        }
      }
    }

    return { success: true };
  };

  handlers['SCRIPT_RUN_LIST'] = async () => {
    try {
      const resp = await dsFetch({ dataSource: 'ScriptRuns', criteria: {} });
      const runs = (resp && resp.status === 0 && Array.isArray(resp.data)) ? resp.data : [];
      runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
      return { success: true, runs };
    } catch (err) {
      return { success: false, error: err.message, runs: [] };
    }
  };

  handlers['SCRIPT_RUN_GET'] = async (msg) => {
    const { scriptId } = msg;
    if (!scriptId) return { success: false, error: 'scriptId required' };

    // Fetch artifacts for this run directly via dsFetch
    try {
      const resp = await dsFetch({ dataSource: 'ScriptArtifacts', criteria: { runId: scriptId } });
      const artifacts = (resp && resp.status === 0 && Array.isArray(resp.data)) ? resp.data : [];
      artifacts.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      return { success: true, artifacts };
    } catch (err) {
      return { success: false, error: err.message, artifacts: [] };
    }
  };

  handlers['SCRIPT_ADD_ARTIFACT'] = async (msg) => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    const { scriptId, artifact } = msg;
    if (!scriptId || !artifact) return { success: false, error: 'scriptId and artifact required' };
    return bridgeClient.addScriptArtifact(scriptId, artifact);
  };

  handlers['SCRIPT_ARTIFACT_GET'] = async (msg) => {
    const { id: artifactId, diskPath } = msg;

    // If diskPath provided, load from bridge server
    if (diskPath) {
      if (!bridgeClient.isConnected()) {
        return { success: false, error: 'Not connected to bridge (needed for disk artifacts)' };
      }
      try {
        const result = await bridgeClient.getArtifact(diskPath);
        return { success: true, data: result.data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    // Otherwise load from IndexedDB by id directly via dsFetch
    if (artifactId != null) {
      try {
        const resp = await dsFetch({ dataSource: 'ScriptArtifacts', criteria: { id: artifactId } });
        const artifacts = (resp && resp.status === 0 && Array.isArray(resp.data)) ? resp.data : [];
        if (artifacts.length === 0) return { success: false, error: 'Artifact not found' };
        return { success: true, data: artifacts[0].data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    return { success: false, error: 'id or diskPath required' };
  };

  // ---- Script Versions (chrome.storage.local) ----

  handlers['SCRIPT_VERSION_LIST'] = async (msg) => {
    const versions = await getVersions();
    let filtered = versions;
    if (msg.scriptName) {
      filtered = versions.filter(v => v.scriptName === msg.scriptName);
    }
    // Return metadata only (no source), sorted by modifiedAt desc
    const result = filtered
      .map(v => ({ scriptName: v.scriptName, modifiedAt: v.modifiedAt, size: v.size }))
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { success: true, versions: result };
  };

  handlers['SCRIPT_VERSION_GET'] = async (msg) => {
    const { scriptName, modifiedAt } = msg;
    if (!scriptName || !modifiedAt) return { success: false, error: 'scriptName and modifiedAt required' };
    const versions = await getVersions();
    const version = versions.find(v => v.scriptName === scriptName && v.modifiedAt === modifiedAt);
    if (!version) return { success: false, error: 'Version not found' };
    return { success: true, version: { scriptName: version.scriptName, modifiedAt: version.modifiedAt, source: version.source, size: version.size } };
  };
}
