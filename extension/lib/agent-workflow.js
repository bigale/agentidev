/**
 * Agent Workflow Orchestrator
 *
 * Coordinates multi-step automation workflows:
 * 1. Extract data from source tab
 * 2. Find target form fields
 * 3. Map and fill fields
 * 4. Submit form
 *
 * Phase 2.0 MVP - Vector-only automation
 */

import { findElementByIntent } from './semantic-finder.js';

console.log('[Agent Workflow] Module loaded');

/**
 * Execute a form fill workflow
 *
 * @param {number} sourceTabId - Tab to extract data from (e.g., Google Account)
 * @param {number} targetTabId - Tab with form to fill
 * @param {Object} mapping - Data mapping { sourceField: targetIntent }
 * @param {Object} options - Workflow options
 * @returns {Promise<Object>} Workflow result
 */
export async function executeFormFillWorkflow(sourceTabId, targetTabId, mapping, options = {}) {
  const {
    highlightFields = true,
    confirmBeforeSubmit = true,
    submitAfterFill = false
  } = options;

  console.log('[Agent Workflow] Starting form fill workflow');
  console.log('[Agent Workflow] Source tab:', sourceTabId);
  console.log('[Agent Workflow] Target tab:', targetTabId);
  console.log('[Agent Workflow] Mapping:', mapping);

  const results = {
    success: false,
    extracted: {},
    filled: {},
    errors: [],
    steps: []
  };

  try {
    // Step 1: Extract data from source tab
    console.log('[Agent Workflow] Step 1: Extracting data from source');

    const extractResult = await chrome.tabs.sendMessage(sourceTabId, {
      type: 'EXTRACT_PAGE_DATA',
      extractor: mapping.extractor || 'google_personal_info'
    });

    if (!extractResult || !extractResult.data) {
      throw new Error('Failed to extract data from source tab');
    }

    results.extracted = extractResult.data;
    results.steps.push({
      step: 1,
      action: 'extract_data',
      success: true,
      data: extractResult.data
    });

    console.log('[Agent Workflow] Extracted data:', extractResult.data);

    // Step 2: Index target form DOM
    console.log('[Agent Workflow] Step 2: Indexing target form');

    const indexResult = await chrome.runtime.sendMessage({
      type: 'INDEX_DOM',
      tabId: targetTabId
    });

    if (!indexResult.success) {
      throw new Error('Failed to index target form');
    }

    results.steps.push({
      step: 2,
      action: 'index_form',
      success: true,
      count: indexResult.count
    });

    console.log('[Agent Workflow] Indexed', indexResult.count, 'elements');

    // Step 3: Map and fill fields
    console.log('[Agent Workflow] Step 3: Mapping and filling fields');

    const fieldMappings = mapping.fields || generateDefaultMapping(extractResult.data);
    const fillResults = [];

    for (const [sourceField, targetIntent] of Object.entries(fieldMappings)) {
      const value = extractResult.data[sourceField];

      if (!value) {
        console.warn('[Agent Workflow] No value for source field:', sourceField);
        continue;
      }

      console.log(`[Agent Workflow] Filling "${targetIntent}" with "${value}"`);

      try {
        // Find target field using semantic search
        const findResult = await findElementByIntent(targetTabId, targetIntent, {
          useLLM: true,
          highlightFields
        });

        if (!findResult.success) {
          console.error('[Agent Workflow] Field not found:', targetIntent);
          results.errors.push({
            field: targetIntent,
            error: findResult.error || 'Field not found'
          });
          fillResults.push({
            sourceField,
            targetIntent,
            success: false,
            error: findResult.error
          });
          continue;
        }

        console.log('[Agent Workflow] Found field:', findResult.selector);

        // Fill the field
        const fillResult = await chrome.tabs.sendMessage(targetTabId, {
          type: 'FILL_FIELD',
          selector: findResult.selector,
          value: value
        });

        if (fillResult.success) {
          results.filled[targetIntent] = value;
          fillResults.push({
            sourceField,
            targetIntent,
            selector: findResult.selector,
            value,
            success: true
          });
        } else {
          results.errors.push({
            field: targetIntent,
            error: fillResult.error
          });
          fillResults.push({
            sourceField,
            targetIntent,
            success: false,
            error: fillResult.error
          });
        }

      } catch (error) {
        console.error('[Agent Workflow] Error filling field:', targetIntent, error);
        results.errors.push({
          field: targetIntent,
          error: error.message
        });
        fillResults.push({
          sourceField,
          targetIntent,
          success: false,
          error: error.message
        });
      }
    }

    results.steps.push({
      step: 3,
      action: 'fill_fields',
      success: fillResults.filter(r => r.success).length > 0,
      filled: fillResults.filter(r => r.success).length,
      total: fillResults.length,
      results: fillResults
    });

    console.log('[Agent Workflow] Filled', fillResults.filter(r => r.success).length, '/', fillResults.length, 'fields');

    // Step 4: Submit form (optional)
    if (submitAfterFill) {
      console.log('[Agent Workflow] Step 4: Submitting form');

      const submitResult = await chrome.tabs.sendMessage(targetTabId, {
        type: 'SUBMIT_FORM',
        confirmFirst: confirmBeforeSubmit
      });

      results.steps.push({
        step: 4,
        action: 'submit_form',
        success: submitResult.success,
        error: submitResult.error
      });
    }

    // Overall success if at least one field was filled
    results.success = fillResults.some(r => r.success);

    return results;

  } catch (error) {
    console.error('[Agent Workflow] Workflow error:', error);
    results.errors.push({
      step: 'workflow',
      error: error.message
    });
    return results;
  }
}

