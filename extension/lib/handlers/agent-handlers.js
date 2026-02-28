/**
 * Agent workflow message handlers.
 * Extracted from background.js lines 184-244, 1028-1377.
 */
import { checkAvailability, initSession, generateText } from '../chrome-prompt-api.js';
import { extractGooglePersonalInfo, extractFormFields, fillFormFields, findTabByUrl } from '../agent-workflows.js';
import { initEmbeddings, generateEmbedding, isInitialized } from '../embeddings.js';
import { indexDOM, searchDOM } from '../dom-indexer.js';
import { findElementByIntent } from '../semantic-finder.js';
import { fillFormWithGoogleData, executeFormFillWorkflow, fillFormWithData } from '../agent-workflow.js';
import { state } from '../init-state.js';

async function mapFieldsWithLLM(sourceData, formFields) {
  console.log('[Agent] Using Gemini Nano to map fields...');

  try {
    const prompt = `You are a form-filling assistant. Map the available data to the form fields.

Available data:
${JSON.stringify(sourceData, null, 2)}

Form fields to fill:
${Object.entries(formFields).map(([id, field]) =>
  `- ${id}: ${field.label || field.name || field.placeholder} (type: ${field.type})`
).join('\n')}

Instructions:
1. Match each form field to the appropriate data value
2. Handle field variations (e.g., "Full Name" vs "First Name"/"Last Name")
3. Format data appropriately (e.g., phone numbers)
4. Only map fields where you have data
5. Return ONLY a JSON object mapping field IDs to values

Required JSON format:
{
  "field_id_1": "value1",
  "field_id_2": "value2"
}

JSON output:`;

    const result = await generateText(prompt, { temperature: 0.1 });
    console.log('[Agent] LLM response:', result.substring(0, 200));

    let jsonText = result.trim();
    if (jsonText.startsWith('```json')) jsonText = jsonText.substring(7).trim();
    if (jsonText.startsWith('```')) jsonText = jsonText.substring(3).trim();
    if (jsonText.endsWith('```')) jsonText = jsonText.substring(0, jsonText.length - 3).trim();

    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonText = jsonMatch[0];

    const mapping = JSON.parse(jsonText);
    console.log('[Agent] Parsed mapping:', mapping);
    return mapping;
  } catch (error) {
    console.error('[Agent] Failed to map fields:', error);
    return null;
  }
}

async function handleAgentFormFill(sourceUrl, targetUrl) {
  console.log('[Agent] Starting form fill workflow');

  if (!state.llmReady) {
    console.log('[Agent] Gemini Nano not ready, attempting to initialize...');
    try {
      const apiAvailable = await checkAvailability();
      if (apiAvailable) {
        console.log('[Agent] Chrome Prompt API available, creating session...');
        state.llmReady = await initSession();
        if (!state.llmReady) return { success: false, error: 'Failed to initialize Gemini Nano. Please check console for details.' };
        console.log('[Agent] Gemini Nano initialized successfully');
      } else {
        return { success: false, error: 'Chrome Prompt API not available. Requires Chrome 138+ with flag enabled.' };
      }
    } catch (error) {
      console.error('[Agent] Initialization error:', error);
      return { success: false, error: `Initialization failed: ${error.message}` };
    }
  }

  try {
    const sourceTab = await findTabByUrl(sourceUrl);
    const targetTab = await findTabByUrl(targetUrl);

    if (!sourceTab) return { success: false, error: `Source tab not found. Please open ${sourceUrl}` };
    if (!targetTab) return { success: false, error: `Target tab not found. Please open ${targetUrl}` };

    const sourceData = await extractGooglePersonalInfo(sourceTab.id);
    if (!sourceData || Object.keys(sourceData).length === 0) {
      return { success: false, error: 'Could not extract data from source tab' };
    }

    const formFields = await extractFormFields(targetTab.id);
    if (!formFields || Object.keys(formFields).length === 0) {
      return { success: false, error: 'No form fields found in target tab' };
    }

    const mapping = await mapFieldsWithLLM(sourceData, formFields);
    if (!mapping) return { success: false, error: 'Failed to map fields' };

    const fillResult = await fillFormFields(targetTab.id, mapping);
    if (!fillResult) return { success: false, error: 'Failed to fill form' };

    await chrome.tabs.update(targetTab.id, { active: true });

    return {
      success: true,
      sourceData,
      fieldsMapped: Object.keys(mapping).length,
      fieldsFilled: fillResult.fieldsFilled || 0,
      message: `Successfully filled ${Object.keys(mapping).length} fields`
    };
  } catch (error) {
    console.error('[Agent] Workflow failed:', error);
    return { success: false, error: error.message };
  }
}

