/**
 * XPath Field Finder
 *
 * Uses XPath queries on parsed XML to find form fields with high precision.
 * First layer in the hybrid field finding approach (XPath → Vector → LLM).
 *
 * Phase 2.1 - Grammar-enhanced automation
 */

import { queryXML } from './form-xml-parser.js';

console.log('[XPath Finder] Module loaded');

/**
 * Find field using XPath queries on XML document
 *
 * @param {Document} xmlDoc - Parsed XML document from form-xml-parser
 * @param {string} intent - User intent (e.g., "email", "password", "submit button")
 * @param {Object} options - Query options
 * @returns {Object} Result with selector or null
 */
export function findFieldByXPath(xmlDoc, intent, options = {}) {
  const {
    preferExactMatch = true,
    returnAll = false
  } = options;

  console.log('[XPath Finder] Searching for:', intent);

  const startTime = performance.now();

  // Normalize intent
  const normalizedIntent = intent.toLowerCase().trim();

  // Try specialized queries first
  let result = null;

  // Email field patterns
  if (normalizedIntent.includes('email')) {
    result = tryEmailFieldXPath(xmlDoc);
  }

  // Password field patterns
  else if (normalizedIntent.includes('password')) {
    result = tryPasswordFieldXPath(xmlDoc);
  }

  // Phone/telephone patterns
  else if (normalizedIntent.includes('phone') || normalizedIntent.includes('tel')) {
    result = tryPhoneFieldXPath(xmlDoc);
  }

  // Name field patterns
  else if (normalizedIntent.includes('name') && !normalizedIntent.includes('user')) {
    result = tryNameFieldXPath(xmlDoc);
  }

  // Username patterns
  else if (normalizedIntent.includes('user') || normalizedIntent.includes('login')) {
    result = tryUsernameFieldXPath(xmlDoc);
  }

  // Address patterns
  else if (normalizedIntent.includes('address')) {
    result = tryAddressFieldXPath(xmlDoc);
  }

  // Submit button patterns
  else if (normalizedIntent.includes('submit') || normalizedIntent.includes('send') || normalizedIntent.includes('continue')) {
    result = trySubmitButtonXPath(xmlDoc);
  }

  // Generic field search
  else {
    result = tryGenericFieldXPath(xmlDoc, normalizedIntent);
  }

  const elapsed = performance.now() - startTime;

  if (result && result.selector) {
    console.log('[XPath Finder] ✓ Found field in', elapsed.toFixed(2), 'ms');
    console.log('[XPath Finder] Selector:', result.selector);

    return {
      success: true,
      selector: result.selector,
      method: 'xpath',
      confidence: result.confidence || 0.95,
      fieldInfo: result.fieldInfo,
      queryTime: elapsed
    };
  }

  console.log('[XPath Finder] ✗ No match found in', elapsed.toFixed(2), 'ms');

  return {
    success: false,
    method: 'xpath',
    queryTime: elapsed
  };
}

/**
 * Try email field XPath patterns
 *
 * @param {Document} xmlDoc - XML document
 * @returns {Object|null} Result
 */
function tryEmailFieldXPath(xmlDoc) {
  const xpaths = [
    // Exact type match
    `//input-field[@type='email']`,

    // Name contains 'email'
    `//input-field[contains(translate(@name, 'EMAIL', 'email'), 'email')]`,

    // ID contains 'email'
    `//input-field[contains(translate(@id, 'EMAIL', 'email'), 'email')]`,

    // Label contains 'email'
    `//input-field[contains(translate(@label, 'EMAIL', 'email'), 'email')]`,

    // Placeholder contains 'email'
    `//input-field[contains(translate(@placeholder, 'EMAIL', 'email'), 'email')]`
  ];

  return tryXPathList(xmlDoc, xpaths, 'email');
}

/**
 * Try password field XPath patterns
 *
 * @param {Document} xmlDoc - XML document
 * @returns {Object|null} Result
 */
