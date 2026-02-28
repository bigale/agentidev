/**
 * Automation reasoning message handler.
 * Extracted from background.js lines 422-428, 1710-1832.
 */
import * as bridgeClient from '../bridge-client.js';
import { AutomationReasoner } from '../automation-reasoning.js';
import { state } from '../init-state.js';
import { handleSnapshotStorage } from './snapshot-handlers.js';

const automationReasoner = new AutomationReasoner();

async function handleAutomationReason(intent, sessionId) {
  console.log(`[Automation] Reasoning for: "${intent}" on session ${sessionId}`);

  if (!state.llmReady) {
    console.warn('[Automation] LLM not ready, cannot generate commands');
    return {
      commands: [],
      message: 'Gemini Nano not available. Cannot generate automation commands.',
      intent,
      sessionId,
    };
  }

  try {
    // Step 1: Take current snapshot for context
    let currentSnapshot = null;
    let currentUrl = null;
    if (bridgeClient.isConnected() && sessionId) {
      try {
        const snapResult = await bridgeClient.takeSnapshot(sessionId);
        currentSnapshot = snapResult.yaml;
        currentUrl = snapResult.url;
      } catch (err) {
        console.warn('[Automation] Could not take snapshot:', err.message);
      }
    }

    // Step 2: Generate commands from intent
    const result = await automationReasoner.generateCommands(intent, currentUrl, currentSnapshot);

    if (!result.commands || result.commands.length === 0) {
      return {
        commands: [],
        message: result.reasoning || 'No commands generated for this intent.',
        intent,
        sessionId,
        metadata: result.metadata,
      };
    }

    // Step 3: Execute commands sequentially via bridge
    const executionResults = [];
    if (bridgeClient.isConnected() && sessionId) {
      for (const cmd of result.commands) {
        try {
          let cmdResult;
          switch (cmd.type) {
            case 'click':
              cmdResult = await bridgeClient.clickRef(sessionId, cmd.ref);
              break;
            case 'fill':
              cmdResult = await bridgeClient.fillRef(sessionId, cmd.ref, cmd.value);
              break;
            case 'goto':
              cmdResult = await bridgeClient.navigateSession(sessionId, cmd.url);
              break;
            case 'snapshot':
              cmdResult = await bridgeClient.takeSnapshot(sessionId);
              break;
            case 'evaluate':
              cmdResult = await bridgeClient.evalInSession(sessionId, cmd.expr);
              break;
            default:
              cmdResult = await bridgeClient.sendCommand(sessionId, `${cmd.type} ${cmd.ref || cmd.url || cmd.value || ''}`);
          }
          executionResults.push({ cmd, success: true, output: cmdResult });
        } catch (err) {
          executionResults.push({ cmd, success: false, error: err.message });
          console.warn(`[Automation] Command failed: ${cmd.type}`, err.message);
          break;
        }
      }
    }

    // Step 4: Verify result
    let verification = null;
    if (bridgeClient.isConnected() && sessionId && executionResults.length > 0) {
      try {
        const postSnapshot = await bridgeClient.takeSnapshot(sessionId);
        if (postSnapshot.yaml) {
          verification = await automationReasoner.verifyResult(
            result.expectedOutcome,
            postSnapshot.yaml
          );
          await handleSnapshotStorage(sessionId, postSnapshot.yaml, postSnapshot.url);
        }
      } catch (err) {
        console.warn('[Automation] Verification failed:', err.message);
      }
    }

    return {
      commands: result.commands,
      executionResults,
      expectedOutcome: result.expectedOutcome,
      reasoning: result.reasoning,
      verification,
      intent,
      sessionId,
      metadata: result.metadata,
    };
  } catch (error) {
    console.error('[Automation] Reasoning failed:', error);
    return { commands: [], message: `Reasoning error: ${error.message}`, intent, sessionId };
  }
}

export function register(handlers) {
  handlers['AUTOMATION_REASON'] = async (msg) => {
    return await handleAutomationReason(msg.intent, msg.sessionId);
  };
}
