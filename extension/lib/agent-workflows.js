/**
 * Agent Workflows
 *
 * Hard-coded workflows for reliable, repeatable browser automation tasks.
 * These are deterministic actions that the agent can combine with LLM intelligence.
 */

/**
 * Extract personal info from Google Account page
 * @param {number} tabId - Tab ID of Google account page
 * @returns {Promise<Object>} Extracted personal info
 */
export async function extractGooglePersonalInfo(tabId) {
  console.log('[Agent] Extracting Google personal info from tab', tabId);

  try {
    // Send message to content script to extract data
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'EXTRACT_PAGE_DATA',
      extractor: 'google_personal_info'
    });

    if (response && response.data) {
      console.log('[Agent] Extracted Google data:', response.data);
      return response.data;
    } else {
      console.warn('[Agent] No data extracted from Google page');
      return null;
    }
  } catch (error) {
    console.error('[Agent] Content script not responding:', error.message);

    // Try to inject content script programmatically
    console.log('[Agent] Attempting to inject content script...');
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      });

      console.log('[Agent] Content script injected, waiting 500ms...');
      await new Promise(resolve => setTimeout(resolve, 500));

      // Retry extraction
      console.log('[Agent] Retrying extraction...');
      const retryResponse = await chrome.tabs.sendMessage(tabId, {
        type: 'EXTRACT_PAGE_DATA',
        extractor: 'google_personal_info'
      });

      if (retryResponse && retryResponse.data) {
        console.log('[Agent] Extracted Google data after injection:', retryResponse.data);
        return retryResponse.data;
      }
    } catch (injectError) {
      console.error('[Agent] Failed to inject content script:', injectError);
      console.error('[Agent] This may be due to page CSP restrictions');
    }

    return null;
  }
}

/**
 * Extract form fields from a page
 * @param {number} tabId - Tab ID of page with form
 * @returns {Promise<Object>} Form field structure
 */
export async function extractFormFields(tabId) {
  console.log('[Agent] Extracting form fields from tab', tabId);

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'EXTRACT_FORM_FIELDS'
    });

    if (response && response.fields) {
      console.log('[Agent] Extracted form fields:', Object.keys(response.fields).length, 'fields');
      return response.fields;
    } else {
      console.warn('[Agent] No form fields found');
      return {};
    }
  } catch (error) {
    console.error('[Agent] Content script not responding:', error.message);

    // Try to inject content script programmatically
    console.log('[Agent] Attempting to inject content script...');
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      });

      console.log('[Agent] Content script injected, waiting 500ms...');
      await new Promise(resolve => setTimeout(resolve, 500));

      // Retry extraction
      console.log('[Agent] Retrying form field extraction...');
      const retryResponse = await chrome.tabs.sendMessage(tabId, {
        type: 'EXTRACT_FORM_FIELDS'
      });

      if (retryResponse && retryResponse.fields) {
        console.log('[Agent] Extracted form fields after injection:', Object.keys(retryResponse.fields).length, 'fields');
        return retryResponse.fields;
      }
    } catch (injectError) {
      console.error('[Agent] Failed to inject content script:', injectError);
    }

    return {};
  }
}

/**
 * Fill form fields in a page
 * @param {number} tabId - Tab ID of page with form
 * @param {Object} fieldMapping - Map of field IDs/names to values
 * @returns {Promise<boolean>} Success status
 */
export async function fillFormFields(tabId, fieldMapping) {
  console.log('[Agent] Filling form in tab', tabId);
  console.log('[Agent] Field mapping:', fieldMapping);

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'FILL_FORM_FIELDS',
      mapping: fieldMapping
    });

    if (response && response.success) {
      console.log('[Agent] Form filled successfully, fields filled:', response.fieldsFilled);
      return response;
    } else {
      console.warn('[Agent] Form fill had issues');
      return { success: false, fieldsFilled: 0 };
    }
  } catch (error) {
    console.error('[Agent] Content script not responding:', error.message);

    // Try to inject content script programmatically
    console.log('[Agent] Attempting to inject content script...');
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      });

      console.log('[Agent] Content script injected, waiting 500ms...');
      await new Promise(resolve => setTimeout(resolve, 500));

      // Retry fill
      console.log('[Agent] Retrying form fill...');
      const retryResponse = await chrome.tabs.sendMessage(tabId, {
        type: 'FILL_FORM_FIELDS',
        mapping: fieldMapping
      });

      if (retryResponse && retryResponse.success) {
        console.log('[Agent] Form filled successfully after injection, fields filled:', retryResponse.fieldsFilled);
        return retryResponse;
      }
    } catch (injectError) {
      console.error('[Agent] Failed to inject content script:', injectError);
    }

    return { success: false, fieldsFilled: 0 };
  }
}

/**
 * Find tab by URL pattern
 * @param {string} urlPattern - URL pattern to match
 * @returns {Promise<Object|null>} Tab object or null
 */
export async function findTabByUrl(urlPattern) {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find(t => t.url && t.url.includes(urlPattern));

  if (tab) {
    console.log('[Agent] Found tab:', tab.id, tab.url);
  } else {
    console.log('[Agent] No tab found matching:', urlPattern);
  }

  return tab || null;
}