function tryPasswordFieldXPath(xmlDoc) {
  const xpaths = [
    // Exact type match
    `//input-field[@type='password']`,

    // Name contains 'password' or 'passwd'
    `//input-field[contains(translate(@name, 'PASSWORD', 'password'), 'password') or contains(@name, 'passwd')]`,

    // ID contains 'password'
    `//input-field[contains(translate(@id, 'PASSWORD', 'password'), 'password')]`,

    // Label contains 'password'
    `//input-field[contains(translate(@label, 'PASSWORD', 'password'), 'password')]`
  ];

  return tryXPathList(xmlDoc, xpaths, 'password');
}

/**
 * Try phone field XPath patterns
 *
 * @param {Document} xmlDoc - XML document
 * @returns {Object|null} Result
 */
function tryPhoneFieldXPath(xmlDoc) {
  const xpaths = [
    // Type tel
    `//input-field[@type='tel']`,

    // Name contains 'phone' or 'tel'
    `//input-field[contains(translate(@name, 'PHONE', 'phone'), 'phone') or contains(translate(@name, 'TEL', 'tel'), 'tel')]`,

    // ID contains 'phone' or 'tel'
    `//input-field[contains(translate(@id, 'PHONE', 'phone'), 'phone') or contains(translate(@id, 'TEL', 'tel'), 'tel')]`,

    // Label contains 'phone' or 'telephone'
    `//input-field[contains(translate(@label, 'PHONE', 'phone'), 'phone') or contains(translate(@label, 'TELEPHONE', 'telephone'), 'telephone')]`,

    // Placeholder contains 'phone'
    `//input-field[contains(translate(@placeholder, 'PHONE', 'phone'), 'phone')]`
  ];

  return tryXPathList(xmlDoc, xpaths, 'phone');
}

/**
 * Try name field XPath patterns
 *
 * @param {Document} xmlDoc - XML document
 * @returns {Object|null} Result
 */
function tryNameFieldXPath(xmlDoc) {
  const xpaths = [
    // Full name field
    `//input-field[contains(translate(@name, 'NAME', 'name'), 'fullname') or contains(translate(@name, 'NAME', 'name'), 'full_name')]`,
    `//input-field[contains(translate(@label, 'NAME', 'name'), 'full name')]`,

    // Generic name field (but not username)
    `//input-field[contains(translate(@name, 'NAME', 'name'), 'name') and not(contains(translate(@name, 'USER', 'user'), 'user'))]`,
    `//input-field[contains(translate(@id, 'NAME', 'name'), 'name') and not(contains(translate(@id, 'USER', 'user'), 'user'))]`,
    `//input-field[contains(translate(@label, 'NAME', 'name'), 'name') and not(contains(translate(@label, 'USER', 'user'), 'user'))]`,

    // First name
    `//input-field[contains(translate(@name, 'FIRST', 'first'), 'first') or contains(translate(@name, 'FNAME', 'fname'), 'fname')]`,

    // Last name
    `//input-field[contains(translate(@name, 'LAST', 'last'), 'last') or contains(translate(@name, 'LNAME', 'lname'), 'lname')]`
  ];

  return tryXPathList(xmlDoc, xpaths, 'name');
}

/**
 * Try username field XPath patterns
 *
 * @param {Document} xmlDoc - XML document
 * @returns {Object|null} Result
 */
function tryUsernameFieldXPath(xmlDoc) {
  const xpaths = [
    // Name contains 'username' or 'user'
    `//input-field[contains(translate(@name, 'USERNAME', 'username'), 'username') or contains(@name, 'user')]`,

    // ID contains 'username' or 'user'
    `//input-field[contains(translate(@id, 'USERNAME', 'username'), 'username') or contains(@id, 'user')]`,

    // Label contains 'username'
    `//input-field[contains(translate(@label, 'USERNAME', 'username'), 'username')]`,

    // Login field
    `//input-field[contains(translate(@name, 'LOGIN', 'login'), 'login')]`
  ];

  return tryXPathList(xmlDoc, xpaths, 'username');
}

/**
 * Try address field XPath patterns
 *
 * @param {Document} xmlDoc - XML document
 * @returns {Object|null} Result
 */
