# Multi-Grammar Generation Prompt Template

## Concept

Instead of generating ONE complex grammar, instruct the LLM to generate a SET of specialized grammars that work together in a multi-pass pipeline.

## Prompt Structure

```
You are an IXML grammar architect. Generate a SET of specialized grammars for parsing this form.

**Preprocessed Form** (pipe-delimited):
```
{PREPROCESSED_HTML}
```

**Task**: Generate 2-4 specialized grammars, each extracting ONE type of element.

**Multi-Grammar Architecture**:
1. Each grammar focuses on ONE element type (input, select, textarea, button)
2. Each grammar uses the same structure: document → item* → (target-el | skip)
3. The skip rule allows everything else to be ignored
4. Results from all grammars are combined

**Example: SELECT-Only Grammar**:
```ixml
{ SELECT-Only Grammar - Specialized Extractor }

document: item* .

item: select-el | skip .

select-el: -"|SELECT", select-attrs, -"|", select-body, -"|/SELECT|"
         | -"|select", select-attrs, -"|", select-body, -"|/select|" .

select-attrs: (" ", ~["|"]+) | "" .

select-body: body-part* .
body-part: text-part | nested-tag .

text-part: ~["|"]+ .

nested-tag: -"|OPTION", -attrs?, -"|", option-text, -"|/OPTION|"
          | -"|option", -attrs?, -"|", option-text, -"|/option|"
          | -"|", -other-tag-name, -attrs?, -"|", -any-content, -"|/", -other-tag-name, -"|"
          | -"|", -other-tag-name, -attrs?, -"|" .

option-text: ~["|"]+ .

-attrs: " ", ~["|"]+ .
-other-tag-name: ~["|/ "]+ .
-any-content: (~["|"] | nested-pipe)* .
-nested-pipe: "|", ~["/"] .

skip: ~["|"]+ | -"|", -skip-content, -"|" .
-skip-content: ~["|"]* .
```

**Example: INPUT-Only Grammar**:
```ixml
{ INPUT-Only Grammar - Specialized Extractor }

document: item* .

item: input-el | skip .

input-el: -"|input", input-attrs?, -"|" .

input-attrs: " ", ~["|"]+ .

skip: ~["|"]+ | -"|", -skip-content, -"|" .
-skip-content: ~["|"]* .
```

**CRITICAL rustixml Syntax Rules**:
- Use ~["|"] to match any character EXCEPT pipes (NOT [^|])
- NEVER combine marks with negation: -~[...]+ is INVALID
- Use named rules with alternatives: -skip: (" ", ~["|"]+) | ""
- Each grammar should be FOCUSED on one element type
- Use the same skip pattern in all grammars

**Output Format** (JSON):
{
  "grammars": [
    {
      "name": "input-only",
      "description": "Extracts INPUT elements",
      "grammar": "{ INPUT-Only Grammar }\\n\\ndocument: item* .\\n..."
    },
    {
      "name": "select-only",
      "description": "Extracts SELECT elements",
      "grammar": "{ SELECT-Only Grammar }\\n\\ndocument: item* .\\n..."
    }
  ]
}

Generate grammars for: INPUT, SELECT, and TEXTAREA elements found in this form.
```

## Integration Points

### 1. Extension UI - Editable Prompt Field

Add to sidepanel or options page:

```html
<div class="grammar-prompt-editor">
  <label>
    <strong>Grammar Generation Prompt</strong>
    <small>Edit how the LLM generates grammars</small>
  </label>
  <textarea id="grammar-prompt" rows="20" style="font-family: monospace;">
    <!-- Prompt template here -->
  </textarea>
  <button id="save-prompt">Save Prompt Template</button>
  <button id="reset-prompt">Reset to Default</button>
  <button id="test-prompt">Test on Current Form</button>
</div>
```

### 2. Storage

```javascript
// Save user's custom prompt
chrome.storage.local.set({
  customGrammarPrompt: userPrompt,
  useCustomPrompt: true
});

// Load prompt
const config = await chrome.storage.local.get(['customGrammarPrompt', 'useCustomPrompt']);
const prompt = config.useCustomPrompt ? config.customGrammarPrompt : DEFAULT_PROMPT;
```

### 3. Multi-Grammar Generation

```javascript
async function generateMultiGrammar(formHTML, promptTemplate) {
  const preprocessed = preprocessHTML(formHTML);

  // Replace template variables
  const prompt = promptTemplate.replace('{PREPROCESSED_HTML}', preprocessed);

  // Call LLM
  const response = await generateText(prompt, {
    temperature: 0.1,
    maxTokens: 3000 // More tokens for multiple grammars
  });

  // Parse JSON response
  const grammarSet = JSON.parse(response);

  return grammarSet.grammars;
}
```

### 4. Multi-Pass Parsing

```javascript
async function parseWithMultiGrammar(html, grammars) {
  const preprocessed = preprocessHTML(html);
  const results = [];

  for (const grammarDef of grammars) {
    console.log(`[Parser] Pass: ${grammarDef.name}`);

    const result = await parseWithGrammar(preprocessed, grammarDef.grammar);

    if (result.success) {
      results.push({
        name: grammarDef.name,
        xml: result.output,
        fields: extractFieldsFromXML(result.xmlDoc)
      });
    }
  }

  // Combine all results
  return combineMultiGrammarResults(results);
}
```

## Benefits

1. **User Control**: Users can experiment with different prompting strategies
2. **Teachable System**: Show the LLM examples, it reproduces the pattern
3. **Flexible**: Handle new HTML patterns by updating prompt, not code
4. **Debuggable**: See exact prompt, test different variations
5. **Exploratory**: Learn what works through experimentation

## Example Use Cases

### Use Case 1: Add Button Support

User edits prompt to include:
```
Generate grammars for: INPUT, SELECT, TEXTAREA, and BUTTON elements.
```

Add button example grammar to prompt.

### Use Case 2: Handle Custom Components

User encounters web component like `<custom-input>`:
```
Generate grammars for: INPUT, SELECT, and custom-input elements (use |custom-input| pattern).
```

### Use Case 3: Domain-Specific Forms

User working with medical forms can add:
```
**Domain Context**: This is a medical form. Patient data fields often use prefixes like "patient_", "med_", "dx_".

Generate specialized grammars that group fields by prefix.
```

## Implementation Plan

1. ✅ Design prompt template (this document)
2. ⬜ Add UI fields to extension
3. ⬜ Update `form-grammar-generator.js` to accept custom prompts
4. ⬜ Parse JSON response with multiple grammars
5. ⬜ Update `form-xml-parser.js` for multi-pass
6. ⬜ Add prompt editor to sidepanel
7. ⬜ Test with real forms
