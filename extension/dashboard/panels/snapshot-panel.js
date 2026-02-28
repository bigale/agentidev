/**
 * Snapshot Panel — top-right.
 * Three modes: single view (syntax highlighted), diff view (side-by-side), empty.
 * Snapshot history dropdown, text filter, collapsible sections.
 */

import { highlightYAML, attachCollapseHandlers } from '../lib/yaml-highlight.js';
import { computeDiff, renderDiff, diffStats } from '../lib/yaml-diff.js';

export function initSnapshotPanel(container, state) {
  const body = container.querySelector('#dash-snapshot-body');
  const viewer = container.querySelector('#dash-snap-viewer');
  const toolbar = container.querySelector('#dash-snap-toolbar');
  const infoBadge = container.querySelector('#dash-snap-info');

  // Build toolbar
  toolbar.innerHTML = `
    <select id="dash-snap-select" class="dash-filter-select" title="Snapshot history">
      <option value="">No snapshots</option>
    </select>
    <input id="dash-snap-filter" class="dash-filter-input" placeholder="Filter lines..." style="max-width:160px;">
    <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#8f8faf;cursor:pointer;">
      <input type="checkbox" id="dash-diff-toggle"> Diff
    </label>
    <button id="dash-diff-a" class="dash-btn-sm" style="display:none;" disabled>A</button>
    <button id="dash-diff-b" class="dash-btn-sm" style="display:none;" disabled>B</button>
    <span id="dash-diff-stats" style="font-size:10px;color:#8f8faf;display:none;"></span>
  `;

  const snapSelect = toolbar.querySelector('#dash-snap-select');
  const snapFilter = toolbar.querySelector('#dash-snap-filter');
  const diffToggle = toolbar.querySelector('#dash-diff-toggle');
  const diffABtn = toolbar.querySelector('#dash-diff-a');
  const diffBBtn = toolbar.querySelector('#dash-diff-b');
  const diffStatsEl = toolbar.querySelector('#dash-diff-stats');

  snapSelect.addEventListener('change', () => {
    const idx = parseInt(snapSelect.value, 10);
    if (!isNaN(idx)) state.set('activeSnapshotIndex', idx);
  });

  snapFilter.addEventListener('input', () => renderView());

  diffToggle.addEventListener('change', () => {
    state.set('diffMode', diffToggle.checked);
    state.set('diffSlotA', null);
    state.set('diffSlotB', null);
  });

  diffABtn.addEventListener('click', () => {
    state.set('diffSlotA', state.get('activeSnapshotIndex'));
    diffABtn.textContent = `A: #${state.get('activeSnapshotIndex')}`;
  });

  diffBBtn.addEventListener('click', () => {
    state.set('diffSlotB', state.get('activeSnapshotIndex'));
    diffBBtn.textContent = `B: #${state.get('activeSnapshotIndex')}`;
  });

  function updateDropdown() {
    const snapshots = state.get('snapshots') || [];
    const activeIdx = state.get('activeSnapshotIndex');

    if (snapshots.length === 0) {
      snapSelect.innerHTML = '<option value="">No snapshots</option>';
      return;
    }

    snapSelect.innerHTML = snapshots.map((snap, i) => {
      const time = new Date(snap.timestamp).toLocaleTimeString('en-US', { hour12: false });
      const lines = snap.lines || (snap.yaml ? snap.yaml.split('\n').length : 0);
      return `<option value="${i}" ${i === activeIdx ? 'selected' : ''}>#${i} ${time} (${lines}L)</option>`;
    }).join('');
  }

  function renderView() {
    const snapshots = state.get('snapshots') || [];
    const isDiff = state.get('diffMode');
    const slotA = state.get('diffSlotA');
    const slotB = state.get('diffSlotB');

    // Toggle diff UI
    diffABtn.style.display = isDiff ? '' : 'none';
    diffBBtn.style.display = isDiff ? '' : 'none';
    diffStatsEl.style.display = isDiff ? '' : 'none';
    diffABtn.disabled = snapshots.length === 0;
    diffBBtn.disabled = snapshots.length === 0;

    if (isDiff && slotA !== null && slotB !== null) {
      renderDiffView(snapshots, slotA, slotB);
      return;
    }

    if (isDiff) {
      viewer.style.display = '';
      viewer.innerHTML = '<div class="dash-empty" style="color:#5f5f7f;">Select two snapshots with A and B buttons</div>';
      infoBadge.textContent = 'Diff mode';
      // Remove any existing diff container
      const existing = body.querySelector('.dash-diff-container');
      if (existing) existing.remove();
      return;
    }

    // Single view mode
    const existing = body.querySelector('.dash-diff-container');
    if (existing) existing.remove();
    viewer.style.display = '';

    const activeIdx = state.get('activeSnapshotIndex');
    if (snapshots.length === 0 || activeIdx < 0 || activeIdx >= snapshots.length) {
      viewer.innerHTML = '<span style="color:#5f5f7f;">No snapshot</span>';
      infoBadge.textContent = '';
      return;
    }

    const snap = snapshots[activeIdx];
    const filter = snapFilter.value.toLowerCase().trim();
    let yaml = snap.yaml || '';
    let lineCount = yaml.split('\n').length;

    if (filter) {
      const lines = yaml.split('\n');
      const filtered = lines.filter(l => l.toLowerCase().includes(filter));
      yaml = filtered.length > 0
        ? `[${filtered.length}/${lines.length} lines matching]\n\n${filtered.join('\n')}`
        : `No lines matching "${filter}"`;
      lineCount = filtered.length;
    }

    viewer.innerHTML = highlightYAML(yaml);
    attachCollapseHandlers(viewer);
    infoBadge.textContent = `${lineCount}L | ${new Date(snap.timestamp).toLocaleTimeString()}`;
  }

  function renderDiffView(snapshots, idxA, idxB) {
    const snapA = snapshots[idxA];
    const snapB = snapshots[idxB];

    if (!snapA || !snapB) {
      viewer.innerHTML = '<span style="color:#5f5f7f;">Invalid snapshot selection</span>';
      return;
    }

    const diff = computeDiff(snapA.yaml || '', snapB.yaml || '');
    const stats = diffStats(diff);
    diffStatsEl.textContent = `+${stats.added} -${stats.removed} =${stats.same}`;

    const html = renderDiff(diff);
    viewer.style.display = 'none';

    // Remove old diff container
    const old = body.querySelector('.dash-diff-container');
    if (old) old.remove();

    body.insertAdjacentHTML('beforeend', html);
    infoBadge.textContent = `Diff #${idxA} vs #${idxB}`;

    // Sync scroll between sides
    const diffContainer = body.querySelector('.dash-diff-container');
    if (diffContainer) {
      const sides = diffContainer.querySelectorAll('.dash-diff-side');
      if (sides.length === 2) {
        let syncing = false;
        sides.forEach((side, i) => {
          side.addEventListener('scroll', () => {
            if (syncing) return;
            syncing = true;
            const other = sides[1 - i];
            other.scrollTop = side.scrollTop;
            syncing = false;
          });
        });
      }
    }
  }

  state.addEventListener('change', (e) => {
    const k = e.detail.key;
    if (k === 'snapshots' || k === 'activeSnapshotIndex') {
      updateDropdown();
      renderView();
    }
    if (k === 'diffMode' || k === 'diffSlotA' || k === 'diffSlotB') {
      renderView();
    }
  });

  updateDropdown();
  renderView();
}
