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

  // Add context first (most important)
  if (chunk.context) parts.push(chunk.context);

  // Add label
  if (chunk.label) parts.push(chunk.label);

  // Add aria-label
  if (chunk.attributes?.ariaLabel) parts.push(chunk.attributes.ariaLabel);

  // Add text content
  if (chunk.text) parts.push(chunk.text);

  // Add placeholder for inputs
  if (chunk.attributes?.placeholder) parts.push(chunk.attributes.placeholder);

  // Add role
  if (chunk.attributes?.role) parts.push(chunk.attributes.role);

  // Add tag name for type awareness
  parts.push(chunk.tagName);

  return parts.filter(p => p).join(' ');
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
    // Generate embedding for search query
    const queryEmbedding = await generateEmbeddings([intent]);

    // Search in vector store
    const results = await domVectorStore.searchChunks(collectionName, queryEmbedding[0], topK);

    console.log(`[DOM Indexer] Found ${results.length} matches`);

    return results;

  } catch (error) {
    console.error('[DOM Indexer] Search failed:', error);
    throw error;
  }
}

/**
 * Clear DOM index for a tab
 */
export async function clearDOMIndex(tabId) {
  const collectionName = `dom-${tabId}`;
  await domVectorStore.clearCollection(collectionName);
  console.log(`[DOM Indexer] Cleared ${collectionName}`);
}
