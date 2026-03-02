/**
 * Automation Reasoning - Natural Language to Playwright Commands
 *
 * Uses Gemini Nano + cached page knowledge from the snapshot store
 * to generate playwright-cli command sequences from natural language intents.
 *
 * Flow:
 *   1. Retrieve stable patterns from snapshot store
 *   2. Retrieve relevant sections for the current intent
 *   3. Build prompt with system instructions + cached structure + current state + intent
 *   4. Token budget check (stable ~2000 tok, current ~1500 tok, answer ~768 tok)
 *   5. Call Gemini Nano (temperature 0.1)
 *   6. Parse output as JSON command array
 */

import { TokenBudgetManager } from './token-budget.js';
import { generateText, estimateTokens } from './chrome-prompt-api.js';
import { yamlSnapshotStore } from './yaml-snapshot-store.js';
import { generateEmbedding, isInitialized } from './embeddings.js';

export class AutomationReasoner {
  constructor() {
    this.tokenBudget = new TokenBudgetManager(6000, 768);
  }

  /**
   * Generate playwright-cli commands from a natural language intent
   * @param {string} intent - Natural language description (e.g., "select exacta bet type")
   * @param {string} currentUrl - Current page URL
   * @param {string} [currentSnapshot] - Current YAML snapshot (optional)
   * @returns {Promise<{commands, expectedOutcome, metadata}>}
   */
  async generateCommands(intent, currentUrl, currentSnapshot = null) {
    console.log(`[AutoReason] Generating commands for: "${intent}"`);

    // Reset budget for this request
    this.tokenBudget = new TokenBudgetManager(6000, 768);

    // 1. Retrieve stable patterns from snapshot store
    let stablePatterns = '';
    try {
      const stableResults = await this._searchSnapshots(intent, { stableOnly: true, limit: 3 });
      if (stableResults.length > 0) {
        stablePatterns = stableResults
          .map(r => `[${r.sectionType}] ${r.textDescription}\nYAML:\n${r.yamlText.substring(0, 500)}`)
          .join('\n---\n');
      }
    } catch (err) {
      console.warn('[AutoReason] Stable pattern retrieval failed:', err.message);
    }

    // 2. Retrieve relevant sections for this intent
    let relevantSections = '';
    try {
      const intentResults = await this._searchSnapshots(intent, { limit: 3 });
      if (intentResults.length > 0) {
        relevantSections = intentResults
          .map(r => `[${r.sectionType}] ${r.textDescription}\nYAML:\n${r.yamlText.substring(0, 500)}`)
          .join('\n---\n');
      }
    } catch (err) {
      console.warn('[AutoReason] Section retrieval failed:', err.message);
    }

    // 3. Build the current state section
    let currentState = '';
    if (currentSnapshot) {
      // Use only first 1500 chars to stay in budget
      currentState = currentSnapshot.substring(0, 1500);
    }

    // 4. Token budget check
    const stableTokens = await estimateTokens(stablePatterns);
    const sectionTokens = await estimateTokens(relevantSections);
    const stateTokens = await estimateTokens(currentState);

    this.tokenBudget.recordUsage(stableTokens + sectionTokens + stateTokens);

    if (!this.tokenBudget.canAfford(200)) {
      console.warn('[AutoReason] Budget exhausted, trimming context');
      // Trim the most expendable content
      stablePatterns = stablePatterns.substring(0, 500);
      currentState = currentState.substring(0, 500);
    }

    // 5. Build prompt
    const prompt = this._buildPrompt(intent, stablePatterns, relevantSections, currentState);

    // 6. Call Gemini Nano
    console.log(`[AutoReason] Generating with ${this.tokenBudget.getSummary().used}/${this.tokenBudget.getSummary().total} tokens used`);

    try {
      const rawOutput = await generateText(prompt, { temperature: 0.1 });
      const parsed = this._parseOutput(rawOutput);

      return {
        commands: parsed.commands,
        expectedOutcome: parsed.expectedOutcome || intent,
        reasoning: parsed.reasoning || '',
        metadata: {
          tokenBudget: this.tokenBudget.getSummary(),
          stablePatternsUsed: stablePatterns ? true : false,
          sectionsRetrieved: relevantSections ? true : false,
          rawOutput: rawOutput.substring(0, 500),
        },
      };
    } catch (err) {
      console.error('[AutoReason] Generation failed:', err);
      return {
        commands: [],
        expectedOutcome: intent,
        reasoning: `Error: ${err.message}`,
        metadata: { error: err.message },
      };
    }
  }

