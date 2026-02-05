# Linearized Text Parsing - Integration Guide

## Overview

This guide explains how to integrate linearized text parsing into the Contextual Recall extension. The key insight: parse the **visible, rendered text** that users see, not the HTML markup.

## Core Concept

```
Traditional Approach (Current):
HTML Markup → IXML Grammar → Parse → XML
❌ Problem: IXML designed for unstructured text, but HTML is already structured

New Approach (Proposed):
HTML → Extract Visible Text → IXML Grammar → Parse → XML → Map to DOM
✅ Advantage: IXML operates in its sweet spot - parsing unstructured text patterns
```

## Why This Works Better

1. **Semantic Understanding**: Parse what humans read, not markup
2. **Robust**: HTML changes don't break parsing if visible structure stays same
3. **IXML Sweet Spot**: Unstructured text → structured XML (exactly what IXML was designed for)
4. **Natural Patterns**: Forms look like "Label: [input]", tables look like "col1 | col2 | col3"

## Example Files Created

### 1. Conceptual Documentation
- `table-linearized-parsing-example.md` - Complete explanation with 4 examples

### 2. Interactive Demos
- `table-linearized-poc.html` - Basic proof-of-concept with 3 parsing modes
- `table-demo-integrated.html` - Full-featured demo showing complete flow

### 3. Utility Module
- `table-extractor.js` - Reusable functions for extraction, parsing, mapping

## Integration Steps

### Step 1: Add Linearization to Content Script

Modify `extension/content.js` to extract linearized text before generating grammar:

```javascript
// NEW: Extract linearized representation
function extractLinearizedForm(formElement) {
  const lines = [];

  // Walk through form elements in DOM order
  const inputs = formElement.querySelectorAll('input, select, textarea');

  inputs.forEach(input => {
    // Find associated label
    const label = findLabelForInput(input);
    const labelText = label ? label.textContent.trim() : input.name || input.id;

    // Get input type/placeholder
    const inputType = input.type || 'text';
    const placeholder = input.placeholder || '';

    // Format as visible text pattern
    lines.push(`${labelText}: [${inputType}${placeholder ? ' - ' + placeholder : ''}]`);
  });

  return lines.join('\n');
}

function findLabelForInput(input) {
  // Try explicit label association
  if (input.id) {
    const label = document.querySelector(`label[for="${input.id}"]`);
    if (label) return label;
  }

  // Try parent label
  const parentLabel = input.closest('label');
  if (parentLabel) return parentLabel;

  // Try previous sibling
  let prev = input.previousElementSibling;
  while (prev) {
    if (prev.tagName === 'LABEL') return prev;
    if (prev.textContent.trim()) {
      // Create virtual label from text node
      return { textContent: prev.textContent };
    }
    prev = prev.previousElementSibling;
  }

  return null;
}
```

### Step 2: Update Grammar Generator

Modify `extension/lib/form-grammar-generator.js` to generate grammars for linearized text:

```javascript
export async function generateFormGrammar(formHtml, formUrl, domain) {
  // Extract linearized representation
  const linearizedText = extractLinearizedForm(formElement);

  const prompt = `Generate an IXML grammar to parse this form's linearized text representation.

**Visible Form Structure**:
\`\`\`
${linearizedText}
\`\`\`

The grammar should parse patterns like:
- "Label: [input]" → field with label and input
- "Label: [select]" → field with label and dropdown
- "Label: [textarea]" → field with label and text area

**Example Grammar**:
\`\`\`ixml
form: field+ .

field: -nl, label, -colon, -ws, input .

label: text .

input: -lbracket, text, -rbracket .

text: [^:#0A#5B#5D]+ .

-colon: ":" .
-lbracket: "[" .
-rbracket: "]" .
-ws: " "* .
-nl: #0A? .
\`\`\`

Generate a grammar that matches the structure above.`;

  // Rest of grammar generation...
}
```

### Step 3: Update Parser Integration

Modify `extension/lib/xml-parser.js` to handle linearized parsing:

```javascript
export async function parseFormWithLinearization(formElement, grammar) {
  // Extract linearized text
  const linearizedText = extractLinearizedForm(formElement);

  console.log('[Parser] Parsing linearized text:', linearizedText);

  // Parse with IXML
  const result = await parseWithIxml(grammar, linearizedText);

  if (result.success) {
    // Map parsed XML back to DOM elements
    const parsedData = extractFieldsFromXml(result.xml);
    mapFieldsToDom(parsedData, formElement);

    return {
      success: true,
      method: 'ixml-linearized',
      xml: result.xml,
      fields: parsedData
    };
  }

  return result;
}

