# Level 1 Preprocessing Grammar - Test Cases

## HTML5 Void Elements (Complete List)

Based on the [HTML Standard](https://html.spec.whatwg.org/multipage/syntax.html) and [MDN documentation](https://developer.mozilla.org/en-US/docs/Glossary/Void_element):

- `area` - Image map area
- `base` - Base URL for document
- `br` - Line break
- `col` - Table column
- `embed` - External content container
- `hr` - Horizontal rule
- `img` - Image
- `input` - Form input
- `link` - External resource link
- `meta` - Metadata
- `param` - Plugin parameter
- `source` - Media source
- `track` - Text track for media
- `wbr` - Word break opportunity
- `command` - Command button (obsolete)
- `keygen` - Key pair generator (obsolete)

## Test Cases

### Test 1: Simple Div

**Input (from element.outerHTML):**
```html
<div class="container">Hello World</div>
```

**Expected Output:**
```
div class="container" Hello World /div
```

### Test 2: Nested Elements

**Input:**
```html
<div class="outer"><span id="inner">Text</span></div>
```

**Expected Output:**
```
div class="outer" span id="inner" Text /span /div
```

### Test 3: Void Element (Input)

**Input:**
```html
<input type="text" name="username" placeholder="Enter name">
```

**Expected Output:**
```
input type="text" name="username" placeholder="Enter name"
```

### Test 4: Mixed Content with Line Breaks

**Input:**
```html
<div>Hello<br>World</div>
```

**Expected Output:**
```
div Hello br World /div
```

### Test 5: Script Tag Removal

**Input:**
```html
<div>Before<script>alert('evil');</script>After</div>
```

**Expected Output:**
```
div Before After /div
```

### Test 6: Style Tag Removal

**Input:**
```html
<div>Content<style>.foo { color: red; }</style>More</div>
```

**Expected Output:**
```
div Content More /div
```

### Test 7: Form with Multiple Inputs

**Input:**
```html
<form action="/submit"><label>Name:</label><input type="text"><input type="submit" value="Go"></form>
```

**Expected Output:**
```
form action="/submit" label Name: /label input type="text" input type="submit" value="Go" /form
```

### Test 8: Table Structure

**Input:**
```html
<table><tr><td>Cell 1</td><td>Cell 2</td></tr></table>
```

**Expected Output:**
```
table tr td Cell 1 /td td Cell 2 /td /tr /table
```

### Test 9: Image with Attributes

**Input:**
```html
<img src="photo.jpg" alt="My Photo" width="300">
```

**Expected Output:**
```
img src="photo.jpg" alt="My Photo" width="300"
```

### Test 10: Complex Nested Form

**Input:**
```html
<form method="post"><div class="field"><label for="email">Email:</label><input type="email" id="email" name="email"></div></form>
```

**Expected Output:**
```
form method="post" div class="field" label for="email" Email: /label input type="email" id="email" name="email" /div /form
```

## Benefits of This Approach

1. **Minimal Transformation**: Only removes `<>` brackets and strips script/style
2. **Structure Preserved**: All tag names, attributes, and nesting intact
3. **IXML Compatible**: No problematic characters for IXML parser
4. **Reversible**: Could reconstruct original HTML from output
5. **Two-Stage Pipeline**: Preprocess → Parse with domain grammar

## Sources

- [HTML Standard - Void Elements](https://html.spec.whatwg.org/multipage/syntax.html)
- [MDN Web Docs - Void element](https://developer.mozilla.org/en-US/docs/Glossary/Void_element)
- [HTML5 Self-Closing Tags](http://xahlee.info/js/html5_non-closing_tag.html)
- [Complete List of Self-Closing Tags](https://markaicode.com/complete-list-of-self-closing-tags-for-html5/)
