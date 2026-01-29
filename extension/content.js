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

// Listen for messages from extension (for extraction mode)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_PAGE_CONTENT') {
    // Get page content for extraction
    const content = getPageContent();
    sendResponse(content);
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
