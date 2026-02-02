/**
 * DOM Indexer
 *
 * Indexes page DOM elements into searchable chunks with embeddings.
 * Enables semantic element finding via natural language.
 *
 * Strategy:
 * 1. Chunk DOM by interactive elements (buttons, inputs, forms)
 * 2. Generate embeddings using existing transformers.js pipeline
 * 3. Store in IndexedDB with dom-{tabId} prefix
 * 4. Enable vector search for element finding
 */

import { generateEmbeddings } from './embeddings.js';
import { domVectorStore } from './dom-vector-store.js';

/**
 * Generate a unique CSS selector for an element
 */
function generateUniqueSelector(element) {
  // Try ID first (most specific)
  if (element.id) {
    return `#${element.id}`;
  }

  // Try data-testid (common in modern apps)
  if (element.dataset.testid) {
    return `[data-testid="${element.dataset.testid}"]`;
  }

  // Try name attribute (for form elements)
  if (element.name) {
    return `[name="${element.name}"]`;
  }

  // Build path from parent
  const path = [];
  let current = element;

  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();

    // Add class if unique enough
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/).filter(c => c && !c.startsWith('_')); // Skip dynamic classes
      if (classes.length > 0 && classes.length < 3) {
        selector += '.' + classes.join('.');
      }
    }

    // Add nth-child if needed for uniqueness
    if (current.parentElement) {
      const siblings = Array.from(current.parentElement.children);
      const index = siblings.indexOf(current);
      if (siblings.filter(s => s.tagName === current.tagName).length > 1) {
        selector += `:nth-child(${index + 1})`;
      }
    }

    path.unshift(selector);
    current = current.parentElement;

    // Limit path length
    if (path.length >= 4) break;
  }

  return path.join(' > ');
}

/**
 * Get descriptive text for an element
 */
