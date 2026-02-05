/**
 * Table Linearization and Parsing
 *
 * Demonstrates extracting visible text from HTML tables and parsing with IXML
 */

/**
 * Extract linearized text from an HTML table
 * @param {HTMLTableElement} table - The table element
 * @param {string} format - Output format: 'tab', 'pipe', or 'spaces'
 * @returns {string} Linearized text representation
 */
export function extractLinearizedTable(table, format = 'tab') {
  const rows = table.querySelectorAll('tr');
  const lines = [];

  rows.forEach(row => {
    const cells = row.querySelectorAll('td, th');
    const cellTexts = Array.from(cells).map(cell => cell.textContent.trim());

    if (cellTexts.length === 0) return;

    let line;
    switch (format) {
      case 'tab':
        line = cellTexts.join('\t');
        break;
      case 'pipe':
        line = '| ' + cellTexts.join(' | ') + ' |';
        break;
      case 'spaces':
        // Pad cells to align columns
        const maxLengths = getMaxColumnLengths(table);
        line = cellTexts.map((text, i) => text.padEnd(maxLengths[i])).join('  ');
        break;
      default:
        line = cellTexts.join('\t');
    }

    lines.push(line);
  });

  return lines.join('\n');
}

/**
 * Get maximum text length for each column
 * @param {HTMLTableElement} table
 * @returns {number[]} Array of max lengths per column
 */
function getMaxColumnLengths(table) {
  const rows = table.querySelectorAll('tr');
  const maxLengths = [];

  rows.forEach(row => {
    const cells = row.querySelectorAll('td, th');
    cells.forEach((cell, i) => {
      const length = cell.textContent.trim().length;
      maxLengths[i] = Math.max(maxLengths[i] || 0, length);
    });
  });

  return maxLengths;
}

/**
 * Generate IXML grammar for a table format
 * @param {string} format - 'tab', 'pipe', or 'spaces'
 * @param {number} columnCount - Number of columns
 * @returns {string} IXML grammar
 */
export function generateTableGrammar(format, columnCount) {
  switch (format) {
    case 'tab':
      return generateTabDelimitedGrammar(columnCount);
    case 'pipe':
      return generatePipeDelimitedGrammar(columnCount);
    case 'spaces':
      return generateSpaceSeparatedGrammar(columnCount);
    default:
      return generateTabDelimitedGrammar(columnCount);
  }
}

function generateTabDelimitedGrammar(columnCount) {
  const cellPattern = 'cell' + (columnCount > 1 ? ', (-tab, cell){' + (columnCount - 1) + '}' : '');

  return `table: header, rows .

header: ${cellPattern} .

rows: row+ .

row: -nl, ${cellPattern} .

cell: text .

text: [^#09#0A]+ .

-tab: #09 .
-nl: #0A .`;
}

function generatePipeDelimitedGrammar(columnCount) {
  const cellPattern = 'cell' + (columnCount > 1 ? ', (-pipe, cell){' + (columnCount - 1) + '}' : '');

  return `table: header, rows .

header: -pipe, ${cellPattern}, -pipe .

rows: row+ .

row: -nl, -pipe, ${cellPattern}, -pipe .

cell: -ws, text, -ws .

text: [^|#0A]+ .

-pipe: "|" .
-ws: " "* .
-nl: #0A .`;
}

function generateSpaceSeparatedGrammar(columnCount) {
  const cellPattern = 'cell' + (columnCount > 1 ? ', (-ws, cell){' + (columnCount - 1) + '}' : '');

  return `table: header, rows .

header: ${cellPattern} .

rows: row+ .

row: -nl, ${cellPattern} .

cell: word, (-sp, word)* .

word: [A-Za-z0-9@.\-]+ .

-ws: "  "+ .
-sp: " " .
-nl: #0A .`;
}

/**
 * Parse XML output to extract structured data
 * @param {string} xmlString - XML output from IXML parser
 * @returns {Object} Structured table data
 */
