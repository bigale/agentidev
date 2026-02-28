/**
 * Script integration handlers (Phase 3).
 * Forwards pause/resume/cancel to bridge, provides script list.
 * Script progress broadcasts arrive via bridge-client callbacks.
 */
import * as bridgeClient from '../bridge-client.js';

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
    const result = await bridgeClient.cancelScript(msg.scriptId, msg.reason);
    return { success: true, ...result };
  };

  handlers['SCRIPT_LAUNCH'] = async (msg) => {
    if (!bridgeClient.isConnected()) {
      return { success: false, error: 'Not connected to bridge' };
    }
    const result = await bridgeClient.launchScript(msg.path, msg.args || []);
    return { success: true, ...result };
  };
}
