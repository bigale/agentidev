/**
 * Grammar Library
 *
 * Pre-built working grammars for multi-pass parsing
 * These are proven to work on real-world forms
 */

console.log('[Grammar Library] Module loaded');

// Working INPUT-only grammar
export const INPUT_ONLY_GRAMMAR = `{ INPUT-Only Grammar - Specialized Extractor }

document: item* .

item: input-el | skip .

input-el: -"|input", input-attrs?, -"|" .

input-attrs: " ", ~["|"]+ .

skip: ~["|"]+ | -"|", -skip-content, -"|" .
-skip-content: ~["|"]* .`;

// Working SELECT-only grammar
export const SELECT_ONLY_GRAMMAR = `{ SELECT-Only Grammar - Specialized Extractor }

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
-skip-content: ~["|"]* .`;

// Grammar library - add more as needed
export const GRAMMAR_LIBRARY = {
  'input-only': {
    name: 'input-only',
    description: 'Extracts INPUT elements',
    grammar: INPUT_ONLY_GRAMMAR
  },
  'select-only': {
    name: 'select-only',
    description: 'Extracts SELECT elements',
    grammar: SELECT_ONLY_GRAMMAR
  }
};

/**
 * Get default grammar set for forms
 */
export function getDefaultGrammarSet() {
  return [
    GRAMMAR_LIBRARY['input-only'],
    GRAMMAR_LIBRARY['select-only']
  ];
}

console.log('[Grammar Library] Ready - loaded', Object.keys(GRAMMAR_LIBRARY).length, 'grammars');