function getElementText(element) {
  // Try various text sources
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

/**
 * Get contextual breadcrumb for an element
 * E.g., "Login Form > Email Field"
 */
function getElementContext(element) {
  const breadcrumbs = [];
  let current = element.parentElement;

  while (current && current !== document.body && breadcrumbs.length < 3) {
    // Look for semantic containers
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

/**
 * Find label for form element
 */
function findLabel(element) {
  // Try label[for=id]
  if (element.id) {
    const label = document.querySelector(`label[for="${element.id}"]`);
    if (label) return label.textContent?.trim();
  }

  // Try parent label
  const parentLabel = element.closest('label');
  if (parentLabel) return parentLabel.textContent?.trim();

  // Try previous sibling
  let prev = element.previousElementSibling;
  if (prev && (prev.tagName === 'LABEL' || prev.tagName === 'SPAN')) {
    return prev.textContent?.trim();
  }

  return null;
}

/**
 * Get React component info if available
 */
function getReactComponentInfo(element) {
  // Check for React Fiber
  const fiberKey = Object.keys(element).find(key =>
    key.startsWith('__reactFiber') ||
    key.startsWith('__reactInternalInstance')
  );

  if (!fiberKey) {
    return null;
  }

  const fiber = element[fiberKey];

  return {
    componentName: fiber.type?.name || fiber.type,
    key: fiber.key
  };
}

/**
 * Chunk DOM into indexable elements
 * Returns array of chunk objects ready for embedding
 */
export function chunkDOM(document) {
  const chunks = [];

  // Strategy 1: Index interactive elements (highest priority)
  const interactiveElements = document.querySelectorAll(
    'button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"]'
  );

  interactiveElements.forEach((el, index) => {
    const text = getElementText(el);
    const context = getElementContext(el);
    const label = el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'
      ? findLabel(el)
      : null;

    // Skip hidden elements
    if (el.offsetParent === null && el.tagName !== 'INPUT') {
      return;
    }

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
      reactComponent: getReactComponentInfo(el),
      index: index // Preserve DOM order
    });
  });

  // Strategy 2: Index forms (groups of inputs)
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

  // Strategy 3: Index headings and landmarks
  const landmarks = document.querySelectorAll(
    'h1, h2, h3, main, nav, aside, section[aria-label], [role="region"]'
  );

  landmarks.forEach((el, index) => {
    const text = getElementText(el);
    if (!text || text.length < 3) return; // Skip empty headings

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

  console.log(`[DOM Indexer] Chunked DOM into ${chunks.length} elements`);
  console.log(`[DOM Indexer] - Interactive: ${chunks.filter(c => c.type === 'interactive').length}`);
  console.log(`[DOM Indexer] - Forms: ${chunks.filter(c => c.type === 'form').length}`);
  console.log(`[DOM Indexer] - Landmarks: ${chunks.filter(c => c.type === 'landmark').length}`);

  return chunks;
}

/**
 * Generate embedding text from chunk
 * Combines all relevant text fields for semantic search
 */
function generateEmbeddingText(chunk) {
  const parts = [];

  // Extract key distinguishing words from label for emphasis
  // For "Date of Birth - Month", extract "Month" and put it FIRST
  const label = chunk.label || '';
  const keyWords = extractKeyWords(label);
  if (keyWords) {
    parts.push(keyWords); // "Month" or "Day" or "Year" FIRST
  }

  // Add element type prefix for better matching
  const typePrefix = getTypePrefix(chunk);
  if (typePrefix) parts.push(typePrefix);

  // Add label (most important for form fields)
  if (chunk.label) parts.push(chunk.label);

  // Add aria-label
  if (chunk.attributes?.ariaLabel) parts.push(chunk.attributes.ariaLabel);

  // Add placeholder for inputs
  if (chunk.attributes?.placeholder) parts.push(chunk.attributes.placeholder);

  // Add context
  if (chunk.context) parts.push(chunk.context);

  // Add text content
  if (chunk.text) parts.push(chunk.text);

  // Add role
  if (chunk.attributes?.role) parts.push(chunk.attributes.role);

  // Add element name/id if meaningful
  if (chunk.attributes?.name && chunk.attributes.name.length < 30) {
    parts.push(chunk.attributes.name);
  }

  return parts.filter(p => p).join(' ');
}

/**
 * Extract key distinguishing words from label
 * For "Date of Birth - Month", returns "Month Month Month" (repeated for emphasis)
 */
function extractKeyWords(label) {
  if (!label) return null;

  const lower = label.toLowerCase();

  // Date field types - repeat 3x for strong emphasis
  if (lower.includes('month')) return 'Month Month Month';
  if (lower.includes('day')) return 'Day Day Day';
  if (lower.includes('year')) return 'Year Year Year';

  // Other important distinguishers
  if (lower.includes('password')) return 'Password Password';
  if (lower.includes('email')) return 'Email Email';
  if (lower.includes('phone')) return 'Phone Phone';
  if (lower.includes('address')) return 'Address Address';
  if (lower.includes('city')) return 'City City';
  if (lower.includes('zip')) return 'Zip Zip';
  if (lower.includes('state')) return 'State State';
  if (lower.includes('country')) return 'Country Country';

  // Card fields
  if (lower.includes('card') && lower.includes('number')) return 'CardNumber CardNumber';
  if (lower.includes('cvv') || lower.includes('cvc')) return 'CVV CVV';
  if (lower.includes('expir')) return 'Expiration Expiration';

  return null;
}

/**
 * Get descriptive type prefix for better semantic matching
 */
function getTypePrefix(chunk) {
  const tag = chunk.tagName;
  const type = chunk.attributes?.type || '';

  // Form inputs - be very specific
  if (tag === 'input') {
    if (type === 'text' || !type) return 'text input field';
    if (type === 'email') return 'email input field';
    if (type === 'password') return 'password input field';
    if (type === 'tel') return 'phone input field';
    if (type === 'number') return 'number input field';
    if (type === 'date') return 'date input field';
    if (type === 'checkbox') return 'checkbox field';
    if (type === 'radio') return 'radio button field';
    return 'input field';
  }

  if (tag === 'textarea') return 'text area field';
  if (tag === 'select') return 'dropdown select field';
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'form') return 'form';

  return '';
}

/**
 * Index DOM for a specific tab
 * Called from background script after content script extracts DOM
 */
export async function indexDOM(tabId, domChunks) {
  console.log(`[DOM Indexer] Indexing ${domChunks.length} chunks for tab ${tabId}`);

  if (domChunks.length === 0) {
    console.warn('[DOM Indexer] No chunks to index');
    return { success: false, error: 'No chunks to index' };
  }

  const startTime = Date.now();

  try {
    // Generate embedding texts
    const embeddingTexts = domChunks.map(chunk => generateEmbeddingText(chunk));

    console.log(`[DOM Indexer] Generating embeddings for ${embeddingTexts.length} chunks...`);

    // Generate embeddings using existing pipeline
    const embeddings = await generateEmbeddings(embeddingTexts);

    console.log(`[DOM Indexer] Generated ${embeddings.length} embeddings`);

    // Store in vector DB with dom-{tabId} collection
    const collectionName = `dom-${tabId}`;

    // Clear existing DOM index for this tab
    await domVectorStore.clearCollection(collectionName);

    // Store each chunk with its embedding
    for (let i = 0; i < domChunks.length; i++) {
      await domVectorStore.storeChunk(collectionName, {
        ...domChunks[i],
        embeddingText: embeddingTexts[i] // Store for debugging
      }, embeddings[i]);
    }

    const elapsed = Date.now() - startTime;

    console.log(`[DOM Indexer] Indexed ${domChunks.length} elements in ${elapsed}ms`);
    console.log(`[DOM Indexer] Collection: ${collectionName}`);

    return {
      success: true,
      count: domChunks.length,
      elapsed: elapsed,
      collection: collectionName
    };

  } catch (error) {
    console.error('[DOM Indexer] Failed to index DOM:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Search indexed DOM elements by intent
 * Returns top matching elements
 */
export async function searchDOM(tabId, intent, options = {}) {
  const collectionName = `dom-${tabId}`;
  const topK = options.topK || 5;

  console.log(`[DOM Indexer] Searching "${intent}" in ${collectionName}`);

  try {
    // Enhance query with field-specific keywords if it looks like a form field search
    const enhancedIntent = enhanceSearchIntent(intent);

    // Generate embedding for search query
    const queryEmbedding = await generateEmbeddings([enhancedIntent]);

    // Search in vector store (get more results for re-ranking)
    const rawResults = await domVectorStore.searchChunks(collectionName, queryEmbedding[0], topK * 2);

    // Apply element-type boosting
    const boostedResults = rawResults.map(result => ({
      ...result,
      score: result.score * getElementBoost(result, intent)
    }));

    // Re-sort by boosted scores
    boostedResults.sort((a, b) => b.score - a.score);

    // Return top K after boosting
    const results = boostedResults.slice(0, topK);

    console.log(`[DOM Indexer] Found ${results.length} matches`);
    if (results.length > 0) {
      console.log(`[DOM Indexer] Top match: ${results[0].tagName} "${results[0].text || results[0].label}" (score: ${results[0].score.toFixed(3)})`);
    }

    return results;

  } catch (error) {
    console.error('[DOM Indexer] Search failed:', error);
    throw error;
  }
}

/**
 * Enhance search intent with field-specific keywords
 */
function enhanceSearchIntent(intent) {
  const lower = intent.toLowerCase();

  // Add "input field" to field-like searches
  const fieldKeywords = ['email', 'password', 'name', 'phone', 'address', 'city', 'zip', 'company', 'title'];
  for (const keyword of fieldKeywords) {
    if (lower.includes(keyword) && !lower.includes('field') && !lower.includes('button') && !lower.includes('link')) {
      return `${intent} input field`;
    }
  }

  return intent;
}

/**
 * Apply element-type boost to prioritize certain elements
 */
function getElementBoost(element, intent) {
  const lower = intent.toLowerCase();
  const tag = element.tagName;
  const type = element.attributes?.type || '';

  // Strong boost for form fields when searching for field-like terms
  const isFieldSearch = lower.includes('field') || lower.includes('input') ||
                        lower.includes('email') || lower.includes('password') ||
                        lower.includes('name') || lower.includes('phone') ||
                        lower.includes('address') || lower.includes('zip') ||
                        lower.includes('company') || lower.includes('title') ||
                        lower.includes('select') || lower.includes('dropdown') ||
                        lower.includes('textarea');

  if (isFieldSearch) {
    // Boost form inputs heavily
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      return 2.0; // 2x boost for form fields
    }
    // Penalize links
    if (tag === 'a') {
      return 0.3; // 70% penalty for links
    }
  }

  // Strong boost for buttons when searching for button-like terms
  const isButtonSearch = lower.includes('button') || lower.includes('submit') ||
                         lower.includes('click') || lower.includes('press');

  if (isButtonSearch) {
    if (tag === 'button' || (tag === 'input' && type === 'submit')) {
      return 1.5; // 1.5x boost for buttons
    }
    if (tag === 'a') {
      return 0.5; // 50% penalty for links
    }
  }

  return 1.0; // No boost/penalty
}

/**
 * Clear DOM index for a tab
 */
export async function clearDOMIndex(tabId) {
  const collectionName = `dom-${tabId}`;
  await domVectorStore.clearCollection(collectionName);
  console.log(`[DOM Indexer] Cleared ${collectionName}`);
}
