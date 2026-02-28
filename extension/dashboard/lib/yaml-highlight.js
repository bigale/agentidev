/**
 * Regex-based YAML syntax highlighting for dark theme (#1e1e1e background).
 * Returns HTML string with <span> elements for colored tokens.
 */

const COLORS = {
  key: '#569cd6',
  string: '#ce9178',
  ref: '#4ec9b0',
  attr: '#9cdcfe',
  comment: '#6a9955',
  lineNum: '#858585',
  bool: '#569cd6',
  number: '#b5cea8',
};

// Role patterns that get collapsible wrappers at indent level 0-1
const COLLAPSIBLE_ROLES = /^(\s{0,2})(- role: (?:heading|navigation|generic|list|region|main|banner|complementary))/;

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function highlightLine(line) {
  let escaped = escapeHtml(line);

  // Comments
  if (/^\s*#/.test(line)) {
    return `<span style="color:${COLORS.comment}">${escaped}</span>`;
  }

  // Refs: [ref=eNNN]
  escaped = escaped.replace(
    /\[ref=e(\d+)\]/g,
    `<span style="color:${COLORS.ref}">[ref=e$1]</span>`
  );

  // Key: value pattern
  escaped = escaped.replace(
    /^(\s*-?\s*)([a-zA-Z_][\w]*)(:\s)/,
    `$1<span style="color:${COLORS.key}">$2</span>$3`
  );

  // Attribute-like patterns: key=value
  escaped = escaped.replace(
    /(\s)([a-zA-Z_][\w]*)=/g,
    `$1<span style="color:${COLORS.attr}">$2</span>=`
  );

  // Boolean values
  escaped = escaped.replace(
    /:\s+(true|false)\s*$/,
    `: <span style="color:${COLORS.bool}">$1</span>`
  );

  // Numeric values
  escaped = escaped.replace(
    /:\s+(\d+(?:\.\d+)?)\s*$/,
    `: <span style="color:${COLORS.number}">$1</span>`
  );

  // Quoted strings
  escaped = escaped.replace(
    /(&quot;[^&]*&quot;|&#x27;[^&]*&#x27;)/g,
    `<span style="color:${COLORS.string}">$1</span>`
  );

  // Unquoted string values after colon (if not already highlighted)
  escaped = escaped.replace(
    /(:\s+)(?!<span)([^\s<][^<]*?)(\s*$)/,
    `$1<span style="color:${COLORS.string}">$2</span>$3`
  );

  return escaped;
}

/**
 * Highlight YAML text with syntax coloring.
 * @param {string} yamlText - Raw YAML
 * @param {Object} options
 * @param {boolean} options.lineNumbers - Show line numbers (default true)
 * @param {boolean} options.collapsible - Enable collapsible sections (default true)
 * @returns {string} HTML string
 */
export function highlightYAML(yamlText, { lineNumbers = true, collapsible = true } = {}) {
  if (!yamlText) return '';
  const lines = yamlText.split('\n');
  const result = [];
  let inCollapsible = false;
  let collapsibleId = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumStr = lineNumbers
      ? `<span style="color:${COLORS.lineNum};user-select:none;display:inline-block;width:4ch;text-align:right;margin-right:1ch;">${i + 1}</span>`
      : '';

    // Check for collapsible section start
    if (collapsible) {
      const match = line.match(COLLAPSIBLE_ROLES);
      if (match) {
        if (inCollapsible) result.push('</div>');
        collapsibleId++;
        const sectionId = `yaml-section-${collapsibleId}`;
        result.push(
          `<div class="dash-yaml-collapse" data-section="${sectionId}">` +
          `${lineNumStr}<span class="dash-yaml-toggle" data-target="${sectionId}" style="cursor:pointer;color:${COLORS.comment};user-select:none;">&#9660; </span>${highlightLine(line)}`
        );
        result.push(`<div id="${sectionId}" class="dash-yaml-section">`);
        inCollapsible = true;
        continue;
      }

      // End collapsible on next same-level or lower-indent entry
      if (inCollapsible && /^[^\s]/.test(line) && !COLLAPSIBLE_ROLES.test(line)) {
        result.push('</div></div>');
        inCollapsible = false;
      }
    }

    result.push(`${lineNumStr}${highlightLine(line)}`);
  }

  if (inCollapsible) result.push('</div></div>');

  return result.join('\n');
}

/** Attach toggle listeners to collapsible sections inside a container element. */
export function attachCollapseHandlers(container) {
  container.querySelectorAll('.dash-yaml-toggle').forEach(toggle => {
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetId = toggle.dataset.target;
      const section = container.querySelector(`#${targetId}`);
      if (!section) return;
      const collapsed = section.style.display === 'none';
      section.style.display = collapsed ? '' : 'none';
      toggle.innerHTML = collapsed ? '&#9660; ' : '&#9654; ';
    });
  });
}
