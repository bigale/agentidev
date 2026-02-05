/**
 * Grammar Prompt Editor
 */

import {
  DEFAULT_MULTI_GRAMMAR_PROMPT,
  getPromptTemplate,
  savePromptTemplate,
  resetPromptTemplate,
  generateMultiGrammar
} from '../lib/multi-grammar-generator.js';

console.log('[Prompt Editor] Module loaded');

const promptTextarea = document.getElementById('grammar-prompt');
const saveButton = document.getElementById('save-prompt');
const resetButton = document.getElementById('reset-prompt');
const testButton = document.getElementById('test-prompt');
const statusDiv = document.getElementById('status');

// Load current prompt
async function loadPrompt() {
  try {
    const prompt = await getPromptTemplate();
    promptTextarea.value = prompt;
    console.log('[Prompt Editor] Loaded prompt template');
  } catch (error) {
    console.error('[Prompt Editor] Failed to load prompt:', error);
    showStatus('Failed to load prompt: ' + error.message, 'error');
  }
}

// Save prompt
saveButton.addEventListener('click', async () => {
  try {
    const template = promptTextarea.value;

    if (!template.includes('{PREPROCESSED_HTML}')) {
      showStatus('Warning: Prompt must contain {PREPROCESSED_HTML} placeholder', 'error');
      return;
    }

    const result = await savePromptTemplate(template);

    if (result.success) {
      showStatus('✓ Prompt template saved successfully!', 'success');
    } else {
      showStatus('Failed to save: ' + result.error, 'error');
    }
  } catch (error) {
    console.error('[Prompt Editor] Save failed:', error);
    showStatus('Failed to save: ' + error.message, 'error');
  }
});

// Reset to default
resetButton.addEventListener('click', async () => {
  if (!confirm('Reset to default prompt template? Your custom prompt will be discarded.')) {
    return;
  }

  try {
    await resetPromptTemplate();
    promptTextarea.value = DEFAULT_MULTI_GRAMMAR_PROMPT;
    showStatus('✓ Reset to default prompt template', 'success');
  } catch (error) {
    console.error('[Prompt Editor] Reset failed:', error);
    showStatus('Failed to reset: ' + error.message, 'error');
  }
});

// Test on current page
testButton.addEventListener('click', async () => {
  try {
    showStatus('Testing prompt on current page...', 'success');

    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      showStatus('No active tab found', 'error');
      return;
    }

    // Get page HTML
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.outerHTML
    });

    if (!result || !result.result) {
      showStatus('Failed to get page HTML', 'error');
      return;
    }

    const html = result.result;

    // Generate grammars using current prompt
    const promptTemplate = promptTextarea.value;
    const grammarSet = await generateMultiGrammar(html, { promptTemplate });

    // Show results
    showStatus(
      `✓ Generated ${grammarSet.count} grammars: ${grammarSet.grammars.map(g => g.name).join(', ')}`,
      'success'
    );

    console.log('[Prompt Editor] Test results:', grammarSet);

    // Log each grammar for inspection
    grammarSet.grammars.forEach(g => {
      console.log(`[Prompt Editor] ${g.name}:`, g.grammar);
    });

  } catch (error) {
    console.error('[Prompt Editor] Test failed:', error);
    showStatus('Test failed: ' + error.message, 'error');
  }
});

// Show status message
function showStatus(message, type) {
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;

  // Auto-hide after 5 seconds
  setTimeout(() => {
    statusDiv.style.display = 'none';
  }, 5000);
}

// Initialize
loadPrompt();

console.log('[Prompt Editor] Ready');