/**
 * Generate default field mapping based on extracted data
 *
 * @param {Object} data - Extracted data
 * @returns {Object} Field mapping
 */
function generateDefaultMapping(data) {
  const mapping = {};

  // Map common fields
  if (data.name) {
    mapping.name = 'full name';
  }

  if (data.email) {
    mapping.email = 'email address';
  }

  if (data.phone) {
    mapping.phone = 'phone number';
  }

  if (data.address) {
    mapping.address = 'address';
  }

  console.log('[Agent Workflow] Generated default mapping:', mapping);

  return mapping;
}

/**
 * Execute a simple "fill form with Google data" workflow
 *
 * @param {number} targetTabId - Tab with form to fill
 * @returns {Promise<Object>} Workflow result
 */
export async function fillFormWithGoogleData(targetTabId) {
  console.log('[Agent Workflow] Starting "Fill form with Google data" workflow');

  // Find Google Account tab
  const googleTabs = await chrome.tabs.query({
    url: [
      'https://myaccount.google.com/*',
      'https://accounts.google.com/*'
    ]
  });

  if (googleTabs.length === 0) {
    return {
      success: false,
      error: 'No Google Account tab found. Please open myaccount.google.com first.'
    };
  }

  const sourceTabId = googleTabs[0].id;

  // Execute workflow with Google extractor
  return await executeFormFillWorkflow(sourceTabId, targetTabId, {
    extractor: 'google_personal_info',
    fields: {
      name: 'full name',
      email: 'email',
      phone: 'phone number',
      address: 'address'
    }
  });
}

/**
 * Simple workflow: Fill current tab's form with data from another source
 *
 * @param {Object} data - Data to fill
 * @param {number} targetTabId - Tab with form
 * @returns {Promise<Object>} Result
 */
export async function fillFormWithData(data, targetTabId) {
  console.log('[Agent Workflow] Filling form with provided data');

  const results = {
    success: false,
    filled: {},
    errors: []
  };

  try {
    // Index the form
    await chrome.runtime.sendMessage({
      type: 'INDEX_DOM',
      tabId: targetTabId
    });

    // Fill each field
    for (const [intent, value] of Object.entries(data)) {
      try {
        // Find field
        const findResult = await findElementByIntent(targetTabId, intent, {
          useLLM: true
        });

        if (!findResult.success) {
          results.errors.push({ field: intent, error: 'Field not found' });
          continue;
        }

        // Fill field
        const fillResult = await chrome.tabs.sendMessage(targetTabId, {
          type: 'FILL_FIELD',
          selector: findResult.selector,
          value: value
        });

        if (fillResult.success) {
          results.filled[intent] = value;
        } else {
          results.errors.push({ field: intent, error: fillResult.error });
        }

      } catch (error) {
        results.errors.push({ field: intent, error: error.message });
      }
    }

    results.success = Object.keys(results.filled).length > 0;

    return results;

  } catch (error) {
    console.error('[Agent Workflow] Error:', error);
    results.errors.push({ error: error.message });
    return results;
  }
}

/**
 * Parse natural language automation intent
 *
 * @param {string} intent - Natural language command
 * @returns {Object} Parsed intent
 */
export function parseAutomationIntent(intent) {
  const lower = intent.toLowerCase();

  // "Fill form with Google data"
  if (lower.includes('google') && (lower.includes('fill') || lower.includes('form'))) {
    return {
      type: 'fill_form',
      source: 'google',
      action: 'fillFormWithGoogleData'
    };
  }

  // "Fill email field with john@example.com"
  const fillMatch = lower.match(/fill\s+(.+?)\s+with\s+(.+)/);
  if (fillMatch) {
    return {
      type: 'fill_field',
      field: fillMatch[1],
      value: fillMatch[2]
    };
  }

  // "Click submit button"
  if (lower.includes('click')) {
    const target = lower.replace('click', '').trim();
    return {
      type: 'click',
      target
    };
  }

  // "Submit form"
  if (lower.includes('submit')) {
    return {
      type: 'submit'
    };
  }

  return {
    type: 'unknown',
    raw: intent
  };
}

console.log('[Agent Workflow] Module ready');
