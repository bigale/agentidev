/**
 * Form XML Parser
 *
 * Parses HTML forms using IXML grammar → XML for XPath queries
 * Integrates rustixml WASM parser
 *
 * Phase 2.1 - Grammar-enhanced automation
 * Phase 2.2 - Multi-grammar library approach
 */

import { preprocessHTML } from './html-preprocessor.js';
import { getDefaultGrammarSet } from './grammar-library.js';

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
 * @param {string} html - HTML content to parse (will be preprocessed to pipe-delimited format)
 * @param {string} grammar - IXML grammar (should expect pipe-delimited format)
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

    // Preprocess HTML to pipe-delimited format
    const preprocessed = preprocessHTML(html);

    console.log('[Form XML Parser] Parsing HTML with grammar...');
    console.log('[Form XML Parser] HTML length:', html.length);
    console.log('[Form XML Parser] Preprocessed length:', preprocessed.length);
    console.log('[Form XML Parser] Preprocessed sample:', preprocessed.substring(0, 200) + '...');
    console.log('[Form XML Parser] Grammar length:', grammar.length);

    // Create parser from grammar
    const parser = new rustixml.IxmlParser(grammar);

    console.log('[Form XML Parser] Parser created');

    // Parse preprocessed HTML → XML
    const parseResult = parser.parse(preprocessed);

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
 * Parse attribute string into object
 * @param {string} attrString - e.g., ' type="text" name="email" id="email-field"'
 * @returns {Object} Parsed attributes
 */
function parseAttributeString(attrString) {
  const attrs = {};

  if (!attrString) return attrs;

  // Match attr="value" or attr='value'
  const attrPattern = /(\w+)=["']([^"']+)["']/g;
  let match;

  while ((match = attrPattern.exec(attrString)) !== null) {
    attrs[match[1]] = match[2];
  }

  return attrs;
}

/**
 * Extract field information from XML
 *
 * @param {Document} xmlDoc - Parsed XML document
 * @returns {Array<Object>} Array of field objects
 */
export function extractFieldsFromXML(xmlDoc) {
  const fields = [];

  // Query for all field types (supports both naming conventions)
  const fieldElements = xmlDoc.querySelectorAll('input-field, select-field, button-field, field, input-el, select-el, textarea-el, button-el');

  fieldElements.forEach((element, index) => {
    const tagName = element.tagName.toLowerCase();

    // For library grammars (*-el elements), extract from child text content
    let attrsText = '';
    if (tagName === 'input-el') {
      attrsText = element.querySelector('input-attrs')?.textContent || '';
    } else if (tagName === 'select-el') {
      attrsText = element.querySelector('select-attrs')?.textContent || '';
    }

    // Parse attributes from text (e.g., ' type="text" name="email"')
    const parsedAttrs = parseAttributeString(attrsText);

    const field = {
      index,
      type: tagName,
      name: parsedAttrs.name || element.getAttribute('name') || '',
      id: parsedAttrs.id || element.getAttribute('id') || '',
      label: element.getAttribute('label') || element.querySelector('label')?.textContent || '',
      placeholder: parsedAttrs.placeholder || element.getAttribute('placeholder') || '',
      inputType: parsedAttrs.type || element.getAttribute('type') || '',
      value: parsedAttrs.value || element.getAttribute('value') || '',
      selector: null,
      xmlElement: element
    };

    // Generate selector
    field.selector = field.id ? `#${field.id}` : (field.name ? `[name="${field.name}"]` : null);

    if (field.selector) {
      fields.push(field);
    }
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
 * @param {string} html - HTML content (can be full page or just form)
 * @param {string} grammar - IXML grammar
 * @returns {Promise<Object>} Parse result with fields array
 */
export async function parseFormWithFallback(html, grammar) {
  try {
    // Extract form HTML if we got full page
    const formHTML = extractFormHTML(html);
    const htmlToParse = formHTML || html;

    console.log('[Form XML Parser] Input HTML length:', html.length);
    console.log('[Form XML Parser] Extracted form length:', htmlToParse.length);

    // Try IXML parsing
    const xmlDoc = await parseFormWithGrammar(htmlToParse, grammar);
    const fields = extractFieldsFromXML(xmlDoc);

    return {
      success: true,
      method: 'ixml',
      fields,
      xmlDoc
    };

  } catch (error) {
    console.warn('[Form XML Parser] IXML parsing failed, using fallback:', error.message);

    // Extract form HTML if we got full page
    const formHTML = extractFormHTML(html);
    const htmlToExtract = formHTML || html;

    // Fallback: Simple regex extraction
    const fields = extractFieldsSimple(htmlToExtract);

    return {
      success: true,
      method: 'fallback',
      fields,
      error: error.message
    };
  }
}

/**
 * Extract form HTML from page
 *
 * @param {string} html - Full page HTML or form HTML
 * @returns {string|null} Form HTML or null if not found
 */
function extractFormHTML(html) {
  // Try to find <form> tag
  const formMatch = html.match(/<form[^>]*>[\s\S]*?<\/form>/i);

  if (formMatch) {
    return formMatch[0];
  }

  // If no form tag found, check if input is already a form
  if (html.trim().startsWith('<form')) {
    return html;
  }

  // No explicit form tag - return null (will use full HTML)
  return null;
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

/**
 * Parse form using multi-grammar library approach
 * Uses proven working grammars in multiple passes
 *
 * @param {string} html - HTML content
 * @returns {Promise<Object>} Parse result with combined fields
 */
export async function parseFormWithLibrary(html) {
  console.log('[Form XML Parser] Using multi-grammar library approach');

  try {
    // Extract form HTML if we got full page
    const formHTML = extractFormHTML(html);
    const htmlToParse = formHTML || html;

    console.log('[Form XML Parser] Input HTML length:', html.length);
    console.log('[Form XML Parser] Extracted form length:', htmlToParse.length);

    // Get grammar set from library
    const grammarSet = getDefaultGrammarSet();
    console.log('[Form XML Parser] Using', grammarSet.length, 'grammars:', grammarSet.map(g => g.name).join(', '));

    const allFields = [];
    let passCount = 0;

    // Parse with each grammar
    for (const grammarDef of grammarSet) {
      passCount++;
      console.log(`[Form XML Parser] Pass ${passCount}: ${grammarDef.name}`);

      try {
        const xmlDoc = await parseFormWithGrammar(htmlToParse, grammarDef.grammar);
        const fields = extractFieldsFromXML(xmlDoc);

        console.log(`[Form XML Parser]   → Found ${fields.length} fields`);

        // Tag fields with grammar name
        fields.forEach(f => f.grammarSource = grammarDef.name);
        allFields.push(...fields);

      } catch (error) {
        console.warn(`[Form XML Parser]   → Pass failed:`, error.message);
        // Continue with other grammars
      }
    }

    if (allFields.length > 0) {
      console.log(`[Form XML Parser] ✓ Multi-grammar success: ${allFields.length} total fields`);

      return {
        success: true,
        method: 'multi-grammar',
        fields: allFields,
        passCount: passCount
      };
    }

    // All passes failed, use fallback
    throw new Error('All grammar passes failed');

  } catch (error) {
    console.warn('[Form XML Parser] Multi-grammar failed, using fallback:', error.message);

    // Extract form HTML if we got full page
    const formHTML = extractFormHTML(html);
    const htmlToExtract = formHTML || html;

    // Fallback: Simple regex extraction
    const fields = extractFieldsSimple(htmlToExtract);

    return {
      success: true,
      method: 'fallback',
      fields,
      error: error.message
    };
  }
}

console.log('[Form XML Parser] Module ready');
