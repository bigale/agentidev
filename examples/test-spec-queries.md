# Testing IXML Spec Queries

## Issue Found

The vector DB search wasn't returning the full `metadata` object, so the filter in `ixml-spec-indexer.js` was filtering out all results.

## Fix Applied

Updated `vectordb.js` line 115 to include full metadata:
```javascript
metadata: r.metadata // Include full metadata for filtering
```

## How to Test

1. Reload the Chrome extension
2. Clear the grammar cache again:
```javascript
chrome.storage.local.get(null, (items) => {
  const grammarKeys = Object.keys(items).filter(k => k.startsWith('grammar_'));
  chrome.storage.local.remove(grammarKeys, () => {
    console.log('✓ Cleared', grammarKeys.length, 'cached grammars');
  });
});
```

3. Reload the test page
4. Watch for: `[Grammar Generator] ✅ Added N spec sections to context`

## Expected Behavior

With the metadata fix, the queries should now find relevant spec sections:
- Query: "IXML attribute syntax rules"
- Should match spec sections about attributes, marks, nonterminals
- Should see: `[IXML Spec] Found 2 relevant sections` (or more)

## Alternative: Better Queries

If still getting 0 results, the query terms might not match spec content well. Consider more general queries:

```javascript
const queries = [
  'character class negation syntax',
  'hiding literals with dash mark',
  'nonterminal rule definitions'
];
```

Or even simpler:
```javascript
const queries = [
  'ixml syntax',
  'grammar rules',
  'character classes'
];
```

## Debug Console Commands

Check what's actually indexed:

```javascript
// Get all pages from vector DB
chrome.storage.local.get(null, (items) => {
  const pages = Object.entries(items)
    .filter(([k, v]) => k.startsWith('page_'))
    .map(([k, v]) => v);

  const specPages = pages.filter(p =>
    p.metadata?.isReference && p.metadata?.domain === 'invisiblexml.org'
  );

  console.log('Total pages:', pages.length);
  console.log('Spec pages:', specPages.length);

  if (specPages.length > 0) {
    console.log('Sample spec page:', specPages[0]);
    console.log('Sample text:', specPages[0].text.substring(0, 200));
  }
});
```

This will show you:
1. How many spec pages are actually indexed
2. What the metadata looks like
3. What the actual text content is

Then you can craft queries that match the actual content.
