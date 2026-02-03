/**
 * Content Script for Contextual Recall
 *
 * Injected into all pages to capture content
 *
 * Responsibilities:
 * - Extract page content (text, HTML, metadata)
 * - Detect content type for classification
 * - Send to background worker for processing
 * - Execute automation actions (Phase 2.0 MVP)
 */

console.log('Contextual Recall: Content script loaded');

// Import action executor for automation (Phase 2.0 MVP)
let actionExecutor = null;
async function getActionExecutor() {
  if (!actionExecutor) {
    actionExecutor = await import('./lib/action-executor.js');
  }
  return actionExecutor;
}

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

  if (message.type === 'EXTRACT_DOM_STRUCTURE') {
    // Extract DOM structure for indexing
    const domChunks = extractDOMStructure();
    sendResponse({ chunks: domChunks });
    return true;
  }

  if (message.type === 'GET_PAGE_HTML') {
    // Get page HTML for grammar generation (Phase 2.1)
    const html = document.documentElement.outerHTML;
    sendResponse({ success: true, html });
    return true;
  }

  if (message.type === 'PARSE_FORM_WITH_GRAMMAR') {
    // Parse form with IXML grammar in content script context (Phase 2.1)
    // This must run here because dynamic imports work in content scripts but not service workers
    (async () => {
      try {
        console.log('[Content] PARSE_FORM_WITH_GRAMMAR - starting...');
        const { html, grammar, intent } = message;

        // Dynamic imports (OK in content script)
        console.log('[Content] Importing modules...');
        const grammarGen = await import('./lib/form-grammar-generator.js');
        const xmlParser = await import('./lib/form-xml-parser.js');
        const xpathFinder = await import('./lib/xpath-field-finder.js');
        const grammarDebugger = await import('./lib/grammar-debugger.js');
        console.log('[Content] Modules imported successfully');

        // Generate grammar if not provided
        let finalGrammar = grammar;
        let grammarCached = false;
        if (!finalGrammar) {
          console.log('[Content] Generating grammar...');
          const grammarResult = await grammarGen.generateFormGrammar(
            html || document.documentElement.outerHTML,
            window.location.href,
            { useCache: true }
          );
          finalGrammar = grammarResult.grammar;
          grammarCached = grammarResult.cached || false;
          console.log('[Content] Grammar generated:', grammarCached ? '(cached)' : '(fresh)');
          console.log('[Content] ==== GRAMMAR START ====');
          console.log(finalGrammar);
          console.log('[Content] ==== GRAMMAR END ====');
        }

        // Parse with grammar (with debug loop if enabled)
        console.log('[Content] Parsing HTML with grammar...');

        const htmlContent = html || document.documentElement.outerHTML;
        let parseResult = await xmlParser.parseFormWithFallback(htmlContent, finalGrammar);

        // If parsing failed and grammar was cached, try debugging
        if (!parseResult.success || parseResult.method === 'fallback') {
          console.log('[Content] Initial parse failed, attempting debug loop...');

          const debugResult = await grammarDebugger.debugLoopWithRetry(
            // Generator function
            async () => finalGrammar,
            // Parser function
            async (html, grammar) => xmlParser.parseFormWithFallback(html, grammar),
            // HTML to parse
            htmlContent,
            // Options
            {
              maxAttempts: 2,
              enableDebugging: !grammarCached // Only debug if not cached (avoid infinite loops)
            }
          );

          if (debugResult.success && debugResult.result) {
            console.log('[Content] ✓ Debug loop succeeded after', debugResult.attempts, 'attempts');
            parseResult = debugResult.result;
            parseResult.debugHistory = debugResult.debugHistory; // Attach debug history
            finalGrammar = debugResult.finalGrammar;

            // Log debug history
            if (debugResult.debugHistory.length > 0) {
              console.log('[Content] Debug history:');
              debugResult.debugHistory.forEach((entry, i) => {
                console.log(`  Attempt ${entry.attempt}: ${entry.problem}`);
                console.log(`  Fix: ${entry.fix}`);
              });
            }
          } else {
            console.log('[Content] ✗ Debug loop failed, using fallback result');
          }
        }

        console.log('[Content] Parse complete - method:', parseResult.method, 'success:', parseResult.success);

        if (!parseResult.success) {
          console.error('[Content] Parsing failed');
          sendResponse({ success: false, error: 'Parsing failed' });
          return;
        }

        // Get XML output if available (for debugging)
        let xmlOutput = null;
        if (parseResult.xmlDoc) {
          try {
            xmlOutput = new XMLSerializer().serializeToString(parseResult.xmlDoc);
          } catch (e) {
            console.warn('[Content] Failed to serialize XML:', e);
          }
        }

        // If we have XML doc, try XPath finding
        if (parseResult.xmlDoc && intent) {
          const xpathResult = xpathFinder.findFieldByXPath(parseResult.xmlDoc, intent);
          if (xpathResult.success) {
            sendResponse({
              success: true,
              method: 'xpath',
              selector: xpathResult.selector,
              confidence: xpathResult.confidence,
              parseMethod: parseResult.method,
              xmlOutput: xmlOutput
            });
            return;
          }
        }

        // Return parsed fields for further processing
        const fields = parseResult.xmlDoc
          ? xmlParser.extractFieldsFromXML(parseResult.xmlDoc)
          : parseResult.fields;

        sendResponse({
          success: true,
          method: 'fields',
          fields,
          parseMethod: parseResult.method,
          xmlOutput: xmlOutput,
          debugHistory: parseResult.debugHistory || [] // Include debug history if available
        });

      } catch (error) {
        console.error('[Content] Parse error:', error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // Async response
  }

  if (message.type === 'HIGHLIGHT_ELEMENT') {
    // Highlight an element (for visual feedback)
    highlightElement(message.selector);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'CLICK_ELEMENT') {
    // Click an element by selector
    const result = clickElement(message.selector);
    sendResponse(result);
    return true;
  }

  // Phase 2.0 MVP: Automation action handlers

  if (message.type === 'FILL_FIELD') {
    // Fill a form field using action executor
    (async () => {
      try {
        const executor = await getActionExecutor();
        const result = await executor.fillField(message.selector, message.value, message.options);
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // Async response
  }

  if (message.type === 'SUBMIT_FORM') {
    // Submit a form
    (async () => {
      try {
        const executor = await getActionExecutor();
        const result = await executor.submitForm(message.selector, message.options);
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true; // Async response
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

/**
 * Extract DOM structure for indexing
 * Returns chunks matching the format expected by dom-indexer.js
 */
function extractDOMStructure() {
  const chunks = [];

  // Helper: Generate unique selector
  function generateUniqueSelector(element) {
    if (element.id) {
      return `#${element.id}`;
    }
    if (element.dataset.testid) {
      return `[data-testid="${element.dataset.testid}"]`;
    }
    if (element.name) {
      return `[name="${element.name}"]`;
    }

    const path = [];
    let current = element;

    while (current && current !== document.body && path.length < 4) {
      let selector = current.tagName.toLowerCase();

      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).filter(c => c && !c.startsWith('_'));
        if (classes.length > 0 && classes.length < 3) {
          selector += '.' + classes.join('.');
        }
      }

      if (current.parentElement) {
        const siblings = Array.from(current.parentElement.children);
        const index = siblings.indexOf(current);
        if (siblings.filter(s => s.tagName === current.tagName).length > 1) {
          selector += `:nth-child(${index + 1})`;
        }
      }

      path.unshift(selector);
      current = current.parentElement;
    }

    return path.join(' > ');
  }

  // Helper: Get element text
  function getElementText(element) {
    // For select elements, DON'T use textContent (returns selected option text)
    // Instead, return empty and rely on findLabel() or name parsing
    if (element.tagName === 'SELECT') {
      const sources = [
        element.getAttribute('aria-label'),
        element.getAttribute('title')
      ];

      for (const source of sources) {
        if (source && source.length > 0 && source.length < 200) {
          return source.substring(0, 200);
        }
      }

      return ''; // Let findLabel() or parseNameForLabel() handle it
    }

    // For other elements, use normal priority
    const sources = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.getAttribute('placeholder'),
      element.getAttribute('alt'),
      element.textContent?.trim(),
      element.value
    ];

    for (const source of sources) {
      if (source && source.length > 0 && source.length < 200) {
        return source.substring(0, 200);
      }
    }

    return '';
  }

  // Helper: Get context breadcrumb
  function getElementContext(element) {
    const breadcrumbs = [];
    let current = element.parentElement;

    while (current && current !== document.body && breadcrumbs.length < 3) {
      const label = current.getAttribute('aria-label') ||
                    current.getAttribute('role') ||
                    current.querySelector('h1, h2, h3, h4, legend')?.textContent?.trim();

      if (label && label.length < 50) {
        breadcrumbs.unshift(label.substring(0, 50));
      }

      current = current.parentElement;
    }

    return breadcrumbs.join(' > ');
  }

  // Helper: Find label for form element
  function findLabel(element) {
    const elementName = element.getAttribute('name') || element.getAttribute('id') || element.tagName;

    // Try label[for=id]
    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) {
        const labelText = label.textContent?.trim();
        console.log('[findLabel] Found via label[for]:', elementName, '→', labelText);
        return labelText;
      }
    }

    // Try parent label
    const parentLabel = element.closest('label');
    if (parentLabel) {
      const labelText = parentLabel.textContent?.trim();
      console.log('[findLabel] Found via parent label:', elementName, '→', labelText);
      return labelText;
    }

    // Try previous sibling label/span
    let prev = element.previousElementSibling;
    if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN' || prev.tagName === 'DIV')) {
      const text = prev.textContent?.trim();
      if (text && text.length < 100) {
        console.log('[findLabel] Found via previous sibling:', elementName, '→', text);
        return text;
      }
    }

    // Try looking for nearby text (within parent container)
    const parent = element.parentElement;
    if (parent) {
      // Get all text nodes before this element
      const walker = document.createTreeWalker(
        parent,
        NodeFilter.SHOW_TEXT,
        null
      );

      let lastText = '';
      let node;
      while (node = walker.nextNode()) {
        if (node.parentNode === element) break; // Stop if we hit the element
        if (parent.contains(element) && node.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) {
          const text = node.textContent?.trim();
          if (text && text.length > 2 && text.length < 100) {
            lastText = text;
          }
        }
      }
      if (lastText) {
        console.log('[findLabel] Found via TreeWalker:', elementName, '→', lastText);
        return lastText;
      }
    }

    // Try parsing name attribute for hints
    const name = element.getAttribute('name') || element.getAttribute('id') || '';
    const nameHints = parseNameForLabel(name);
    if (nameHints) {
      console.log('[findLabel] Found via parseNameForLabel:', elementName, '→', nameHints);
      return nameHints;
    }

    console.log('[findLabel] No label found for:', elementName);
    return null;
  }

  // Helper: Parse name/id for semantic hints
  function parseNameForLabel(name) {
    if (!name) return null;

    console.log('[parseNameForLabel] Parsing:', name);

    const lower = name.toLowerCase();

    // Date of birth patterns
    if (lower.includes('dob') || lower.includes('birth')) {
      if (lower.includes('dd') || lower.includes('day')) {
        console.log('[parseNameForLabel] Matched DOB Day pattern');
        return 'Date of Birth - Day';
      }
      if (lower.includes('mm') || lower.includes('month')) {
        console.log('[parseNameForLabel] Matched DOB Month pattern');
        return 'Date of Birth - Month';
      }
      if (lower.includes('yy') || lower.includes('year')) {
        console.log('[parseNameForLabel] Matched DOB Year pattern');
        return 'Date of Birth - Year';
      }
      if (lower.includes('pl') || lower.includes('place')) {
        console.log('[parseNameForLabel] Matched Birth Place pattern');
        return 'Birth Place';
      }
      console.log('[parseNameForLabel] Matched generic DOB pattern');
      return 'Date of Birth';
    }

    // Check if it's part of a DOB group by number prefix (e.g., "66mm", "67dd", "68yy" are DOB fields)
    const match = name.match(/^(\d{2})([a-z_]+)$/i);
    if (match) {
      const prefix = match[1];
      const suffix = match[2].toLowerCase();
      console.log('[parseNameForLabel] Matched numbered pattern - prefix:', prefix, 'suffix:', suffix);

      // Common DOB prefixes: 66, 67, 68 (seen in RoboForm)
      if (['66', '67', '68'].includes(prefix)) {
        console.log('[parseNameForLabel] Prefix is DOB-related (66/67/68)');
        if (suffix === 'mm' || suffix.includes('month')) {
          console.log('[parseNameForLabel] Matched DOB Month (numbered)');
          return 'Date of Birth - Month';
        }
        if (suffix === 'dd' || suffix.includes('day')) {
          console.log('[parseNameForLabel] Matched DOB Day (numbered)');
          return 'Date of Birth - Day';
        }
        if (suffix === 'yy' || suffix.includes('year')) {
          console.log('[parseNameForLabel] Matched DOB Year (numbered)');
          return 'Date of Birth - Year';
        }
      }
    }

    // Credit card patterns
    if (lower.includes('cc') || lower.includes('card') || lower.includes('exp')) {
      if (lower.includes('mm') || lower.includes('month')) return 'Card Expiration - Month';
      if (lower.includes('yy') || lower.includes('year')) return 'Card Expiration - Year';
      if (lower.includes('cvv') || lower.includes('cvc')) return 'Card CVV';
      if (lower.includes('num')) return 'Card Number';
      return 'Credit Card';
    }

    // Generic date patterns (not DOB or CC)
    if (lower.includes('dd') && !lower.includes('address')) return 'Day';
    if (lower.includes('mm') && !lower.includes('comm')) return 'Month';
    if (lower.includes('yy') || lower.includes('year')) return 'Year';

    console.log('[parseNameForLabel] No pattern matched');
    return null;
  }

  // Index interactive elements
  const interactiveElements = document.querySelectorAll(
    'button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"]'
  );

  interactiveElements.forEach((el, index) => {
    // Skip hidden elements
    if (el.offsetParent === null && el.tagName !== 'INPUT') {
      return;
    }

    const text = getElementText(el);
    const context = getElementContext(el);
    const label = (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')
      ? findLabel(el)
      : null;

    chunks.push({
      type: 'interactive',
      selector: generateUniqueSelector(el),
      tagName: el.tagName.toLowerCase(),
      text: text || '',
      label: label || '',
      context: context || '',
      attributes: {
        id: el.id || '',
        name: el.name || '',
        type: el.type || '',
        placeholder: el.placeholder || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        role: el.getAttribute('role') || '',
        href: el.href || '',
        className: el.className || ''
      },
      index: index
    });
  });

  // Index forms
  const forms = document.querySelectorAll('form');

  forms.forEach((form, index) => {
    const formName = form.name || form.id || `form-${index}`;
    const legend = form.querySelector('legend')?.textContent?.trim();
    const heading = form.querySelector('h1, h2, h3, h4')?.textContent?.trim();

    chunks.push({
      type: 'form',
      selector: generateUniqueSelector(form),
      tagName: 'form',
      text: legend || heading || formName,
      context: getElementContext(form),
      attributes: {
        name: form.name || '',
        id: form.id || '',
        action: form.action || '',
        method: form.method || ''
      },
      fieldCount: form.elements.length,
      index: chunks.length
    });
  });

  // Index headings and landmarks
  const landmarks = document.querySelectorAll(
    'h1, h2, h3, main, nav, aside, section[aria-label], [role="region"]'
  );

  landmarks.forEach((el, index) => {
    const text = getElementText(el);
    if (!text || text.length < 3) return;

    chunks.push({
      type: 'landmark',
      selector: generateUniqueSelector(el),
      tagName: el.tagName.toLowerCase(),
      text: text,
      context: getElementContext(el),
      attributes: {
        role: el.getAttribute('role') || '',
        ariaLabel: el.getAttribute('aria-label') || ''
      },
      index: chunks.length
    });
  });

  console.log('[Content] Extracted', chunks.length, 'DOM chunks');
  return chunks;
}

/**
 * Highlight an element for visual feedback
 */
function highlightElement(selector) {
  try {
    const element = document.querySelector(selector);
    if (!element) {
      console.warn('[Content] Element not found for highlighting:', selector);
      return;
    }

    // Add highlight style
    element.style.outline = '3px solid #FFD700';
    element.style.outlineOffset = '2px';
    element.style.backgroundColor = 'rgba(255, 215, 0, 0.1)';

    // Remove highlight after 2 seconds
    setTimeout(() => {
      element.style.outline = '';
      element.style.outlineOffset = '';
      element.style.backgroundColor = '';
    }, 2000);

    // Scroll element into view
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });

    console.log('[Content] Highlighted element:', selector);
  } catch (error) {
    console.error('[Content] Error highlighting element:', error);
  }
}

/**
 * Click an element by selector
 */
function clickElement(selector) {
  try {
    const element = document.querySelector(selector);
    if (!element) {
      return { success: false, error: `Element not found: ${selector}` };
    }

    // Highlight before clicking
    highlightElement(selector);

    // Click after a brief delay
    setTimeout(() => {
      element.click();
      console.log('[Content] Clicked element:', selector);
    }, 500);

    return { success: true };
  } catch (error) {
    console.error('[Content] Error clicking element:', error);
    return { success: false, error: error.message };
  }
}
