/**
 * Form XML Parser
 *
 * Parses HTML forms using IXML grammar → XML for XPath queries
 * Integrates rustixml WASM parser
 *
 * Phase 2.1 - Grammar-enhanced automation
 */

console.log('[Form XML Parser] Module loaded');

// rustixml will be initialized lazily
let rustixml = null;
let rustixmlInitialized = false;

/**
 * Initialize rustixml WASM
 *
 * @returns {Promise<void>}
 */
async function initRustixml() {
  if (rustixmlInitialized) {
    return;
  }

  try {
    console.log('[Form XML Parser] Initializing rustixml WASM...');

    // Import rustixml module
    const module = await import('../pkg/rustixml.js');

    // Initialize WASM
    await module.default(); // Call init function

    rustixml = {
      IxmlParser: module.IxmlParser,
      parse_ixml: module.parse_ixml
    };

    rustixmlInitialized = true;

    console.log('[Form XML Parser] rustixml initialized:', module.version());

  } catch (error) {
    console.error('[Form XML Parser] rustixml initialization failed:', error);
    throw new Error(`Failed to initialize rustixml: ${error.message}`);
  }
}

/**
 * Parse HTML form with IXML grammar
 *
 * @param {string} html - HTML content to parse
 * @param {string} grammar - IXML grammar
 * @param {Object} options - Parse options
 * @returns {Promise<Document>} XML document
 */
export async function parseFormWithGrammar(html, grammar, options = {}) {
  const {
    validateXML = true
  } = options;

  try {
    // Ensure rustixml is initialized
    await initRustixml();

    console.log('[Form XML Parser] Parsing HTML with grammar...');
    console.log('[Form XML Parser] HTML length:', html.length);
    console.log('[Form XML Parser] Grammar length:', grammar.length);

    // Create parser from grammar
    const parser = new rustixml.IxmlParser(grammar);

    console.log('[Form XML Parser] Parser created');

    // Parse HTML → XML
    const parseResult = parser.parse(html);

    if (!parseResult.success) {
      throw new Error(`IXML parsing failed: ${parseResult.error || 'unknown error'}`);
    }

    const xmlString = parseResult.output;

    console.log('[Form XML Parser] HTML parsed to XML');
    console.log('[Form XML Parser] XML length:', xmlString.length);
    console.log('[Form XML Parser] XML sample:', xmlString.substring(0, 500));

    // Parse XML string to DOM Document
    const xmlDoc = new DOMParser().parseFromString(xmlString, 'text/xml');

    // Check for parse errors
    const parseError = xmlDoc.querySelector('parsererror');
    if (parseError) {
      throw new Error(`XML parse error: ${parseError.textContent}`);
    }

    // Validate XML structure
    if (validateXML) {
      const validation = validateXMLStructure(xmlDoc);
      if (!validation.valid) {
        console.warn('[Form XML Parser] XML validation warning:', validation.warning);
        // Non-fatal - continue anyway
      }
    }

    console.log('[Form XML Parser] ✓ Successfully parsed to XML document');

    return xmlDoc;

  } catch (error) {
    console.error('[Form XML Parser] Parsing failed:', error);
    throw error;
  }
}

/**
 * Validate XML structure
 *
 * @param {Document} xmlDoc - XML document
 * @returns {Object} Validation result
 */
function validateXMLStructure(xmlDoc) {
  // Check if XML has expected structure
  const root = xmlDoc.documentElement;

  if (!root) {
    return {
      valid: false,
      warning: 'No root element'
    };
  }

  // Check for field elements
  const fields = xmlDoc.querySelectorAll('input-field, select-field, button-field, field');

  if (fields.length === 0) {
    return {
      valid: false,
      warning: 'No field elements found in XML'
    };
  }

  console.log('[Form XML Parser] Validation: Found', fields.length, 'field elements');

  return {
    valid: true,
    fieldCount: fields.length
  };
}

/**
 * Extract field information from XML
 *
 * @param {Document} xmlDoc - Parsed XML document
 * @returns {Array<Object>} Array of field objects
 */
export function extractFieldsFromXML(xmlDoc) {
  const fields = [];

  // Query for all field types
  const fieldElements = xmlDoc.querySelectorAll('input-field, select-field, button-field, field');

  fieldElements.forEach((element, index) => {
    const field = {
      index,
      type: element.tagName.toLowerCase(),
      name: element.getAttribute('name') || '',
      id: element.getAttribute('id') || '',
      label: element.getAttribute('label') || element.querySelector('label')?.textContent || '',
      placeholder: element.getAttribute('placeholder') || '',
      inputType: element.getAttribute('type') || '',
      value: element.getAttribute('value') || '',
      selector: generateSelector(element),
      xmlElement: element
    };

    fields.push(field);
  });

  console.log('[Form XML Parser] Extracted', fields.length, 'fields from XML');

  return fields;
}

