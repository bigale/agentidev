# Extension Console Commands

## Clear Grammar Cache

The cached grammar was generated before the prompt update and has syntax errors. Clear it to regenerate with the new pipe-delimited prompt.

### Option 1: Clear All Grammar Cache

Open DevTools Console on the extension page and run:

```javascript
chrome.storage.local.get(null, (items) => {
  const grammarKeys = Object.keys(items).filter(k => k.startsWith('grammar_'));
  chrome.storage.local.remove(grammarKeys, () => {
    console.log('✓ Cleared', grammarKeys.length, 'cached grammars');
  });
});
```

### Option 2: Clear Specific Domain

For roboform.com:

```javascript
chrome.storage.local.get(null, (items) => {
  const keys = Object.keys(items)
    .filter(k => k.startsWith('grammar_') && items[k].cacheKey?.includes('roboform.com'));
  chrome.storage.local.remove(keys, () => {
    console.log('✓ Cleared', keys.length, 'roboform.com grammars');
  });
});
```

### Option 3: Use Extension API (if available)

If the extension exports cache management functions:

```javascript
// Import the module (if in appropriate context)
import { clearGrammarCache } from './lib/form-grammar-generator.js';

// Clear all
await clearGrammarCache();

// Clear specific domain
await clearGrammarCache('roboform.com');
```

### Option 4: View Cache Stats

```javascript
chrome.storage.local.get(null, (items) => {
  const grammarKeys = Object.keys(items).filter(k => k.startsWith('grammar_'));
  console.log('Total cached grammars:', grammarKeys.length);
  grammarKeys.forEach(key => {
    const entry = items[key];
    console.log('  -', entry.cacheKey, '(age:', Math.round((Date.now() - entry.timestamp) / 1000 / 60), 'minutes)');
  });
});
```

## After Clearing Cache

1. Reload the test page
2. The extension will generate a fresh grammar using the new pipe-delimited prompt
3. Watch console for:
   - `[HTML Preprocessor] After pipe replacement:` - Confirms preprocessing
   - `[Grammar Generator] Generated grammar:` - Shows new grammar
   - `[Form XML Parser] ✓ Successfully parsed to XML document` - Confirms success

## Expected New Grammar Format

The new grammar should look like:

```ixml
document: form .

form: -"|form", -skip-attrs, -"|", content*, -"|/form|" .

-skip-attrs: (" ", ~["|"]+) | "" .

content: field | action .

field: -"|label", -skip-label-attrs, -"|", label-text, -"|/label||input ", input-attrs, -"|" .

-skip-label-attrs: (" ", ~["|"]+) | "" .

label-text: ~["|"]+ .

input-attrs: ~["|"]+ .

action: -"|input ", action-attrs, -"|" .

action-attrs: ~["|"]+ .
```

**Key characteristics:**
- No duplicate rule definitions
- Uses `~["|"]` for character class negation
- Named rules for skipping attributes: `-skip-attrs: (" ", ~["|"]+) | ""`
- No `-~[...]` patterns (invalid)
- No duplicate `input-attrs:` or `action:` definitions

## Troubleshooting

If parsing still fails after clearing cache:

1. Check the generated grammar in console
2. Look for syntax errors:
   - Duplicate rule names
   - Invalid character classes
   - Unterminated strings
3. The system will fall back to regex extraction (which works but is less semantic)
