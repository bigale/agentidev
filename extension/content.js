/**
 * Content Script for Contextual Recall
 *
 * Injected into all pages to capture content
 *
 * Responsibilities:
 * - Extract page content (text, HTML, metadata)
 * - Detect content type for classification
 * - Send to background worker for processing
 */

console.log('Contextual Recall: Content script loaded');

// Listen for messages from extension (for extraction mode and agent workflows)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_PAGE_CONTENT') {
    // Get page content for extraction
    const content = getPageContent();
    sendResponse(content);
    return true; // Async response
  }

  if (message.type === 'EXTRACT_PAGE_DATA') {
    // Extract structured data from specific page types
    const data = extractPageData(message.extractor);
    sendResponse({ data });
    return true;
  }

  if (message.type === 'EXTRACT_FORM_FIELDS') {
    // Extract form field structure
    const fields = extractFormFieldsFromPage();
    sendResponse({ fields });
    return true;
  }

  if (message.type === 'FILL_FORM_FIELDS') {
    // Fill form with provided data
    const result = fillFormWithData(message.mapping);
    sendResponse(result);
    return true;
  }
});

// Wait for page to be fully loaded
if (document.readyState === 'complete') {
  capturePage();
} else {
  window.addEventListener('load', capturePage);
}

function capturePage() {
  // Check if we should capture this page
  chrome.storage.local.get(['captureEnabled', 'excludedDomains'], (settings) => {
    if (!settings.captureEnabled) {
      return;
    }

    // Check if domain is excluded
    const hostname = window.location.hostname;
    if (settings.excludedDomains && settings.excludedDomains.includes(hostname)) {
      console.log('Domain excluded:', hostname);
      return;
    }

    // Extract page content
    const pageData = {
      url: window.location.href,
      title: document.title,
      html: document.documentElement.outerHTML,
      text: document.body.innerText,
      timestamp: new Date().toISOString(),
      metadata: {
        domain: hostname,
        path: window.location.pathname,
        hasTable: document.querySelector('table') !== null,
        hasCode: document.querySelector('pre, code') !== null,
        hasForms: document.querySelector('form') !== null
      }
    };

    // Send to background worker
    chrome.runtime.sendMessage({
      type: 'CAPTURE_PAGE',
      data: pageData
    }, (response) => {
      if (response && response.success) {
        console.log('Page captured successfully');
      }
    });
  });
}

/**
 * Get page content for extraction (cleaner version without scripts/styles)
 */
function getPageContent() {
  // Clone the document to avoid modifying the page
  const clone = document.documentElement.cloneNode(true);

  // Remove unwanted elements
  const unwantedSelectors = [
    'script',
    'style',
    'noscript',
    'iframe',
    'svg',
    '.ad', '.ads', '.advertisement',
    '#ad', '#ads',
    '[id*="cookie"]',
    '[class*="cookie"]',
    'header nav',
    'footer'
  ];

  unwantedSelectors.forEach(selector => {
    try {
      const elements = clone.querySelectorAll(selector);
      elements.forEach(el => el.remove());
    } catch (e) {
      // Ignore selector errors
    }
  });

  // Get clean HTML
  const cleanHTML = clone.outerHTML;

  // Get visible text
  const visibleText = document.body.innerText;

  return {
    url: window.location.href,
    title: document.title,
    html: cleanHTML,
    text: visibleText,
    timestamp: new Date().toISOString(),
    metadata: {
      domain: window.location.hostname,
      path: window.location.pathname,
      hasTable: document.querySelector('table') !== null,
      hasList: document.querySelector('ul, ol') !== null,
      itemCount: estimateItemCount()
    }
  };
}

/**
 * Estimate number of items on page (for progress indication)
 */
function estimateItemCount() {
  // Count common item containers
  const selectors = [
    'article',
    '[class*="product"]',
    '[class*="item"]',
    '[class*="card"]',
    '[class*="listing"]',
    '[class*="result"]',
    'li'
  ];

  let maxCount = 0;

  selectors.forEach(selector => {
    try {
      const count = document.querySelectorAll(selector).length;
      if (count > maxCount && count < 1000) {
        // Ignore if too many (probably not actual items)
        maxCount = count;
      }
    } catch (e) {
      // Ignore selector errors
    }
  });

  return maxCount;
}

/**
 * Extract structured data from specific page types
 * @param {string} extractor - Type of extractor to use
 * @returns {Object} Extracted data
 */
function extractPageData(extractor) {
  console.log('[Content] Extracting data with extractor:', extractor);

  if (extractor === 'google_personal_info') {
    return extractGooglePersonalInfo();
  }

  return null;
}

/**
 * Extract personal info from Google Account page
 * @returns {Object} Personal information
 */
