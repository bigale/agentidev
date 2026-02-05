# Linearized Text Parsing Examples

This directory contains proof-of-concept demonstrations for **linearized text parsing** - a new architectural approach for the Contextual Recall extension.

## 🎯 Core Idea

Instead of parsing HTML markup with IXML (fighting against HTML's structure), we:

1. **Extract** the visible, linearized text representation (what users see)
2. **Parse** that text with IXML grammars (IXML's sweet spot)
3. **Map** the parsed structure back to DOM elements

## 📁 Files

### Documentation
- **`table-linearized-parsing-example.md`** - Conceptual overview with 4 parsing examples
- **`INTEGRATION-GUIDE.md`** - Complete integration plan for the extension

### Interactive Demos
- **`table-linearized-poc.html`** - Basic POC with 3 table formats (tab, pipe, spaces)
- **`table-demo-integrated.html`** - Full-featured demo with stats and complete flow visualization

### Code Modules
- **`table-extractor.js`** - Reusable utility functions:
  - `extractLinearizedTable()` - Extract visible text from HTML tables
  - `generateTableGrammar()` - Generate IXML grammar for format
  - `parseTableXml()` - Parse XML output to structured data
  - `mapParsedDataToDom()` - Map parsed data back to DOM elements
  - `processTable()` - Complete end-to-end flow
  - `analyzeTableStructure()` - Analyze table dimensions and content

## 🚀 Quick Start

### Option 1: Standalone Demo (No Server Required)

Simply open in your browser:
```bash
# Works immediately - no CORS issues
open table-demo-standalone.html
```

This shows the linearization concept with mock XML output (no actual IXML parsing).

### Option 2: Full Demo with IXML Parsing (Requires Local Server)

Start a local HTTP server to avoid CORS issues:

```bash
# Navigate to examples directory
cd examples

# Run the server script (uses Python or Node)
./serve.sh
```

Then open in your browser:
- **Integrated Demo**: http://localhost:8080/examples/table-demo-integrated.html
- **Basic POC**: http://localhost:8080/examples/table-linearized-poc.html

These demos use actual rustixml WASM parsing to show the complete flow.

### Use the Module

```javascript
import {
  extractLinearizedTable,
  generateTableGrammar,
  processTable
} from './table-extractor.js';

// Get reference to table
const table = document.querySelector('table');

// Extract linearized text
const linearized = extractLinearizedTable(table, 'tab');
console.log(linearized);
// Output:
// Name	Email	Phone
// John Doe	john@example.com	555-1234

// Generate grammar
const grammar = generateTableGrammar('tab', 3);

// Or run complete flow
const result = await processTable(table, ixmlParser, 'tab');
console.log(result.parsedData);
// Output:
// {
//   headers: ['Name', 'Email', 'Phone'],
//   rows: [
//     ['John Doe', 'john@example.com', '555-1234'],
//     ...
//   ]
// }
```

## 🎨 Examples Covered

### 1. Tab-Delimited Format
```
Name	Email	Phone
John Doe	john@example.com	555-1234
```
Clean separator, easy parsing

### 2. Pipe-Delimited Format
```
| Name | Email | Phone |
| John Doe | john@example.com | 555-1234 |
```
Markdown-style tables

### 3. Space-Separated Format
```
Name           Email                Phone
John Doe       john@example.com     555-1234
```
Aligned columns with variable spacing

### 4. Form-Style Key-Value
```
First Name: John
Last Name: Doe
Email: john@example.com
```
Label-value pairs

## 🔬 What Makes This Better

| Aspect | HTML Parsing | Linearized Parsing |
|--------|--------------|-------------------|
| **IXML Fit** | ❌ Fighting structure | ✅ Perfect alignment |
| **Robustness** | ❌ Breaks on markup changes | ✅ Stable if text stays same |
| **Semantics** | ❌ Parsing tags | ✅ Parsing meaning |
| **Grammar** | ❌ Complex | ✅ Simple patterns |
| **LLM Understanding** | ❌ HTML knowledge needed | ✅ Natural patterns |

## 📊 Flow Diagram

```
┌─────────────┐
│ HTML Table  │
└──────┬──────┘
       │
       ▼
┌──────────────────────┐
│ Extract Linearized   │  extractLinearizedTable()
│ Text Representation  │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ Generate IXML        │  generateTableGrammar()
│ Grammar              │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ Parse with rustixml  │  parse_with_ixml()
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ Extract Structured   │  parseTableXml()
│ Data from XML        │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ Map Back to DOM      │  mapParsedDataToDom()
│ Elements             │
└──────────────────────┘
```

## 🧪 Testing the Concept

### Browser Console Test
```javascript
// Open table-demo-integrated.html
// Then in console:

// Test extraction
const table = document.getElementById('demo-table');
const linearized = window.tableExtractor.extractLinearizedTable(table, 'tab');
console.log(linearized);

// Analyze structure
const structure = window.tableExtractor.analyzeTableStructure(table);
console.log(structure);

// Run complete flow
await runCompleteFlow('tab');
```

## 💡 Key Insights

1. **IXML was designed for this** - Converting unstructured text to XML
2. **Users see text, not tags** - Parse the semantic content
3. **Robust to changes** - HTML structure can change, text pattern stays stable
4. **Simpler grammars** - Text patterns easier than tag soup
5. **Better LLM understanding** - Natural language patterns vs HTML syntax

## 🔄 Next Steps for Integration

1. **Adapt for forms** - Apply same concept to form inputs
2. **Test on real sites** - Validate approach with diverse websites
3. **Measure success rates** - Compare against current HTML parsing
4. **Build fallback chain** - Linearized → HTML → DOM fallback
5. **Integrate with extension** - Add to content script pipeline

## 📚 Additional Resources

- [Invisible XML Specification](https://invisiblexml.org/1.0/)
- [rustixml Documentation](https://github.com/invisibleXML/rustixml)
- Main extension: `../extension/`
- Documentation: `../docs/`

## 🎯 Vision

This approach transforms IXML from "a tool we're trying to use for HTML" into "the perfect tool for this job" - parsing the semantic, linearized text representation of web content.

**Parse what users see, not what browsers render.**