async function handleDOMIndexing(tabId) {
  console.log(`[DOM Index] Starting indexing for tab ${tabId}`);

  try {
    if (!state.embeddingsReady) {
      console.log('[DOM Index] Initializing embeddings...');
      state.embeddingsReady = await initEmbeddings();
      if (!state.embeddingsReady) throw new Error('Failed to initialize embeddings');
    }

    const response = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_DOM_STRUCTURE' });
    if (!response || !response.chunks) throw new Error('Failed to extract DOM structure');

    const domChunks = response.chunks;
    console.log(`[DOM Index] Extracted ${domChunks.length} DOM chunks`);

    const result = await indexDOM(tabId, domChunks);
    if (!result.success) throw new Error(result.error || 'Indexing failed');

    console.log(`[DOM Index] Successfully indexed ${result.count} elements in ${result.elapsed}ms`);
    return { success: true, count: result.count, elapsed: result.elapsed, collection: result.collection };
  } catch (error) {
    console.error('[DOM Index] Indexing failed:', error);
    return { success: false, error: error.message };
  }
}

async function handleDOMSearch(tabId, intent, options = {}) {
  console.log(`[DOM Search] Searching for "${intent}" in tab ${tabId}`);

  try {
    const results = await searchDOM(tabId, intent, options);
    console.log(`[DOM Search] Found ${results.length} matches`);

    if (options.highlight && results.length > 0) {
      await chrome.tabs.sendMessage(tabId, { type: 'HIGHLIGHT_ELEMENT', selector: results[0].selector });
    }
    return results;
  } catch (error) {
    console.error('[DOM Search] Search failed:', error);
    throw error;
  }
}

async function handleFindElement(tabId, intent, options = {}) {
  console.log(`[Find Element] Finding "${intent}" in tab ${tabId}`);

  try {
    if (!state.llmReady) {
      console.log('[Find Element] Gemini Nano not ready, attempting to initialize...');
      try {
        const apiAvailable = await checkAvailability();
        if (apiAvailable) state.llmReady = await initSession();
      } catch (error) {
        console.warn('[Find Element] LLM initialization failed, will use vector-only:', error.message);
      }
    }

    const result = await findElementByIntent(tabId, intent, { ...options, useLLM: state.llmReady });
    if (!result.success) return result;

    console.log(`[Find Element] Found element via ${result.method}`);

    if (options.highlight !== false) {
      await chrome.tabs.sendMessage(tabId, { type: 'HIGHLIGHT_ELEMENT', selector: result.selector });
    }
    return result;
  } catch (error) {
    console.error('[Find Element] Search failed:', error);
    return { success: false, error: error.message, intent };
  }
}

async function handleExecuteWorkflow(workflowType, targetTabId, options = {}) {
  console.log(`[Workflow] Executing ${workflowType} workflow on tab ${targetTabId}`);

  try {
    if (workflowType === 'fill_with_google_data') {
      return await fillFormWithGoogleData(targetTabId);
    } else if (workflowType === 'custom' && options.mapping) {
      return await executeFormFillWorkflow(options.sourceTabId, targetTabId, options.mapping, options);
    } else {
      return { success: false, error: `Unknown workflow type: ${workflowType}` };
    }
  } catch (error) {
    console.error('[Workflow] Execution failed:', error);
    return { success: false, error: error.message };
  }
}

async function handleFillFormWithData(data, targetTabId) {
  console.log('[Fill Form] Filling form with data on tab', targetTabId);

  try {
    return await fillFormWithData(data, targetTabId);
  } catch (error) {
    console.error('[Fill Form] Failed:', error);
    return { success: false, error: error.message };
  }
}

export function register(handlers) {
  handlers['AGENT_FILL_FORM'] = async (msg) => {
    return await handleAgentFormFill(msg.sourceUrl, msg.targetUrl);
  };

  handlers['INDEX_DOM'] = async (msg) => {
    return await handleDOMIndexing(msg.tabId);
  };

  handlers['SEARCH_DOM'] = async (msg) => {
    const results = await handleDOMSearch(msg.tabId, msg.intent, msg.options);
    return { results };
  };

  handlers['FIND_ELEMENT'] = async (msg) => {
    return await handleFindElement(msg.tabId, msg.intent, msg.options);
  };

  handlers['EXECUTE_WORKFLOW'] = async (msg) => {
    return await handleExecuteWorkflow(msg.workflowType, msg.targetTabId, msg.options);
  };

  handlers['FILL_FORM_WITH_DATA'] = async (msg) => {
    return await handleFillFormWithData(msg.data, msg.targetTabId);
  };
}