function extractGooglePersonalInfo() {
  const data = {};

  try {
    // Google account page structure (as of 2024/2025)
    // Try multiple selectors as Google's structure changes

    // Name
    const nameElement = document.querySelector('[data-profile-identifier="NAME"]') ||
                       document.querySelector('[aria-label*="Name"]') ||
                       document.querySelector('input[aria-label*="name" i]');
    if (nameElement) {
      data.name = nameElement.value || nameElement.textContent?.trim() || '';
    }

    // Email - try to find from the page
    const emailElement = document.querySelector('[data-profile-identifier="EMAIL"]') ||
                        document.querySelector('[type="email"]') ||
                        document.querySelector('[aria-label*="Email"]');
    if (emailElement) {
      data.email = emailElement.value || emailElement.textContent?.trim() || '';
    }

    // Phone
    const phoneElement = document.querySelector('[data-profile-identifier="PHONE"]') ||
                        document.querySelector('[type="tel"]') ||
                        document.querySelector('[aria-label*="Phone"]');
    if (phoneElement) {
      data.phone = phoneElement.value || phoneElement.textContent?.trim() || '';
    }

    // Address - Google might not show full address on personal info page
    const addressElement = document.querySelector('[data-profile-identifier="ADDRESS"]') ||
                          document.querySelector('[aria-label*="Address"]');
    if (addressElement) {
      data.address = addressElement.value || addressElement.textContent?.trim() || '';
    }

    // Fallback: extract from visible text content
    if (!data.name || !data.email) {
      const textContent = document.body.innerText;

      // Look for email pattern
      if (!data.email) {
        const emailMatch = textContent.match(/[\w\.-]+@[\w\.-]+\.\w+/);
        if (emailMatch) {
          data.email = emailMatch[0];
        }
      }

      // Look for phone pattern
      if (!data.phone) {
        const phoneMatch = textContent.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
        if (phoneMatch) {
          data.phone = phoneMatch[0];
        }
      }
    }

    console.log('[Content] Extracted Google data:', data);
  } catch (error) {
    console.error('[Content] Error extracting Google data:', error);
  }

  return data;
}

/**
 * Extract form fields from the current page
 * @returns {Object} Map of field identifiers to field info
 */
function extractFormFieldsFromPage() {
  const fields = {};

  try {
    // Find all input, select, and textarea elements
    const inputs = document.querySelectorAll('input, select, textarea');

    inputs.forEach((input, index) => {
      // Skip hidden, submit, button fields
      if (input.type === 'hidden' || input.type === 'submit' || input.type === 'button') {
        return;
      }

      // Get identifier (prefer id, then name, then generate one)
      const id = input.id || input.name || `field_${index}`;

      // Get label text
      let label = '';
      if (input.id) {
        const labelEl = document.querySelector(`label[for="${input.id}"]`);
        if (labelEl) {
          label = labelEl.textContent?.trim() || '';
        }
      }

      // If no label found, try to find nearby text
      if (!label) {
        label = input.placeholder || input.getAttribute('aria-label') || input.name || '';
      }

      // Store field info
      fields[id] = {
        type: input.type || input.tagName.toLowerCase(),
        name: input.name || '',
        label: label,
        placeholder: input.placeholder || '',
        value: input.value || '',
        required: input.required || false,
        selector: getUniqueSelector(input)
      };
    });

    console.log('[Content] Extracted form fields:', Object.keys(fields).length);
  } catch (error) {
    console.error('[Content] Error extracting form fields:', error);
  }

  return fields;
}

/**
 * Get a unique selector for an element
 * @param {Element} element - DOM element
 * @returns {string} CSS selector
 */
function getUniqueSelector(element) {
  if (element.id) {
    return `#${element.id}`;
  }

  if (element.name) {
    return `[name="${element.name}"]`;
  }

  // Fallback: tag + index
  const tag = element.tagName.toLowerCase();
  const parent = element.parentElement;
  if (parent) {
    const siblings = Array.from(parent.querySelectorAll(tag));
    const index = siblings.indexOf(element);
    return `${tag}:nth-of-type(${index + 1})`;
  }

  return tag;
}

/**
 * Fill form fields with provided mapping
 * @param {Object} mapping - Map of selectors/ids to values
 * @returns {Object} Result with success status and count
 */
function fillFormWithData(mapping) {
  let fieldsFilled = 0;
  const errors = [];

  try {
    console.log('[Content] Filling form with', Object.keys(mapping).length, 'mappings');

    for (const [identifier, value] of Object.entries(mapping)) {
      try {
        // Try to find element by id, name, or selector
        let element = document.getElementById(identifier) ||
                     document.querySelector(`[name="${identifier}"]`) ||
                     document.querySelector(identifier);

        if (element) {
          // Set value based on element type
          if (element.tagName === 'SELECT') {
            // For select elements, try to find matching option
            const options = Array.from(element.options);
            const matchingOption = options.find(opt =>
              opt.value === value || opt.text === value
            );
            if (matchingOption) {
              element.value = matchingOption.value;
              fieldsFilled++;
            }
          } else if (element.type === 'checkbox' || element.type === 'radio') {
            // For checkboxes/radios
            element.checked = !!value;
            fieldsFilled++;
          } else {
            // For text inputs, textareas, etc.
            element.value = value;

            // Trigger input event for React/Vue forms
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));

            fieldsFilled++;
          }

          console.log('[Content] Filled field:', identifier, '=', value);
        } else {
          console.warn('[Content] Field not found:', identifier);
          errors.push(`Field not found: ${identifier}`);
        }
      } catch (error) {
        console.error('[Content] Error filling field:', identifier, error);
        errors.push(`Error filling ${identifier}: ${error.message}`);
      }
    }

    console.log('[Content] Form fill complete:', fieldsFilled, 'fields filled');
  } catch (error) {
    console.error('[Content] Error in fillFormWithData:', error);
    return { success: false, fieldsFilled: 0, errors: [error.message] };
  }

  return {
    success: fieldsFilled > 0,
    fieldsFilled,
    errors: errors.length > 0 ? errors : undefined
  };
}
