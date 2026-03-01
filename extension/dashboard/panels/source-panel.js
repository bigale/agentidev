/**
 * Source Panel — Monaco editor with checkpoint/breakpoint gutter decorations.
 *
 * Decoration logic:
 *  - Grey ring (○) at every checkpoint line (available but inactive)
 *  - Red dot  (●) at active breakpoint lines
 *  - Yellow arrow (▶) + line highlight at the currently-paused checkpoint
 *
 * Gutter click toggles breakpoints. Callbacks fire onBreakpointToggle.
 */

export class SourcePanel {
  constructor(monacoContainer, snapshotEl, fileLabelEl, snapFilterEl, snapInfoEl) {
    this.monacoContainer = monacoContainer;
    this.snapshotEl = snapshotEl;
    this.fileLabelEl = fileLabelEl;
    this.snapFilterEl = snapFilterEl;
    this.snapInfoEl = snapInfoEl;

    this.editor = null;
    this.decorations = null;   // IDecorationsCollection
    this.checkpointLines = {}; // { name: lineNumber }
    this.activeBreakpoints = [];
    this.currentCheckpoint = null;
    this.onBreakpointToggle = null; // set by dashboard after construction
    this._snapshotRaw = null;

    this._initMonaco();
    this._initSnapFilter();
  }

  _initMonaco() {
    this.editor = monaco.editor.create(this.monacoContainer, {
      value: '',
      language: 'javascript',
      theme: 'vs-dark',
      readOnly: true,
      minimap: { enabled: false },
      lineNumbers: 'on',
      glyphMargin: true,        // needed for breakpoint icons in gutter
      folding: true,
      wordWrap: 'off',
      scrollBeyondLastLine: false,
      fontSize: 12,
      lineHeight: 18,
      renderLineHighlight: 'none',
      automaticLayout: true,    // resizes with container
      contextmenu: false,
      overviewRulerLanes: 0,
    });

    // Gutter click → toggle breakpoint
    this.editor.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
        const line = e.target.position?.lineNumber;
        if (!line) return;
        // Find which checkpoint is at this line
        const name = Object.entries(this.checkpointLines).find(([, l]) => l === line)?.[0];
        if (name && this.onBreakpointToggle) {
          this.onBreakpointToggle(name, !this.activeBreakpoints.includes(name));
        }
      }
    });

    this.decorations = this.editor.createDecorationsCollection([]);
  }

  _initSnapFilter() {
    if (!this.snapFilterEl) return;
    this.snapFilterEl.addEventListener('input', () => {
      this._applySnapFilter(this.snapFilterEl.value.trim());
    });
  }

  /**
   * Load a source file into Monaco and set up checkpoint lines.
   */
  loadSource(source, filePath, checkpointLines, activeBreakpoints, currentCheckpointName) {
    this.checkpointLines = checkpointLines || {};
    this.activeBreakpoints = activeBreakpoints || [];
    this.currentCheckpoint = currentCheckpointName || null;

    // Update filename label
    this.fileLabelEl.textContent = filePath
      ? filePath.split('/').slice(-2).join('/') // last 2 path segments
      : 'Unknown file';
    this.fileLabelEl.title = filePath || '';

    // Set model — create new model if language/path changed
    const model = monaco.editor.createModel(source, 'javascript',
      monaco.Uri.parse(`file://${filePath || '/script.mjs'}`));
    this.editor.setModel(model);

    this.updateDecorations(this.activeBreakpoints, this.currentCheckpoint);
  }

  /**
   * Update gutter decorations without reloading source.
   * Called whenever breakpoints or checkpoint state changes.
   */
  updateDecorations(activeBreakpoints, currentCheckpointName) {
    this.activeBreakpoints = activeBreakpoints || [];
    this.currentCheckpoint = currentCheckpointName || null;

    if (!this.editor || !this.checkpointLines) return;

    const decorations = [];

    for (const [name, line] of Object.entries(this.checkpointLines)) {
      const isCurrent = name === this.currentCheckpoint;
      const isActive  = this.activeBreakpoints.includes(name);

      if (isCurrent) {
        // Yellow arrow + line highlight
        decorations.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            glyphMarginClassName: 'monaco-bp-current',
            className: 'monaco-line-current',
            isWholeLine: true,
            glyphMarginHoverMessage: { value: `⏸ Paused at: **${name}**` },
          },
        });
      } else if (isActive) {
        // Red dot — active breakpoint
        decorations.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            glyphMarginClassName: 'monaco-bp-active',
            glyphMarginHoverMessage: { value: `🔴 Breakpoint: **${name}** (click to remove)` },
          },
        });
      } else {
        // Grey ring — available but inactive
        decorations.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            glyphMarginClassName: 'monaco-bp-inactive',
            glyphMarginHoverMessage: { value: `○ Checkpoint: **${name}** (click to set breakpoint)` },
          },
        });
      }
    }

    this.decorations.set(decorations);
  }

  /**
   * Scroll Monaco to the line containing a named checkpoint.
   */
  scrollToCheckpoint(checkpointName) {
    const line = this.checkpointLines[checkpointName];
    if (!line || !this.editor) return;
    this.editor.revealLineInCenter(line);
  }

  /**
   * Render a YAML snapshot string into the snapshot view element.
   */
  renderSnapshot(snapshot, el) {
    this._snapshotRaw = snapshot?.yaml || '';
    el.textContent = this._snapshotRaw;
    if (this.snapInfoEl) {
      const lines = this._snapshotRaw.split('\n').length;
      this.snapInfoEl.textContent = `${lines} lines`;
    }
  }

  _applySnapFilter(filter) {
    if (!this._snapshotRaw) return;
    if (!filter) {
      this.snapshotEl.textContent = this._snapshotRaw;
      if (this.snapInfoEl) {
        this.snapInfoEl.textContent = `${this._snapshotRaw.split('\n').length} lines`;
      }
      return;
    }
    const lines = this._snapshotRaw.split('\n');
    const matches = lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()));
    this.snapshotEl.textContent = matches.length > 0
      ? `[${matches.length}/${lines.length} matching]\n\n${matches.join('\n')}`
      : `No lines matching "${filter}"`;
    if (this.snapInfoEl) {
      this.snapInfoEl.textContent = `${matches.length}/${lines.length} lines`;
    }
  }
}