function mapFieldsToDom(parsedFields, formElement) {
  const inputs = formElement.querySelectorAll('input, select, textarea');

  inputs.forEach((input, index) => {
    if (parsedFields[index]) {
      input.dataset.parsedLabel = parsedFields[index].label;
      input.dataset.parsedType = parsedFields[index].inputType;
      input.dataset.fieldIndex = index;
    }
  });

  console.log('[Parser] Mapped', parsedFields.length, 'fields to DOM');
}
```

### Step 4: Update Storage Strategy

Forms identified by their linearized pattern signature instead of HTML signature:

```javascript
async function getFormCacheKey(formElement, domain) {
  const linearizedText = extractLinearizedForm(formElement);

  // Hash the linearized text pattern
  const encoder = new TextEncoder();
  const data = encoder.encode(linearizedText);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return `grammar_${domain}_${hashHex}`;
}
```

## Benefits Over Current Approach

| Aspect | Current (HTML Parsing) | New (Linearized Parsing) |
|--------|------------------------|--------------------------|
| **IXML Alignment** | ❌ Fighting HTML structure | ✅ Perfect fit for text patterns |
| **Robustness** | ❌ Breaks on HTML changes | ✅ Stable if visible text stays same |
| **Semantic Focus** | ❌ Parsing tags | ✅ Parsing meaning |
| **Grammar Complexity** | ❌ Complex tag handling | ✅ Simple text patterns |
| **LLM Understanding** | ❌ Must understand HTML | ✅ Natural language patterns |

## Migration Path

### Phase 1: Parallel Implementation
- Keep existing HTML parsing
- Add linearized parsing as alternative
- Compare results side-by-side
- Use flag to enable/disable new approach

### Phase 2: A/B Testing
- Enable for 50% of forms
- Measure success rates
- Collect feedback

### Phase 3: Full Migration
- Switch to linearized parsing as primary
- Keep HTML parsing as fallback
- Remove old code after validation

## Example Use Cases

### Use Case 1: Login Form
**Linearized Text**:
```
Username: [text]
Password: [password]
Remember me: [checkbox]
```

**Grammar**:
```ixml
form: username, password, remember .

username: -nl, "Username:", -ws, -lbracket, "text", -rbracket .
password: -nl, "Password:", -ws, -lbracket, "password", -rbracket .
remember: -nl, "Remember me:", -ws, -lbracket, "checkbox", -rbracket .

-lbracket: "[" .
-rbracket: "]" .
-ws: " "* .
-nl: #0A .
```

### Use Case 2: Contact Form
**Linearized Text**:
```
First Name: [text]
Last Name: [text]
Email: [email]
Message: [textarea]
```

### Use Case 3: Data Table
**Linearized Text**:
```
Name	Email	Phone
John Doe	john@example.com	555-1234
Jane Smith	jane@example.com	555-5678
```

## Testing Strategy

### Unit Tests
```javascript
describe('Linearized Form Extraction', () => {
  it('should extract label-input pairs', () => {
    const html = '<label>Name:</label><input type="text" />';
    const result = extractLinearizedForm(html);
    expect(result).toBe('Name: [text]');
  });

  it('should handle nested labels', () => {
    const html = '<label>Email: <input type="email" /></label>';
    const result = extractLinearizedForm(html);
    expect(result).toBe('Email: [email]');
  });
});
```

### Integration Tests
```javascript
describe('End-to-End Linearized Parsing', () => {
  it('should parse and map contact form', async () => {
    const form = createTestForm();
    const grammar = await generateFormGrammar(form);
    const result = await parseFormWithLinearization(form, grammar);

    expect(result.success).toBe(true);
    expect(result.method).toBe('ixml-linearized');
    expect(result.fields.length).toBe(3);
  });
});
```

## Performance Considerations

### Extraction Cost
- **O(n)** where n = number of inputs
- Minimal overhead compared to HTML parsing

### Grammar Generation
- Simpler grammars = faster LLM generation
- More predictable patterns = better caching

### Parsing Cost
- Similar to current IXML parsing
- May be faster due to simpler grammars

## Error Handling

### Fallback Strategy
```javascript
async function parseFormWithFallback(formElement, grammar) {
  // Try linearized parsing
  let result = await parseFormWithLinearization(formElement, grammar);

  if (!result.success) {
    console.log('[Parser] Linearized parsing failed, trying HTML fallback...');
    result = await parseFormWithHtml(formElement, grammar);
  }

  if (!result.success) {
    console.log('[Parser] All methods failed, using DOM fallback...');
    result = await parseWithDomFallback(formElement);
  }

  return result;
}
```

## Next Steps

1. **Implement extraction functions** in content script
2. **Update grammar generator** to target linearized text
3. **Add debug logging** to compare approaches
4. **Create test suite** for various form types
5. **Run parallel comparison** on real websites
6. **Measure success rates** and decide on migration

## Questions to Explore

1. How to handle dynamic forms that change visibility?
2. How to deal with multi-step forms?
3. Can we use linearization for other elements (navbars, menus)?
4. Should we pre-process text (normalize whitespace, etc.)?
5. How to handle internationalization (different languages)?

## Conclusion

Linearized text parsing aligns IXML with its design purpose - parsing unstructured text into structured XML. This approach should be more robust, maintainable, and successful than parsing HTML markup directly.

The key insight: **Parse what users see, not what browsers render.**