function tryAddressFieldXPath(xmlDoc) {
  const xpaths = [
    // Name contains 'address'
    `//input-field[contains(translate(@name, 'ADDRESS', 'address'), 'address')]`,

    // ID contains 'address'
    `//input-field[contains(translate(@id, 'ADDRESS', 'address'), 'address')]`,

    // Label contains 'address' (including "Home address")
    `//input-field[contains(translate(@label, 'ADDRESS', 'address'), 'address')]`,

    // Placeholder contains 'address'
    `//input-field[contains(translate(@placeholder, 'ADDRESS', 'address'), 'address')]`,

    // Street address
    `//input-field[contains(translate(@name, 'STREET', 'street'), 'street')]`,
    `//input-field[contains(translate(@label, 'STREET', 'street'), 'street')]`
  ];

  return tryXPathList(xmlDoc, xpaths, 'address');
}

/**
 * Try submit button XPath patterns
 *
 * @param {Document} xmlDoc - XML document
 * @returns {Object|null} Result
 */
function trySubmitButtonXPath(xmlDoc) {
  const xpaths = [
    // Type submit
    `//button-field[@type='submit']`,

    // Input type submit
    `//input-field[@type='submit']`,

    // Button text contains 'submit', 'send', 'continue', 'next', 'sign in', 'log in'
    `//button-field[contains(translate(., 'SUBMIT', 'submit'), 'submit')]`,
    `//button-field[contains(translate(., 'SEND', 'send'), 'send')]`,
    `//button-field[contains(translate(., 'CONTINUE', 'continue'), 'continue')]`,
    `//button-field[contains(translate(., 'NEXT', 'next'), 'next')]`,
    `//button-field[contains(translate(., 'SIGNIN', 'signin'), 'sign in') or contains(translate(., 'LOGIN', 'login'), 'log in')]`
  ];

  return tryXPathList(xmlDoc, xpaths, 'submit');
}

/**
 * Try generic field search
 *
 * @param {Document} xmlDoc - XML document
 * @param {string} intent - Normalized intent
 * @returns {Object|null} Result
 */
function tryGenericFieldXPath(xmlDoc, intent) {
  // Extract keywords from intent
  const keywords = intent.split(/\s+/).filter(w => w.length > 2);

  if (keywords.length === 0) {
    return null;
  }

  const keyword = keywords[0]; // Use first significant keyword

  // Case-insensitive matching using translate()
  const upper = keyword.toUpperCase();
  const lower = keyword.toLowerCase();

  const xpaths = [
    // Match in name attribute
    `//input-field[contains(translate(@name, '${upper}', '${lower}'), '${lower}')]`,

    // Match in id attribute
    `//input-field[contains(translate(@id, '${upper}', '${lower}'), '${lower}')]`,

    // Match in label
    `//input-field[contains(translate(@label, '${upper}', '${lower}'), '${lower}')]`,

    // Match in placeholder
    `//input-field[contains(translate(@placeholder, '${upper}', '${lower}'), '${lower}')]`,

    // Match in select fields
    `//select-field[contains(translate(@name, '${upper}', '${lower}'), '${lower}')]`,
    `//select-field[contains(translate(@label, '${upper}', '${lower}'), '${lower}')]`,

    // Match in button text
    `//button-field[contains(translate(., '${upper}', '${lower}'), '${lower}')]`
  ];

  return tryXPathList(xmlDoc, xpaths, keyword);
}

/**
 * Try a list of XPath queries in order
 *
 * @param {Document} xmlDoc - XML document
 * @param {Array<string>} xpaths - XPath queries to try
 * @param {string} fieldType - Field type for logging
 * @returns {Object|null} Result with selector
 */
