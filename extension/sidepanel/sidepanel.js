/**
 * Sidebar UI coordinator for Agentidev.
 * Delegates to mode modules for Search, Q&A, Extract, Agent, and Auto.
 */

import { init as initSearch, performSearch as searchPerform } from './modes/search-mode.js';
import { init as initQA, performSearch as qaPerform } from './modes/qa-mode.js';
import { init as initExtract } from './modes/extract-mode.js';
import { init as initAgent } from './modes/agent-mode.js';
import { init as initAuto, activate as activateAuto, deactivate as deactivateAuto } from './modes/auto-mode.js';
import { init as initAF, activate as activateAF, deactivate as deactivateAF } from './modes/agentiface-mode.js';

// Shared DOM refs
const queryInput = document.getElementById('query-input');
const filtersDiv = document.getElementById('filters');
const resultsDiv = document.getElementById('results');
const answerContainer = document.getElementById('answer-container');
const extractContainer = document.getElementById('extract-container');
const agentContainer = document.getElementById('agent-container');
const automationContainer = document.getElementById('automation-container');
const agentifaceContainer = document.getElementById('agentiface-container');
const settingsButton = document.getElementById('settings-button');

// Mode definitions
const modes = {
  search: {
    btn: document.getElementById('mode-search'),
    show: [queryInput, filtersDiv, resultsDiv],
    activate: () => { queryInput.placeholder = 'Search your browsing history...'; },
  },
  qa: {
    btn: document.getElementById('mode-qa'),
    show: [queryInput, filtersDiv, answerContainer],
    activate: () => { queryInput.placeholder = 'Ask a question about your history...'; },
  },
  extract: {
    btn: document.getElementById('mode-extract'),
    show: [extractContainer],
  },
  agent: {
    btn: document.getElementById('mode-agent'),
    show: [agentContainer],
  },
  automation: {
    btn: document.getElementById('mode-automation'),
    show: [automationContainer],
    activate: activateAuto,
    deactivate: deactivateAuto,
  },
  agentiface: {
    btn: document.getElementById('mode-agentiface'),
    show: [agentifaceContainer],
    activate: activateAF,
    deactivate: deactivateAF,
  },
};

const allContainers = [queryInput, filtersDiv, resultsDiv, answerContainer, extractContainer, agentContainer, automationContainer, agentifaceContainer];
let currentMode = 'search';
let currentFilter = 'all';
let debounceTimer = null;

// ---- Initialize all modes ----
initSearch();
initQA();
initExtract();
initAgent();
initAuto();
initAF();

// ---- Stats polling ----
loadStats();
setInterval(loadStats, 5000);

// ---- Query input ----
queryInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') performSearch();
});

queryInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (queryInput.value.trim().length > 3) performSearch();
  }, 7000);
});

// ---- Filter chips ----
filtersDiv.addEventListener('click', (e) => {
  if (e.target.classList.contains('filter-chip')) {
    filtersDiv.querySelectorAll('.filter-chip').forEach(chip => {
      chip.classList.remove('active');
      chip.setAttribute('aria-pressed', 'false');
    });
    e.target.classList.add('active');
    e.target.setAttribute('aria-pressed', 'true');
    currentFilter = e.target.dataset.filter;
    if (queryInput.value.trim()) performSearch();
  }
});

// ---- Settings ----
settingsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());

// ---- Mode switching ----
Object.entries(modes).forEach(([name, mode]) => {
  mode.btn.addEventListener('click', () => setMode(name));
});

function setMode(mode) {
  // Deactivate previous
  modes[currentMode]?.deactivate?.();

  currentMode = mode;

  // Toggle button active state + aria-pressed
  Object.values(modes).forEach(m => {
    m.btn.classList.remove('active');
    m.btn.setAttribute('aria-pressed', 'false');
  });
  modes[mode].btn.classList.add('active');
  modes[mode].btn.setAttribute('aria-pressed', 'true');

  // Hide all containers, show mode-specific ones
  allContainers.forEach(el => { if (el) el.style.display = 'none'; });
  (modes[mode].show || []).forEach(el => {
    if (el) el.style.display = el.tagName === 'INPUT' ? 'block' : (el === filtersDiv ? 'flex' : 'block');
  });

  // Activate new mode
  modes[mode]?.activate?.();
}

// ---- Search dispatch ----
function performSearch() {
  const query = queryInput.value.trim();
  if (!query) return;

  if (currentMode === 'search') {
    searchPerform(query, currentFilter);
  } else if (currentMode === 'qa') {
    qaPerform(query, currentFilter);
  }

  loadStats();
}

// ---- Stats ----
function loadStats() {
  chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
    if (response) {
      document.getElementById('pages-indexed').textContent = response.pagesIndexed || 0;
      document.getElementById('storage-used').textContent = formatBytes(response.storageUsed || 0);
      document.getElementById('queries-today').textContent = response.queriesToday || 0;
    }
  });
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 MB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
