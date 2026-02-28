/**
 * Dashboard coordinator — wires panels, loads initial state, starts broadcast listener.
 * Reuses all existing message types from background.js (no new handlers needed).
 */

import { DashState } from './lib/dash-state.js';
import { initSessionPanel } from './panels/session-panel.js';
import { initFeedPanel } from './panels/feed-panel.js';
import { initSnapshotPanel } from './panels/snapshot-panel.js';
import { initReasoningPanel } from './panels/reasoning-panel.js';

// ---- State ----
const state = new DashState();

// ---- DOM refs ----
const bridgeDot = document.getElementById('dash-bridge-dot');
const bridgeStatus = document.getElementById('dash-bridge-status');
const connectBtn = document.getElementById('dash-connect-btn');

// ---- Initialize panels ----
const sessionPanel = document.getElementById('dash-session-panel');
const snapshotPanel = document.getElementById('dash-snapshot-panel');
const feedPanel = document.getElementById('dash-feed-panel');
const reasoningPanel = document.getElementById('dash-reasoning-panel');

initSessionPanel(sessionPanel, state);
initFeedPanel(feedPanel, state);
initSnapshotPanel(snapshotPanel, state);
initReasoningPanel(reasoningPanel, state);

// ---- Top bar: bridge connect/disconnect ----
connectBtn.addEventListener('click', handleBridgeToggle);

function updateTopBar() {
  const connected = state.get('bridgeConnected');
  bridgeDot.className = connected ? 'dash-topbar-dot connected' : 'dash-topbar-dot';
  bridgeStatus.textContent = connected ? 'Connected' : 'Disconnected';
  connectBtn.textContent = connected ? 'Disconnect' : 'Connect';
  connectBtn.className = connected ? 'dash-topbar-btn danger' : 'dash-topbar-btn';
}

state.addEventListener('change', (e) => {
  if (e.detail.key === 'bridgeConnected') updateTopBar();
});

function handleBridgeToggle() {
  const connected = state.get('bridgeConnected');

  if (connected) {
    chrome.runtime.sendMessage({ type: 'BRIDGE_DISCONNECT' }, () => {
      state.set('bridgeConnected', false);
      state.set('sessions', []);
      state.set('activeSessionId', null);
    });
  } else {
    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting...';
    chrome.runtime.sendMessage({ type: 'BRIDGE_CONNECT', port: 9876 }, (response) => {
      connectBtn.disabled = false;
      if (response?.success) {
        state.set('bridgeConnected', true);
        loadSessions();
      } else {
        bridgeStatus.textContent = `Error: ${response?.error || 'Failed'}`;
        connectBtn.textContent = 'Connect';
      }
    });
  }
}

// ---- Load initial state ----
function loadInitialState() {
  // Bridge status
  chrome.runtime.sendMessage({ type: 'BRIDGE_STATUS' }, (response) => {
    state.set('bridgeConnected', response?.connected || false);
    if (response?.connected) loadSessions();
  });

  // Command log
  chrome.runtime.sendMessage({ type: 'GET_COMMAND_LOG' }, (response) => {
    if (response?.log) {
      state.set('commandFeed', response.log);
    }
  });
}

function loadSessions() {
  chrome.runtime.sendMessage({ type: 'BRIDGE_LIST_SESSIONS' }, (response) => {
    const sessions = response?.sessions || [];
    state.set('sessions', sessions);
    if (!state.get('activeSessionId') && sessions.length > 0) {
      state.set('activeSessionId', sessions[0].id);
    }
  });
}

// ---- Broadcast listener ----
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'AUTO_COMMAND_UPDATE': {
      const entry = message.entry;
      const feed = state.get('commandFeed') || [];
      const idx = feed.findIndex(e => e.id === entry.id);
      if (idx >= 0) {
        state.updateItem('commandFeed', e => e.id === entry.id, () => entry);
      } else {
        state.push('commandFeed', entry, 200);
      }
      break;
    }

    case 'AUTO_BROADCAST_SNAPSHOT': {
      const snap = {
        yaml: message.yaml,
        url: message.url,
        lines: message.lines || (message.yaml ? message.yaml.split('\n').length : 0),
        timestamp: message.timestamp || Date.now(),
        sessionId: message.sessionId,
      };
      state.push('snapshots', snap, 50);
      state.set('activeSnapshotIndex', (state.get('snapshots') || []).length - 1);
      break;
    }

    case 'AUTO_BROADCAST_STATUS': {
      state.updateItem('sessions', s => s.id === message.sessionId, (s) => ({
        ...s, state: message.state
      }));
      break;
    }

    case 'AUTO_BROADCAST_CONNECTION': {
      state.set('bridgeConnected', message.connected);
      if (message.connected) loadSessions();
      break;
    }
  }
});

// ---- Start ----
loadInitialState();
console.log('[Dashboard] Initialized');
