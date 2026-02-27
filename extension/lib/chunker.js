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
  let result;
  switch (contentType) {
    case 'api_reference':
    case 'spec':
    case 'documentation':
      result = chunkByHeadings(content);
      break;

    case 'dashboard':
      result = chunkByTables(content);
      break;

    case 'general':
    default:
      result = chunkByTokens(content);
      break;
  }

  // Attach keywords to every chunk
  result.chunks.forEach(chunk => {
    chunk.keywords = extractKeywords(chunk);
  });

  return result;
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

  return { chunks, structuredRecords: [] };
}

/**
 * Chunk by tables
 * Extracts tables as semantic units for dashboards
 */
function chunkByTables(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const chunks = [];
  const structuredRecords = [];
  const tables = doc.querySelectorAll('table');
  const MAX_RECORDS_PER_TABLE = 200;

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

    // Extract table rows (text representation for chunk)
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
      text: `${title}\n${content}`,
      tableIndex: index
    });

    // Extract structured records: zip headers with cell values per data row
    if (headers.length > 0) {
      const dataRows = Array.from(table.querySelectorAll('tbody tr, tr'))
        .filter(tr => tr.querySelectorAll('td').length > 0);

      let recordCount = 0;
      for (const tr of dataRows) {
        if (recordCount >= MAX_RECORDS_PER_TABLE) {
          console.warn(`[Chunker] Table ${index + 1} truncated at ${MAX_RECORDS_PER_TABLE} records`);
          break;
        }

        const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
        const record = {};
        headers.forEach((header, i) => {
          if (i < cells.length) {
            // Auto-cast numeric values
            const raw = cells[i];
            const cleaned = raw.replace(/[$,%]/g, '');
            const num = parseFloat(cleaned);
            record[header] = !isNaN(num) && raw.match(/^[\d$.,%-]+$/) ? num : raw;
          }
        });

        if (Object.keys(record).length > 0) {
          structuredRecords.push({ tableIndex: index, headers, fields: record });
          recordCount++;
        }
      }
    }
  });

  // If no tables found, fall back to token chunking
  if (chunks.length === 0) {
    return chunkByTokens(doc.body.textContent);
  }

  return { chunks, structuredRecords };
}

/**
 * Chunk by tokens (sliding window)
 * General-purpose chunking for narrative content
 */
function chunkByTokens(text, chunkSize = 500, overlap = 50) {
  if (!text || text.length === 0) {
    return { chunks: [], structuredRecords: [] };
  }

  const chunks = [];
  const words = text.split(/\s+/);

  // If text is short enough, return as single chunk
  if (words.length <= chunkSize) {
    return { chunks: [{
      type: 'token',
      content: text,
      text: text
    }], structuredRecords: [] };
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

  return { chunks, structuredRecords: [] };
}

/**
 * Extract keywords from a chunk using pure regex string processing.
 * Identifies: table headers, heading words, title-case phrases,
 * technical terms (camelCase, SCREAMING_CASE, dotted.paths),
 * and numeric-with-units patterns.
 * @param {object} chunk - A chunk object with text, title, headers, type fields
 * @returns {string[]} Array of lowercase keywords, max 50
 */
export function extractKeywords(chunk) {
  const keywords = new Set();

  // 1. Table headers (from chunk.headers if present)
  if (chunk.headers && Array.isArray(chunk.headers)) {
    chunk.headers.forEach(h => {
      const cleaned = h.trim().toLowerCase();
      if (cleaned && cleaned.length > 1) {
        keywords.add(cleaned);
      }
    });
  }

  // 2. Heading words (from chunk.title if present)
  if (chunk.title) {
    chunk.title.split(/\s+/).forEach(word => {
      const cleaned = word.replace(/[^\w-]/g, '').toLowerCase();
      if (cleaned && cleaned.length > 2) {
        keywords.add(cleaned);
      }
    });
  }

  const text = chunk.text || chunk.content || '';

  // 3. Title-case multi-word phrases (proper nouns, product names)
  const titleCasePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
  let match;
  while ((match = titleCasePattern.exec(text)) !== null) {
    keywords.add(match[1].toLowerCase());
  }

  // 4. camelCase terms
  const camelCasePattern = /\b([a-z]+[A-Z][a-zA-Z]*)\b/g;
  while ((match = camelCasePattern.exec(text)) !== null) {
    keywords.add(match[1].toLowerCase());
  }

  // 5. SCREAMING_CASE terms
  const screamingPattern = /\b([A-Z][A-Z0-9_]{2,})\b/g;
  while ((match = screamingPattern.exec(text)) !== null) {
    keywords.add(match[1].toLowerCase());
  }

  // 6. dotted.path terms (e.g., console.log, req.body.name)
  const dottedPattern = /\b([a-zA-Z]\w+(?:\.\w+)+)\b/g;
  while ((match = dottedPattern.exec(text)) !== null) {
    keywords.add(match[1].toLowerCase());
  }

  // 7. Numeric-with-units patterns ($42.99, 500ms, 10GB, 99.9%)
  const numericPattern = /(\$[\d,.]+|\d+(?:\.\d+)?(?:ms|s|gb|mb|kb|tb|px|em|rem|hz|khz|%|fps))\b/gi;
  while ((match = numericPattern.exec(text)) !== null) {
    keywords.add(match[1].toLowerCase());
  }

  // Cap at 50 keywords
  return Array.from(keywords).slice(0, 50);
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