export function parseTableXml(xmlString) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlString, 'text/xml');

  const result = {
    headers: [],
    rows: []
  };

  // Extract headers
  const headerElement = xmlDoc.querySelector('header');
  if (headerElement) {
    const headerCells = headerElement.querySelectorAll('cell');
    result.headers = Array.from(headerCells).map(cell => cell.textContent.trim());
  }

  // Extract rows
  const rowsElement = xmlDoc.querySelector('rows');
  if (rowsElement) {
    const rowElements = rowsElement.querySelectorAll('row');
    rowElements.forEach(rowElement => {
      const cells = rowElement.querySelectorAll('cell');
      const rowData = Array.from(cells).map(cell => cell.textContent.trim());
      result.rows.push(rowData);
    });
  }

  return result;
}

/**
 * Map parsed data back to DOM elements
 * @param {Object} parsedData - Structured table data from parseTableXml
 * @param {HTMLTableElement} table - Original table element
 */
export function mapParsedDataToDom(parsedData, table) {
  const headerCells = table.querySelectorAll('thead th');
  const bodyRows = table.querySelectorAll('tbody tr');

  // Add data attributes to header cells
  headerCells.forEach((cell, i) => {
    cell.dataset.parsed = parsedData.headers[i] || '';
    cell.dataset.columnIndex = i;
  });

  // Add data attributes to body cells
  bodyRows.forEach((row, rowIndex) => {
    const cells = row.querySelectorAll('td');
    cells.forEach((cell, colIndex) => {
      cell.dataset.parsed = parsedData.rows[rowIndex]?.[colIndex] || '';
      cell.dataset.rowIndex = rowIndex;
      cell.dataset.columnIndex = colIndex;
    });
  });

  console.log('[Table Mapper] Mapped', parsedData.rows.length, 'rows to DOM');
}

/**
 * Complete flow: Extract → Parse → Map
 * @param {HTMLTableElement} table - Table to process
 * @param {Function} ixmlParser - Parser function (grammar, input) => xml
 * @param {string} format - 'tab', 'pipe', or 'spaces'
 * @returns {Promise<Object>} Result with parsed data and metadata
 */
export async function processTable(table, ixmlParser, format = 'tab') {
  console.log('[Table Processor] Starting complete flow...');

  // Step 1: Extract linearized text
  const linearized = extractLinearizedTable(table, format);
  console.log('[Table Processor] Extracted linearized text:', linearized.length, 'chars');

  // Step 2: Generate grammar
  const columnCount = table.querySelector('tr')?.querySelectorAll('td, th').length || 0;
  const grammar = generateTableGrammar(format, columnCount);
  console.log('[Table Processor] Generated grammar for', columnCount, 'columns');

  // Step 3: Parse with IXML
  const parseResult = await ixmlParser(grammar, linearized);
  if (!parseResult.success) {
    console.error('[Table Processor] Parsing failed:', parseResult.error);
    return {
      success: false,
      error: parseResult.error,
      linearized,
      grammar
    };
  }
  console.log('[Table Processor] Parsing succeeded');

  // Step 4: Extract structured data
  const parsedData = parseTableXml(parseResult.xml);
  console.log('[Table Processor] Extracted', parsedData.rows.length, 'rows');

  // Step 5: Map back to DOM
  mapParsedDataToDom(parsedData, table);

  return {
    success: true,
    linearized,
    grammar,
    xml: parseResult.xml,
    parsedData,
    metadata: {
      format,
      columnCount,
      rowCount: parsedData.rows.length
    }
  };
}

/**
 * Demo: Log table structure analysis
 * @param {HTMLTableElement} table
 */
export function analyzeTableStructure(table) {
  const rows = table.querySelectorAll('tr');
  const headerRow = table.querySelector('thead tr') || rows[0];
  const bodyRows = table.querySelectorAll('tbody tr');

  const structure = {
    totalRows: rows.length,
    headerCells: headerRow?.querySelectorAll('th, td').length || 0,
    bodyRows: bodyRows.length,
    columnCount: headerRow?.querySelectorAll('th, td').length || 0,
    headers: [],
    sampleData: []
  };

  // Extract headers
  const headerCells = headerRow?.querySelectorAll('th, td');
  if (headerCells) {
    structure.headers = Array.from(headerCells).map(cell => cell.textContent.trim());
  }

  // Extract first 3 rows as sample
  bodyRows.forEach((row, i) => {
    if (i < 3) {
      const cells = row.querySelectorAll('td');
      const rowData = Array.from(cells).map(cell => cell.textContent.trim());
      structure.sampleData.push(rowData);
    }
  });

  console.log('[Table Analyzer] Structure:', structure);
  return structure;
}
