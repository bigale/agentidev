# Linearized Table Parsing with IXML

## Concept

Parse the **visible text representation** of HTML tables (what users see) instead of the HTML markup itself. This aligns with IXML's design for unstructured text parsing.

## Example 1: Simple Data Table

### Original HTML
```html
<table>
  <thead>
    <tr>
      <th>Name</th>
      <th>Email</th>
      <th>Phone</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>John Doe</td>
      <td>john@example.com</td>
      <td>555-1234</td>
    </tr>
    <tr>
      <td>Jane Smith</td>
      <td>jane@example.com</td>
      <td>555-5678</td>
    </tr>
  </tbody>
</table>
```

### Linearized Text Representation
```
Name           Email                Phone
John Doe       john@example.com     555-1234
Jane Smith     jane@example.com     555-5678
```

### IXML Grammar
```ixml
table: header, -nl, rows .

header: cell, -ws, cell, -ws, cell .

rows: row+ .

row: -nl, cell, -ws, cell, -ws, cell .

cell: text .

text: [A-Za-z0-9@.\- ]+ .

-ws: "       "+ .  { whitespace separator }
-nl: #0A .          { newline }
```

### Expected XML Output
```xml
<table>
  <header>
    <cell>Name</cell>
    <cell>Email</cell>
    <cell>Phone</cell>
  </header>
  <rows>
    <row>
      <cell>John Doe</cell>
      <cell>john@example.com</cell>
      <cell>555-1234</cell>
    </row>
    <row>
      <cell>Jane Smith</cell>
      <cell>jane@example.com</cell>
      <cell>555-5678</cell>
    </row>
  </rows>
</table>
```

## Example 2: Tab-Separated Format

### Linearized Text (TSV-like)
```
Name	Email	Phone
John Doe	john@example.com	555-1234
Jane Smith	jane@example.com	555-5678
```

### IXML Grammar
```ixml
table: header, rows .

header: -nl, cell, (-tab, cell)+ .

rows: row+ .

row: -nl, cell, (-tab, cell)+ .

cell: text .

text: [^#09#0A]+ .  { anything except tab and newline }

-tab: #09 .         { tab character }
-nl: #0A .          { newline }
```

## Example 3: Pipe-Delimited Markdown Style

### Linearized Text
```
| Name        | Email              | Phone    |
|-------------|-----------------------|----------|
| John Doe    | john@example.com   | 555-1234 |
| Jane Smith  | jane@example.com   | 555-5678 |
```

### IXML Grammar
```ixml
table: header, -separator-line, rows .

header: -nl, -pipe, cell, (-pipe, cell)+, -pipe .

separator-line: -nl, -pipe, -dashes, (-pipe, -dashes)+, -pipe .

rows: row+ .

row: -nl, -pipe, cell, (-pipe, cell)+, -pipe .

cell: -ws, text, -ws .

text: [^|#0A]+ .

-pipe: "|" .
-dashes: "-"+ .
-ws: " "* .
-nl: #0A .
```

## Example 4: Form-Style Table (Key-Value Pairs)

### Linearized Text
```
First Name: John
Last Name: Doe
Email: john@example.com
Phone: 555-1234
```

### IXML Grammar
```ixml
form: field+ .

field: -nl, label, -colon, -ws, value .

label: text .

value: text .

text: [^:#0A]+ .

-colon: ":" .
-ws: " "* .
-nl: #0A? .
```

### Expected XML Output
```xml
<form>
  <field>
    <label>First Name</label>
    <value>John</value>
  </field>
  <field>
    <label>Last Name</label>
    <value>Doe</value>
  </field>
  <field>
    <label>Email</label>
    <value>john@example.com</value>
  </field>
  <field>
    <label>Phone</label>
    <value>555-1234</value>
  </field>
</form>
```

## Key Advantages

1. **Semantic Understanding**: Parse what humans see, not HTML structure
2. **Format Flexibility**: Same approach works for TSV, CSV, pipe-delimited, etc.
3. **Robust**: HTML changes don't break parsing if visible structure stays the same
4. **IXML Sweet Spot**: Parsing unstructured text into structured XML is exactly what IXML was designed for

## Architecture Flow

```
HTML Table → Extract Linearized Text → IXML Parse → XML → Map to DOM Elements
```

### Extraction Strategy
```javascript
// Get visible text representation of table
function extractTableText(tableElement) {
  const rows = tableElement.querySelectorAll('tr');
  const lines = [];

  rows.forEach(row => {
    const cells = row.querySelectorAll('td, th');
    const cellTexts = Array.from(cells).map(cell => cell.textContent.trim());
    lines.push(cellTexts.join('\t'));  // Tab-separated
  });

  return lines.join('\n');
}
```

### Mapping Strategy
```javascript
// Map parsed XML back to DOM elements
function mapXmlToDom(xmlDoc, tableElement) {
  const xmlRows = xmlDoc.querySelectorAll('row');
  const domRows = tableElement.querySelectorAll('tbody tr');

  xmlRows.forEach((xmlRow, i) => {
    const xmlCells = xmlRow.querySelectorAll('cell');
    const domCells = domRows[i].querySelectorAll('td');

    xmlCells.forEach((xmlCell, j) => {
      // Associate parsed structure with DOM element
      domCells[j].dataset.parsed = xmlCell.textContent;
      domCells[j].dataset.cellIndex = j;
    });
  });
}
```

## Next Steps

1. Test with real HTML tables from various websites
2. Build robust linearization extractor
3. Generate domain-specific IXML grammars based on table structure
4. Implement bidirectional mapping (XML ↔ DOM)
5. Handle edge cases (merged cells, nested tables, etc.)
