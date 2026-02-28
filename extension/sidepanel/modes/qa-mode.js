/**
 * Q&A mode — LLM-powered question answering.
 * Extracted from sidepanel.js Q&A rendering.
 */

const answerText = document.getElementById('answer-text');
const answerSources = document.getElementById('answer-sources');
const sourceList = document.getElementById('source-list');
const answerMetadata = document.getElementById('answer-metadata');

export function init() {
  // No additional init needed
}

export function activate() {
  // Nothing to do on activate
}

export function performSearch(query, filter) {
  answerText.innerHTML = '<div class="loading"><span class="thinking-spinner"></span>Thinking...</div>';
  sourceList.innerHTML = '';
  answerMetadata.innerHTML = '';

  chrome.runtime.sendMessage({
    type: 'QUERY_LLM',
    query: query,
    filter: filter
  }, (response) => {
    if (response && response.result) {
      displayAnswer(response.result);
    } else {
      answerText.innerHTML = `<div class="loading">❌ Error: ${response?.error || 'Unknown error'}</div>`;
    }
  });
}

function displayAnswer(result) {
  answerText.textContent = result.answer || 'No answer generated.';

  sourceList.innerHTML = '';

  if (result.sources && result.sources.length > 0) {
    answerSources.style.display = 'block';

    result.sources.forEach((source, i) => {
      const sourceItem = document.createElement('div');
      sourceItem.className = 'source-item';

      const title = document.createElement('div');
      title.className = 'source-title';
      title.textContent = `[${i + 1}] ${source.title || 'Untitled'}`;

      const url = document.createElement('div');
      url.className = 'source-url';
      url.textContent = source.url;

      sourceItem.appendChild(title);
      sourceItem.appendChild(url);
      sourceItem.addEventListener('click', () => {
        chrome.tabs.create({ url: source.url });
      });

      sourceList.appendChild(sourceItem);
    });
  } else {
    answerSources.style.display = 'none';
  }

  if (result.metadata) {
    const meta = result.metadata;
    const parts = [];

    if (meta.chunksUsed) parts.push(`📊 ${meta.chunksUsed} sources`);
    if (meta.tokensUsed && meta.tokensAvailable) {
      const percentUsed = Math.round((meta.tokensUsed / meta.tokensAvailable) * 100);
      parts.push(`🪙 ${meta.tokensUsed}/${meta.tokensAvailable} tokens (${percentUsed}%)`);
    }
    if (meta.generationTimeMs) {
      const seconds = (meta.generationTimeMs / 1000).toFixed(1);
      parts.push(`⏱️ ${seconds}s`);
    }
    if (!meta.llmReady) parts.push('⚠️ LLM initializing');

    answerMetadata.innerHTML = parts.join(' &nbsp;•&nbsp; ');
  }
}
