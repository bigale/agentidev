# Preprocessing Architecture

## Core Philosophy

**Preprocessing = Linear** (remove syntax noise)
**Parsing = Hierarchical** (build semantic meaning)

## Computer Science Analysis

### Linear Text Transformation
- **Input:** String (linear sequence)
- **Process:** Pattern matching, regex
- **Output:** String (linear sequence)
- **Structure:** NONE
- **Complexity:** O(n), single pass
- **Use case:** Remove markup syntax

### Hierarchical Parsing
- **Input:** String (linear sequence)
- **Process:** Grammar recognition, tree building
- **Output:** Tree/Graph (hierarchical structure)
- **Structure:** YES - builds AST
- **Complexity:** O(n) to O(n³)
- **Use case:** Build semantic meaning

## The Incongruity We Avoided

**Wrong approach:**
```
Linear Text → [Parse → Tree → Flatten] → Linear Text → [Parse → Tree → Flatten] → Linear Text
```

Problem: Building hierarchy just to throw it away (wasted work)

**Correct approach:**
```
Linear Text → [Linear Transform] → Clean Text → [Parse → Tree] → Structured Data
```

Benefit: Hierarchy only where we need structure

## Implementation

### Preprocessor (`html-preprocessor.js`)

Pure JavaScript string operations:

1. **`stripScriptTags(html)`** - Remove `<script>` blocks
2. **`stripStyleTags(html)`** - Remove `<style>` blocks
3. **`removeAngleBrackets(html)`** - Remove `<` and `>`
4. **`preprocess(html)`** - Complete pipeline

### Example Transform

```javascript
// Input
'<div>Before<script>bad();</script>After</div>'

// Step 1: Strip scripts
'<div>BeforeAfter</div>'

// Step 2: Strip styles (none)
'<div>BeforeAfter</div>'

// Step 3: Remove angle brackets
'div BeforeAfter /div'
```

### Performance

- **No parsing overhead** in preprocessing
- **No tree building** for throwaway structure
- **O(n) complexity** - single pass regex operations
- **No state management** - pure functions

## Next Steps

After preprocessing, the clean linearized text is ready for **hierarchical IXML parsing** where we build meaningful semantic structure:

```
Clean Text: "div BeforeAfter /div"
    ↓
[IXML Grammar Pipeline]
    ↓
Semantic XML: <element name="div">BeforeAfter</element>
```

IXML now operates in its sweet spot: turning unstructured text into structured data.

## Files

- `html-preprocessor.js` - Linear transformation functions
- `test-preprocessor.html` - Test suite with step visualization
- `PREPROCESSING-ARCHITECTURE.md` - This document

## Key Insight

**Don't use hierarchical parsers for linear transformations.**

The right tool for the right job:
- Preprocessing: String operations
- Parsing: Grammar-based hierarchical parsing
