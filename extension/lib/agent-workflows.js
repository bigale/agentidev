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
    console.error('[Agent] Failed to extract Google data:', error);
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
    console.error('[Agent] Failed to extract form fields:', error);
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
      return true;
    } else {
      console.warn('[Agent] Form fill had issues');
      return false;
    }
  } catch (error) {
    console.error('[Agent] Failed to fill form:', error);
    return false;
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
