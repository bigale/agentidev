/**
 * Content Chunking Module
 *
 * Intelligently splits content into semantic chunks based on content type.
 * Uses structured parsing for specs/docs, token chunking for general content.
 */

/**
 * Chunk content based on its type
 */
export function chunkContent(content, contentType) {
  switch (contentType) {
    case 'api_reference':
    case 'spec':
      return chunkByHeadings(content);

    case 'documentation':
      return chunkByHeadings(content);

    case 'dashboard':
      return chunkByTables(content);

    case 'general':
    default:
      return chunkByTokens(content);
  }
}

/**
 * Chunk by headings (H1-H6)
 * Preserves document structure for specs and documentation
 */
function chunkByHeadings(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const chunks = [];
  const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');

  headings.forEach((heading, index) => {
    const level = parseInt(heading.tagName[1]);
    const title = heading.textContent.trim();

    // Collect content until next heading of same or higher level
    let content = '';
    let currentNode = heading.nextElementSibling;

    while (currentNode) {
      // Stop at next heading of same or higher level
      if (currentNode.tagName.match(/^H[1-6]$/)) {
        const nextLevel = parseInt(currentNode.tagName[1]);
        if (nextLevel <= level) {
          break;
        }
      }

      content += currentNode.textContent + '\n';
      currentNode = currentNode.nextElementSibling;
    }

    if (content.trim()) {
      chunks.push({
        type: 'heading',
        level: level,
        title: title,
        content: content.trim(),
        text: `${title}\n${content.trim()}`
      });
    }
  });

  // If no headings found, fall back to token chunking
  if (chunks.length === 0) {
    return chunkByTokens(doc.body.textContent);
  }

  return chunks;
}

/**
 * Chunk by tables
 * Extracts tables as semantic units for dashboards
 */
function chunkByTables(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const chunks = [];
  const tables = doc.querySelectorAll('table');

  tables.forEach((table, index) => {
    // Get table caption or preceding heading
    let title = `Table ${index + 1}`;
    const caption = table.querySelector('caption');
    if (caption) {
      title = caption.textContent.trim();
    } else {
      // Look for preceding heading
      let prev = table.previousElementSibling;
      while (prev && !prev.tagName.match(/^H[1-6]$/)) {
        prev = prev.previousElementSibling;
      }
      if (prev) {
        title = prev.textContent.trim();
      }
    }

    // Extract table headers
    const headers = Array.from(table.querySelectorAll('th'))
      .map(th => th.textContent.trim());

    // Extract table rows
    const rows = Array.from(table.querySelectorAll('tr'))
      .map(tr => {
        return Array.from(tr.querySelectorAll('td'))
          .map(td => td.textContent.trim())
          .join(' | ');
      })
      .filter(row => row.length > 0);

    const content = [
      headers.join(' | '),
      ...rows
    ].join('\n');

    chunks.push({
      type: 'table',
      title: title,
      headers: headers,
      content: content,
      text: `${title}\n${content}`
    });
  });

  // If no tables found, fall back to token chunking
  if (chunks.length === 0) {
    return chunkByTokens(doc.body.textContent);
  }

  return chunks;
}

/**
 * Chunk by tokens (sliding window)
 * General-purpose chunking for narrative content
 */
function chunkByTokens(text, chunkSize = 500, overlap = 50) {
  if (!text || text.length === 0) {
    return [];
  }

  const chunks = [];
  const words = text.split(/\s+/);

  // If text is short enough, return as single chunk
  if (words.length <= chunkSize) {
    return [{
      type: 'token',
      content: text,
      text: text
    }];
  }

  // Sliding window chunking
  for (let i = 0; i < words.length; i += (chunkSize - overlap)) {
    const chunk = words.slice(i, i + chunkSize).join(' ');

    chunks.push({
      type: 'token',
      content: chunk,
      text: chunk
    });

    // Break if we've reached the end
    if (i + chunkSize >= words.length) {
      break;
    }
  }

  return chunks;
}

/**
 * Extract code blocks from content
 * Useful for API documentation with examples
 */
export function extractCodeBlocks(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const codeBlocks = [];
  const blocks = doc.querySelectorAll('pre code, pre, code');

  blocks.forEach((block, index) => {
    const code = block.textContent.trim();

    // Skip inline code (too short)
    if (code.length < 50) {
      return;
    }

    // Try to detect language from class names
    let language = 'unknown';
    const classNames = block.className || block.parentElement?.className || '';
    const langMatch = classNames.match(/language-(\w+)/);
    if (langMatch) {
      language = langMatch[1];
    }

    codeBlocks.push({
      type: 'code',
      language: language,
      content: code,
      text: `Code (${language}):\n${code}`
    });
  });

  return codeBlocks;
}
