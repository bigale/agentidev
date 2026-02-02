/**
 * Action Executor
 *
 * Safely executes DOM manipulation actions for browser automation.
 * Used by agent workflows to interact with web forms.
 *
 * Phase 2.0 MVP - Vector-only automation
 */

console.log('[Action Executor] Module loaded');

/**
 * Fill a form field with a value
 *
 * @param {string} selector - CSS selector for the field
 * @param {string|boolean} value - Value to fill
 * @param {Object} options - Fill options
 * @returns {Promise<Object>} Result with success status
 */
export async function fillField(selector, value, options = {}) {
  const {
    triggerEvents = true,
    highlight = true,
    highlightDuration = 500
  } = options;

  try {
    const element = document.querySelector(selector);

    if (!element) {
      console.error('[Action Executor] Field not found:', selector);
      return {
        success: false,
        error: `Field not found: ${selector}`,
        selector
      };
    }

    console.log('[Action Executor] Filling field:', selector, '=', value);

    // Highlight before filling (visual feedback)
    if (highlight) {
      highlightElement(element, highlightDuration);
    }

    // Handle different field types
    if (element.tagName === 'SELECT') {
      await selectOption(element, value);
    } else if (element.type === 'checkbox') {
      element.checked = !!value;
    } else if (element.type === 'radio') {
      if (value) {
        element.checked = true;
      }
    } else if (element.type === 'file') {
      // File inputs can't be set programmatically for security reasons
      return {
        success: false,
        error: 'File inputs cannot be filled programmatically',
        selector
      };
    } else {
      // Text inputs, textareas, etc.
      element.value = value;
    }

    // Trigger events for React/Vue frameworks
    if (triggerEvents) {
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      element.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    // Scroll into view
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    return {
      success: true,
      selector,
      value,
      elementType: element.tagName.toLowerCase(),
      inputType: element.type || null
    };

  } catch (error) {
    console.error('[Action Executor] Fill field error:', error);
    return {
      success: false,
      error: error.message,
      selector
    };
  }
}

/**
 * Select an option in a dropdown
 *
 * @param {HTMLSelectElement} selectElement - The select element
 * @param {string} value - Value or text to select
 */
async function selectOption(selectElement, value) {
  const options = Array.from(selectElement.options);

  // Strategy 1: Exact value match
  let match = options.find(opt => opt.value === value);

  // Strategy 2: Exact text match (case-insensitive)
  if (!match) {
    const valueLower = value.toLowerCase();
    match = options.find(opt => opt.text.toLowerCase() === valueLower);
  }

  // Strategy 3: Fuzzy text match (contains)
  if (!match) {
    const valueLower = value.toLowerCase();
    match = options.find(opt => opt.text.toLowerCase().includes(valueLower));
  }

  // Strategy 4: Try numeric value
  if (!match && !isNaN(value)) {
    match = options.find(opt => opt.value === String(value));
  }

  if (match) {
    selectElement.value = match.value;
    console.log('[Action Executor] Selected option:', match.text);
  } else {
    console.warn('[Action Executor] No matching option found for:', value);
    console.log('[Action Executor] Available options:', options.map(o => ({ value: o.value, text: o.text })));
    throw new Error(`Option not found: ${value}`);
  }
}

/**
 * Click an element (button, link, etc.)
 *
 * @param {string} selector - CSS selector for the element
 * @param {Object} options - Click options
 * @returns {Promise<Object>} Result with success status
 */
export async function clickElement(selector, options = {}) {
  const {
    highlight = true,
    highlightDuration = 500,
    delay = 300 // Delay before clicking (for visual feedback)
  } = options;

  try {
    const element = document.querySelector(selector);

    if (!element) {
      console.error('[Action Executor] Element not found:', selector);
      return {
        success: false,
        error: `Element not found: ${selector}`,
        selector
      };
    }

    console.log('[Action Executor] Clicking element:', selector);

    // Scroll into view
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Highlight before clicking
    if (highlight) {
      highlightElement(element, highlightDuration + delay);
    }

    // Wait for highlight/scroll
    await new Promise(resolve => setTimeout(resolve, delay));

    // Click the element
    element.click();

    return {
      success: true,
      selector,
      elementType: element.tagName.toLowerCase(),
      elementText: element.textContent?.trim() || element.value || ''
    };

  } catch (error) {
    console.error('[Action Executor] Click error:', error);
    return {
      success: false,
      error: error.message,
      selector
    };
  }
}

/**
 * Submit a form
 *
 * @param {string} selector - CSS selector for the form or submit button
 * @param {Object} options - Submit options
 * @returns {Promise<Object>} Result with success status
 */
export async function submitForm(selector, options = {}) {
  const {
    confirmFirst = true,
    delay = 1000 // Delay before submitting (give user time to see)
  } = options;

  try {
    let element = document.querySelector(selector);

    if (!element) {
      // Try to find submit button in any form
      element = document.querySelector('button[type="submit"]') ||
                document.querySelector('input[type="submit"]');
    }

    if (!element) {
      console.error('[Action Executor] Submit element not found:', selector);
      return {
        success: false,
        error: `Submit element not found: ${selector}`,
        selector
      };
    }

    console.log('[Action Executor] Submitting form via:', selector);

    // Find the form
    const form = element.tagName === 'FORM' ? element : element.closest('form');

    if (!form) {
      console.warn('[Action Executor] No parent form found, clicking submit button instead');
      return await clickElement(selector, { delay });
    }

    // Highlight the form
    highlightElement(form, delay);

    // Optional confirmation
    if (confirmFirst) {
      const confirmed = confirm('Submit this form?');
      if (!confirmed) {
        return {
          success: false,
          error: 'User cancelled submission',
          selector
        };
      }
    }

    // Wait before submitting
    await new Promise(resolve => setTimeout(resolve, delay));

    // Submit the form
    form.submit();

    return {
      success: true,
      selector,
      formAction: form.action || window.location.href
    };

  } catch (error) {
    console.error('[Action Executor] Submit error:', error);
    return {
      success: false,
      error: error.message,
      selector
    };
  }
}

/**
 * Highlight an element for visual feedback
 *
 * @param {HTMLElement} element - Element to highlight
 * @param {number} duration - Highlight duration in ms
 */
function highlightElement(element, duration = 500) {
  const originalOutline = element.style.outline;
  const originalOutlineOffset = element.style.outlineOffset;
  const originalBackground = element.style.backgroundColor;

  // Apply highlight
  element.style.outline = '3px solid #FFD700';
  element.style.outlineOffset = '2px';
  element.style.backgroundColor = 'rgba(255, 215, 0, 0.1)';

  // Remove highlight after duration
  setTimeout(() => {
    element.style.outline = originalOutline;
    element.style.outlineOffset = originalOutlineOffset;
    element.style.backgroundColor = originalBackground;
  }, duration);
}

/**
 * Wait for an element to appear
 *
 * @param {string} selector - CSS selector
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<HTMLElement>} The element when it appears
 */
export async function waitForElement(selector, timeout = 5000) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const element = document.querySelector(selector);
    if (element) {
      console.log('[Action Executor] Element appeared:', selector);
      return element;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Element did not appear within ${timeout}ms: ${selector}`);
}

/**
 * Get current value of a field
 *
 * @param {string} selector - CSS selector
 * @returns {string|boolean|null} Current value
 */
export function getFieldValue(selector) {
  const element = document.querySelector(selector);

  if (!element) {
    return null;
  }

  if (element.type === 'checkbox' || element.type === 'radio') {
    return element.checked;
  }

  if (element.tagName === 'SELECT') {
    const selected = element.options[element.selectedIndex];
    return selected ? selected.text : null;
  }

  return element.value;
}

/**
 * Validate that required fields are filled
 *
 * @param {Array<string>} selectors - Array of required field selectors
 * @returns {Object} Validation result
 */
export function validateRequiredFields(selectors) {
  const missing = [];

  for (const selector of selectors) {
    const value = getFieldValue(selector);
    if (!value || (typeof value === 'string' && value.trim() === '')) {
      missing.push(selector);
    }
  }

  return {
    valid: missing.length === 0,
    missing
  };
}

console.log('[Action Executor] Module ready');
