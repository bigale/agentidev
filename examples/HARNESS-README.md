# IXML Test Harness

Automated testing environment for iterating on preprocessing + grammar combinations.

## Quick Start

```bash
cd /home/bigale/repos/contextual-recall/examples
./ixml-test-harness.sh
```

## How It Works

The harness automatically tests all combinations of:
- **Preprocessors** (in `preprocessors/`) - JavaScript scripts that transform HTML
- **Grammars** (in `grammars/`) - IXML grammar files
- **Test cases** - Built-in HTML samples (simple form, login form)

## Directory Structure

```
examples/
├── ixml-test-harness.sh    # Main test runner
├── preprocessors/           # Preprocessing strategies
│   ├── pipe-delimited.js   # Replace < > with |
│   └── remove-brackets.js  # Remove < > entirely
├── grammars/                # IXML grammars
│   ├── simple-pipe.ixml    # Basic tokenizer
│   └── pipe-delimited-form.ixml  # Form structure parser
└── HARNESS-README.md       # This file
```

## Adding New Preprocessors

Create a Node.js script in `preprocessors/`:

```javascript
#!/usr/bin/env node
const html = process.argv[2];
// Transform html...
console.log(transformed);
```

Make it executable:
```bash
chmod +x preprocessors/your-preprocessor.js
```

## Adding New Grammars

Create an IXML file in `grammars/`:

```ixml
{ Your Grammar }

document: item+ .

item: ~[" "]+ .
```

## Current Results

```
✅ pipe-delimited.js + pipe-delimited-form.ixml  (WINNER!)
✅ pipe-delimited.js + simple-pipe.ixml
✅ remove-brackets.js + simple-pipe.ixml
❌ remove-brackets.js + pipe-delimited-form.ixml (wrong combo)
```

## Iterate Without User Input

Just:
1. Add new preprocessor to `preprocessors/`
2. Add new grammar to `grammars/`
3. Run `./ixml-test-harness.sh`
4. See which combinations work!

The harness runs all combinations automatically and reports results.

## Using markup-blitz Directly

Test individual cases:

```bash
# Test with literal input
java -jar /home/bigale/repos/markup-blitz/build/libs/markup-blitz.jar \
  grammars/simple-pipe.ixml \
  '!|form|test|/form|'

# Test with file
java -jar /home/bigale/repos/markup-blitz/build/libs/markup-blitz.jar \
  --indent \
  grammars/simple-pipe.ixml \
  test-input.txt
```

## Next Steps

1. Refine `pipe-delimited-form.ixml` to produce LLM-friendly structure
2. Add more test cases
3. Add preprocessor variations (brackets to different delimiters)
4. Test with real website HTML

## Notes

- Uses markup-blitz as the IXML parser (more complete than rustixml)
- Preprocessors must output to stdout
- Grammars use standard IXML syntax (`~[...]` not `[^...]`)
- Test harness detects `error` in output or non-zero exit code as failure