/**
 * Generate CSS selector for a field
 *
 * @param {Element} xmlElement - XML element representing the field
 * @returns {string} CSS selector
 */
function generateSelector(xmlElement) {
  const name = xmlElement.getAttribute('name');
  const id = xmlElement.getAttribute('id');
  const type = xmlElement.getAttribute('type');

  // Prefer ID selector
  if (id) {
    return `#${id}`;
  }

  // Name selector
  if (name) {
    return `[name="${name}"]`;
  }

  // Type selector as fallback
  const tagType = xmlElement.tagName.toLowerCase();
  if (tagType === 'input-field' && type) {
    return `input[type="${type}"]`;
  } else if (tagType === 'select-field') {
    return 'select';
  } else if (tagType === 'button-field') {
    return 'button';
  }

  return null;
}

/**
 * Query XML with XPath
 *
 * @param {Document} xmlDoc - XML document
 * @param {string} xpath - XPath query
 * @returns {Array<Node>} Matching nodes
 */
export function queryXML(xmlDoc, xpath) {
  try {
    const result = xmlDoc.evaluate(
      xpath,
      xmlDoc,
      null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
      null
    );

    const nodes = [];
    for (let i = 0; i < result.snapshotLength; i++) {
      nodes.push(result.snapshotItem(i));
    }

    console.log('[Form XML Parser] XPath query:', xpath, '→', nodes.length, 'results');

    return nodes;

  } catch (error) {
    console.error('[Form XML Parser] XPath query failed:', xpath, error);
    return [];
  }
}

/**
 * Get rustixml initialization status
 *
 * @returns {boolean} True if initialized
 */
export function isRustixmlReady() {
  return rustixmlInitialized;
}

/**
 * Parse HTML form with fallback
 * Tries IXML parsing, falls back to simple extraction if parsing fails
 *
 * @param {string} html - HTML content
 * @param {string} grammar - IXML grammar
 * @returns {Promise<Object>} Parse result with fields array
 */
export async function parseFormWithFallback(html, grammar) {
  try {
    // Try IXML parsing
    const xmlDoc = await parseFormWithGrammar(html, grammar);
    const fields = extractFieldsFromXML(xmlDoc);

    return {
      success: true,
      method: 'ixml',
      fields,
      xmlDoc
    };

  } catch (error) {
    console.warn('[Form XML Parser] IXML parsing failed, using fallback:', error.message);

    // Fallback: Simple regex extraction
    const fields = extractFieldsSimple(html);

    return {
      success: true,
      method: 'fallback',
      fields,
      error: error.message
    };
  }
}

/**
 * Simple field extraction (fallback when IXML fails)
 *
 * @param {string} html - HTML content
 * @returns {Array<Object>} Fields
 */
function extractFieldsSimple(html) {
  const fields = [];

  // Extract inputs
  const inputPattern = /<input([^>]*)>/gi;
  let match;

  while ((match = inputPattern.exec(html)) !== null) {
    const attrs = match[1];

    const field = {
      type: 'input-field',
      name: (attrs.match(/name="([^"]+)"/) || [])[1] || '',
      id: (attrs.match(/id="([^"]+)"/) || [])[1] || '',
      inputType: (attrs.match(/type="([^"]+)"/) || [])[1] || 'text',
      placeholder: (attrs.match(/placeholder="([^"]+)"/) || [])[1] || '',
      selector: null
    };

    field.selector = field.id ? `#${field.id}` : (field.name ? `[name="${field.name}"]` : null);

    if (field.selector) {
      fields.push(field);
    }
  }

  // Extract selects
  const selectPattern = /<select([^>]*)>/gi;
  while ((match = selectPattern.exec(html)) !== null) {
    const attrs = match[1];

    const field = {
      type: 'select-field',
      name: (attrs.match(/name="([^"]+)"/) || [])[1] || '',
      id: (attrs.match(/id="([^"]+)"/) || [])[1] || '',
      selector: null
    };

    field.selector = field.id ? `#${field.id}` : (field.name ? `[name="${field.name}"]` : null);

    if (field.selector) {
      fields.push(field);
    }
  }

  console.log('[Form XML Parser] Fallback extraction found', fields.length, 'fields');

  return fields;
}

console.log('[Form XML Parser] Module ready');