function tryXPathList(xmlDoc, xpaths, fieldType) {
  for (let i = 0; i < xpaths.length; i++) {
    const xpath = xpaths[i];

    try {
      const nodes = queryXML(xmlDoc, xpath);

      if (nodes.length > 0) {
        // Found match - extract selector
        const node = nodes[0]; // Take first match
        const selector = extractSelector(node);

        if (selector) {
          console.log('[XPath Finder] Match:', xpath, '→', selector);

          return {
            selector,
            confidence: 0.95 - (i * 0.05), // Lower confidence for later patterns
            fieldInfo: {
              type: fieldType,
              xpathPattern: i,
              matchCount: nodes.length
            }
          };
        }
      }

    } catch (error) {
      console.warn('[XPath Finder] XPath query failed:', xpath, error);
      continue;
    }
  }

  return null;
}

/**
 * Extract CSS selector from XML node
 *
 * @param {Node} node - XML node (input-field, select-field, button-field)
 * @returns {string|null} CSS selector
 */
function extractSelector(node) {
  // Get attributes
  const id = node.getAttribute('id');
  const name = node.getAttribute('name');
  const type = node.getAttribute('type');

  // Prefer ID selector (most specific)
  if (id) {
    return `#${id}`;
  }

  // Name selector
  if (name) {
    return `[name="${name}"]`;
  }

  // Type-based selector
  const tagType = node.tagName.toLowerCase();

  if (tagType === 'input-field' && type) {
    return `input[type="${type}"]`;
  } else if (tagType === 'select-field') {
    return 'select';
  } else if (tagType === 'button-field') {
    if (type) {
      return `button[type="${type}"]`;
    }
    return 'button';
  }

  return null;
}

/**
 * Batch find multiple fields by intent
 *
 * @param {Document} xmlDoc - XML document
 * @param {Array<string>} intents - Array of intents to find
 * @param {Object} options - Query options
 * @returns {Array<Object>} Results for each intent
 */
export function findFieldsByXPath(xmlDoc, intents, options = {}) {
  console.log('[XPath Finder] Batch query for', intents.length, 'fields');

  const results = [];

  for (const intent of intents) {
    const result = findFieldByXPath(xmlDoc, intent, options);
    results.push({
      intent,
      ...result
    });
  }

  const successCount = results.filter(r => r.success).length;
  console.log('[XPath Finder] Batch results:', successCount, '/', intents.length, 'found');

  return results;
}

/**
 * Get all fields from XML document
 *
 * @param {Document} xmlDoc - XML document
 * @returns {Array<Object>} All fields with selectors
 */
export function getAllFields(xmlDoc) {
  console.log('[XPath Finder] Extracting all fields from XML');

  const fields = [];

  // Get all field elements
  const allFields = queryXML(xmlDoc, '//input-field | //select-field | //button-field');

  allFields.forEach((node, index) => {
    const selector = extractSelector(node);

    if (selector) {
      fields.push({
        index,
        type: node.tagName.toLowerCase(),
        selector,
        name: node.getAttribute('name') || '',
        id: node.getAttribute('id') || '',
        label: node.getAttribute('label') || '',
        inputType: node.getAttribute('type') || '',
        placeholder: node.getAttribute('placeholder') || ''
      });
    }
  });

  console.log('[XPath Finder] Extracted', fields.length, 'fields');

  return fields;
}

/**
 * Test XPath performance on XML document
 *
 * @param {Document} xmlDoc - XML document
 * @returns {Object} Performance metrics
 */
export function testXPathPerformance(xmlDoc) {
  const testIntents = [
    'email',
    'password',
    'phone',
    'name',
    'address',
    'submit button'
  ];

  console.log('[XPath Finder] Performance test started');

  const startTime = performance.now();
  const results = [];

  for (const intent of testIntents) {
    const result = findFieldByXPath(xmlDoc, intent);
    results.push({
      intent,
      success: result.success,
      queryTime: result.queryTime
    });
  }

  const totalTime = performance.now() - startTime;
  const avgTime = totalTime / testIntents.length;
  const successRate = results.filter(r => r.success).length / testIntents.length;

  const metrics = {
    totalQueries: testIntents.length,
    totalTime: totalTime.toFixed(2),
    avgTime: avgTime.toFixed(2),
    successRate: (successRate * 100).toFixed(1) + '%',
    results
  };

  console.log('[XPath Finder] Performance metrics:', metrics);

  return metrics;
}

console.log('[XPath Finder] Module ready');