  /**
   * Verify if commands achieved the expected outcome
   * @param {string} expectedOutcome - What we expected to happen
   * @param {string} newSnapshot - Snapshot after executing commands
   * @returns {Promise<{success, details}>}
   */
  async verifyResult(expectedOutcome, newSnapshot) {
    const prompt = `You are verifying if a browser automation action succeeded.

Expected outcome: ${expectedOutcome}

Current page state (YAML snapshot):
${newSnapshot.substring(0, 2000)}

Did the action succeed? Respond with JSON:
{"success": true/false, "details": "explanation"}`;

    try {
      const rawOutput = await generateText(prompt, { temperature: 0.1 });
      return this._parseJSON(rawOutput) || { success: false, details: 'Could not verify' };
    } catch (err) {
      return { success: false, details: `Verification error: ${err.message}` };
    }
  }

  // --- Internal ---

  _buildPrompt(intent, stablePatterns, relevantSections, currentState) {
    const parts = [];

    parts.push(`You control a browser via playwright-cli commands. Given the user intent and current page state, output a JSON array of commands to execute.

Available commands:
- {"type": "click", "ref": "eNNN"} - Click an element by ref
- {"type": "fill", "ref": "eNNN", "value": "text"} - Fill input with text
- {"type": "goto", "url": "https://..."} - Navigate to URL
- {"type": "snapshot"} - Take accessibility snapshot
- {"type": "evaluate", "expr": "js code"} - Run JavaScript in page

Output format (JSON only, no markdown):
{"commands": [...], "expectedOutcome": "what should happen", "reasoning": "why these commands"}`);

    if (stablePatterns) {
      parts.push(`\nKnown page structure (stable patterns):\n${stablePatterns}`);
    }

    if (relevantSections) {
      parts.push(`\nRelevant page sections:\n${relevantSections}`);
    }

    if (currentState) {
      parts.push(`\nCurrent page state:\n${currentState}`);
    }

    parts.push(`\nUser intent: ${intent}\n\nJSON output:`);

    return parts.join('\n');
  }

  _parseOutput(rawOutput) {
    // Try to parse as JSON
    const parsed = this._parseJSON(rawOutput);
    if (parsed && Array.isArray(parsed.commands)) {
      return parsed;
    }
    if (parsed && Array.isArray(parsed)) {
      return { commands: parsed, expectedOutcome: '', reasoning: '' };
    }

    // Try to extract JSON from text
    const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const extracted = this._parseJSON(jsonMatch[0]);
      if (extracted) return extracted;
    }

    // Try array format
    const arrayMatch = rawOutput.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      const arr = this._parseJSON(arrayMatch[0]);
      if (arr) return { commands: arr, expectedOutcome: '', reasoning: '' };
    }

    console.warn('[AutoReason] Could not parse output:', rawOutput.substring(0, 200));
    return { commands: [], expectedOutcome: '', reasoning: rawOutput.substring(0, 200) };
  }

  _parseJSON(text) {
    try {
      // Clean up common LLM artifacts
      let cleaned = text.trim();
      if (cleaned.startsWith('```json')) cleaned = cleaned.substring(7);
      if (cleaned.startsWith('```')) cleaned = cleaned.substring(3);
      if (cleaned.endsWith('```')) cleaned = cleaned.substring(0, cleaned.length - 3);
      return JSON.parse(cleaned.trim());
    } catch {
      return null;
    }
  }

  async _searchSnapshots(query, options = {}) {
    if (!isInitialized()) return [];

    try {
      const embedding = await generateEmbedding(query);
      return await yamlSnapshotStore.search(embedding, {
        limit: options.limit || 3,
        stableOnly: options.stableOnly || false,
        threshold: 0.3,
      });
    } catch {
      return [];
    }
  }
}
