/**
 * Clear Grammar Cache Utility
 *
 * Clears cached grammars from Chrome extension storage
 * Run this when you've updated prompts and want fresh grammars generated
 */

console.log('Grammar Cache Clearer');
console.log('====================\n');

console.log('To clear the grammar cache:');
console.log('');
console.log('1. Open Chrome DevTools on the extension page');
console.log('2. Go to Console');
console.log('3. Run this command:');
console.log('');
console.log('   // Clear all grammar cache');
console.log('   chrome.storage.local.get(null, (items) => {');
console.log('     const grammarKeys = Object.keys(items).filter(k => k.startsWith("grammar_"));');
console.log('     chrome.storage.local.remove(grammarKeys, () => {');
console.log('       console.log("✓ Cleared", grammarKeys.length, "cached grammars");');
console.log('     });');
console.log('   });');
console.log('');
console.log('4. Or clear specific domain:');
console.log('');
console.log('   // Clear cache for roboform.com');
console.log('   chrome.storage.local.get(null, (items) => {');
console.log('     const keys = Object.keys(items).filter(k => k.startsWith("grammar_") && items[k].cacheKey?.includes("roboform.com"));');
console.log('     chrome.storage.local.remove(keys, () => {');
console.log('       console.log("✓ Cleared", keys.length, "roboform.com grammars");');
console.log('     });');
console.log('   });');
console.log('');
console.log('5. Reload the test page to generate fresh grammar\n');
