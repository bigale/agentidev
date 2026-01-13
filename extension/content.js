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
