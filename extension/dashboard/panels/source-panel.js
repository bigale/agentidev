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
    this.onSave = null;             // set by dashboard: (source) => void
    this.onElementClick = null;     // set by dashboard: (element, suggestions, event) => void
    this._snapshotRaw = null;
    this._savedSource = null;       // last-saved source for dirty tracking
    this._currentScriptName = null; // name of loaded library script

    this._initMonaco();
    this._initSnapFilter();
  }

  _initMonaco() {
    this.editor = monaco.editor.create(this.monacoContainer, {
      value: '',
      language: 'javascript',
      theme: 'vs-dark',
      readOnly: false,
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

    // Ctrl+S / Cmd+S → save
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      this._handleSave();
    });

    // Track edits for dirty indicator
    this.editor.onDidChangeModelContent(() => {
      this._updateDirtyIndicator();
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
  loadSource(source, filePath, checkpointLines, activeBreakpoints, currentCheckpointName, scriptName) {
    this.checkpointLines = checkpointLines || {};
    this.activeBreakpoints = activeBreakpoints || [];
    this.currentCheckpoint = currentCheckpointName || null;
    this._savedSource = source;
    this._currentScriptName = scriptName || null;

    // Update filename label
    const label = filePath
      ? filePath.split('/').slice(-2).join('/') // last 2 path segments
      : 'Unknown file';
    this.fileLabelEl.textContent = label;
    this.fileLabelEl.title = filePath || '';
    this.fileLabelEl.dataset.baseLabel = label;

    // Set model — dispose existing model with same URI before creating
    const uri = monaco.Uri.parse(`file://${filePath || '/script.mjs'}`);
    const existing = monaco.editor.getModel(uri);
    if (existing) existing.dispose();
    const model = monaco.editor.createModel(source, 'javascript', uri);
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
   * Lines with [ref=eNNN] are rendered as clickable elements.
   */
  renderSnapshot(snapshot, el) {
    this._snapshotRaw = snapshot?.yaml || '';
    el.innerHTML = '';

    const lines = this._snapshotRaw.split('\n');
    if (this.snapInfoEl) {
      this.snapInfoEl.textContent = `${lines.length} lines`;
    }

    for (const line of lines) {
      const parsed = this._parseSnapshotElement(line);
      if (parsed) {
        const span = document.createElement('span');
        span.className = 'dash-snap-element';
        span.textContent = line + '\n';
        span.dataset.ref = parsed.ref;
        span.title = `Click to generate code for this ${parsed.role || 'element'}`;
        span.addEventListener('click', (e) => {
          if (this.onElementClick) {
            this.onElementClick(parsed, e);
          }
        });
        el.appendChild(span);
      } else {
        el.appendChild(document.createTextNode(line + '\n'));
      }
    }
  }

  /**
   * Parse a YAML snapshot line for an actionable element with [ref=eNNN].
   * @param {string} line
   * @returns {{ ref: string, role: string, text: string, type: string, name: string }|null}
   */
  _parseSnapshotElement(line) {
    const refMatch = line.match(/\[ref=(e\d+)\]/);
    if (!refMatch) return null;

    const ref = refMatch[1];
    // Try to extract role from YAML structure: "- role name [ref=eNNN]" or "  role: name [ref=eNNN]"
    const roleMatch = line.match(/^\s*-?\s*(\w+)\b/);
    const role = roleMatch ? roleMatch[1].toLowerCase() : '';

    // Extract text content (typically after the role keyword)
    const textMatch = line.match(/(?::\s*|^\s*-?\s*\w+\s+)([^[\]]+?)(?:\s*\[ref=)/);
    const text = textMatch ? textMatch[1].trim() : '';

    // Try to extract type for inputs
    const typeMatch = line.match(/type:\s*(\w+)/i);
    const type = typeMatch ? typeMatch[1] : '';

    // Try to extract name
    const nameMatch = line.match(/name:\s*["']?(\w+)/i);
    const name = nameMatch ? nameMatch[1] : '';

    return { ref, role, text, type, name };
  }

  _applySnapFilter(filter) {
    if (!this._snapshotRaw) return;
    if (!filter) {
      // Re-render with clickable elements
      this.renderSnapshot({ yaml: this._snapshotRaw }, this.snapshotEl);
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

  _handleSave() {
    if (!this._currentScriptName || !this.onSave) return;
    const source = this.editor.getValue();
    this.onSave(this._currentScriptName, source);
    this._savedSource = source;
    this._updateDirtyIndicator();
  }

  _updateDirtyIndicator() {
    if (!this.fileLabelEl || !this._savedSource) return;
    const baseLabel = this.fileLabelEl.dataset.baseLabel || '';
    const current = this.editor.getValue();
    const dirty = current !== this._savedSource;
    this.fileLabelEl.textContent = dirty ? `${baseLabel}  \u25CF` : baseLabel;
  }

  /**
   * Insert code at the current cursor position, matching the indentation of the current line.
   * Marks the editor dirty after insertion.
   * @param {string} code - Code to insert
   */
  insertSnippet(code) {
    if (!this.editor) return;
    const position = this.editor.getPosition();
    if (!position) return;

    // Match indentation of the current line
    const model = this.editor.getModel();
    const currentLine = model.getLineContent(position.lineNumber);
    const indentMatch = currentLine.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1] : '';

    // Indent all lines of the snippet to match
    const indented = code.split('\n').map((line, i) =>
      i === 0 ? line : indent + line
    ).join('\n');

    // Insert via executeEdits for undo support
    this.editor.executeEdits('snippet-insert', [{
      range: new monaco.Range(
        position.lineNumber, position.column,
        position.lineNumber, position.column
      ),
      text: indented + '\n',
      forceMoveMarkers: true,
    }]);

    this.editor.focus();
    this._updateDirtyIndicator();
  }

  /**
   * Unload the current script — clear editor, reset state.
   */
  unload() {
    this._currentScriptName = null;
    this._savedSource = null;
    this.checkpointLines = {};
    this.activeBreakpoints = [];
    this.currentCheckpoint = null;

    if (this.editor) {
      const model = this.editor.getModel();
      if (model) model.dispose();
      const emptyModel = monaco.editor.createModel('', 'javascript');
      this.editor.setModel(emptyModel);
    }
    if (this.decorations) this.decorations.set([]);

    this.fileLabelEl.textContent = 'No script selected';
    this.fileLabelEl.title = '';
    this.fileLabelEl.dataset.baseLabel = 'No script selected';
  }

  getSource() {
    return this.editor ? this.editor.getValue() : '';
  }

  getScriptName() {
    return this._currentScriptName;
  }

  isDirty() {
    if (!this._savedSource || !this.editor) return false;
    return this.editor.getValue() !== this._savedSource;
  }
}
