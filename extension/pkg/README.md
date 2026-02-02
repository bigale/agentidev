# rustixml

[![Crates.io](https://img.shields.io/crates/v/rustixml.svg)](https://crates.io/crates/rustixml)
[![License](https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg)](LICENSE-MIT)
[![WASM](https://img.shields.io/badge/wasm-ready-green.svg)](https://webassembly.org/)
[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://bigale.github.io/rustixml/)

**A pure Rust implementation of the Invisible XML (iXML) specification with WebAssembly support.**

> **🌐 [Try it live in your browser!](https://bigale.github.io/rustixml/)** - Interactive demos with real-time parsing

Turn any text into XML using simple grammar rules. Works natively in Rust and in the browser via WebAssembly.

## ✨ Features

- 🚀 **Fast native recursive descent parser** - Direct interpretation of iXML grammars
- ✅ **83.7% spec conformance** - 41 out of 49 correctness tests passing ([details](KNOWN_ISSUES.md))
- 🌐 **WebAssembly support** - 50KB gzipped, runs in any modern browser
- 📦 **Single dependency** - Only `unicode-general-category` for native builds
- 🔒 **Pure safe Rust** - No unsafe code
- 🎯 **Zero-copy parsing** - Efficient memory usage

## 🚀 Quick Start

### Rust

Add to your `Cargo.toml`:

```toml
[dependencies]
rustixml = "0.2"
```

Example usage:

```rust
use rustixml::{parse_ixml_grammar, NativeParser};

fn main() -> Result<(), String> {
    // Define an iXML grammar
    let grammar = r#"
        greeting: "Hello, ", name, "!".
        name: letter+.
        letter: ["A"-"Z"; "a"-"z"].
    "#;

    // Parse the grammar
    let ast = parse_ixml_grammar(grammar)?;
    
    // Create a parser
    let parser = NativeParser::new(ast);
    
    // Parse some input
    let xml = parser.parse("Hello, World!")?;
    
    println!("{}", xml);
    // Output: <greeting>Hello, <name>World</name>!</greeting>
    
    Ok(())
}
```

### WebAssembly (Browser)

```html
<!DOCTYPE html>
<html>
<head>
    <script type="module">
        import init, { parse_ixml } from './pkg/rustixml.js';

        async function run() {
            await init();

            const grammar = `
                greeting: "Hello, ", name, "!".
                name: letter+.
                letter: ["A"-"Z"; "a"-"z"].
            `;

            const result = parse_ixml(grammar, "Hello, World!");
            
            if (result.success) {
                console.log('XML:', result.output);
            } else {
                console.error('Error:', result.error);
            }
        }

        run();
    </script>
</head>
<body>
    <h1>iXML Parser Demo</h1>
</body>
</html>
```

## 🎮 Live Demo

Try it online: [Demo Website](https://bigale.github.io/rustixml/) 

Or run locally:

```bash
# Clone the repository
git clone https://github.com/bigale/rustixml.git
cd rustixml

# Build WASM
wasm-pack build --target web

# Serve the demo
python3 -m http.server 8080

# Open http://localhost:8080/docs/ in your browser
```

**Three demo versions available:**
- `docs/index.html` - Standard demo (recommended for most users)
- `docs/htmz-standalone.html` - HTMZ pattern demo (form-driven, no backend)
- `docs/wasmz.html` - **WASMZ pattern demo** ⭐ (native speed with wasm:// routing!)

See [docs/HTMZ-README.md](docs/HTMZ-README.md) for comparison of all three versions.

**WASMZ Pattern**: The `wasmz.html` demo showcases true `wasm://` routing where HTML forms directly call compiled Rust functions that return HTML templates. This is a reference implementation of the WASMZ pattern (WebAssembly + htmz) offering ~10x performance improvement over JavaScript. See [docs/WASMZ-PATTERN.md](docs/WASMZ-PATTERN.md) for technical details.

## 📖 What is Invisible XML?

Invisible XML (iXML) is a specification for describing text formats as grammars and automatically converting text that matches those grammars into XML. It's like regular expressions on steroids!

**Example:** Parse CSV into XML:

```ixml
csv: row+.
row: field+separator, field, newline.
field: char*.
@separator: ",".
-char: ~[","; #0A].
-newline: #0A.
```

Input:
```
name,age,city
Alice,30,NYC
Bob,25,LA
```

Output:
```xml
<csv>
  <row><field>name</field><field>age</field><field>city</field></row>
  <row><field>Alice</field><field>30</field><field>NYC</field></row>
  <row><field>Bob</field><field>25</field><field>LA</field></row>
</csv>
```

## 🏗️ Architecture

rustixml uses a **native recursive descent parser** that directly interprets iXML grammar ASTs. Unlike other implementations that use parser generators, this approach:

- ✅ Eliminates intermediate compilation steps
- ✅ Produces smaller WASM binaries (50KB vs 500KB+)
- ✅ Handles insertion/suppression semantics natively
- ✅ Provides better error messages

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## 📊 Conformance

**Overall:** 45/65 tests (69.2%)  
**Correct tests:** 41/49 tests (83.7%)

See [docs/NATIVE_PARSER_STATUS.md](docs/NATIVE_PARSER_STATUS.md) for detailed test results.

## 🔧 Building

### Native

```bash
cargo build --release
```

### WebAssembly

```bash
# Install wasm-pack if you haven't already
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# Build for web
wasm-pack build --target web

# Build for Node.js
wasm-pack build --target nodejs

# Build for bundlers (webpack, rollup, etc.)
wasm-pack build --target bundler
```

## 🧪 Testing

```bash
# Run unit tests
cargo test

# Run conformance tests
cargo run --bin conformance_test
```

## 📦 Publishing

### Crates.io

```bash
cargo publish
```

### npm

```bash
wasm-pack build --target web
cd pkg
npm publish
```

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Areas where help is especially appreciated:
- 🐛 Fixing failing test cases (see [KNOWN_ISSUES.md](KNOWN_ISSUES.md))
- 📝 Improving documentation
- ✨ Adding examples
- 🧪 Writing more tests

## 📄 License

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)

at your option.

## 🙏 Acknowledgments

- [iXML Specification](https://invisiblexml.org/) by the Invisible XML Community Group
- [iXML Test Suite](https://github.com/invisibleXML/ixml) for comprehensive conformance testing
- Rust and WebAssembly communities for excellent tooling

## 📚 Resources

- [iXML Specification](https://invisiblexml.org/ixml-specification.html)
- [iXML Tutorial](https://invisiblexml.org/tutorial/)
- [iXML Test Suite](https://github.com/invisibleXML/ixml)
- [WebAssembly](https://webassembly.org/)

---

Made with ❤️ and 🦀 by [Alex Everitt](https://github.com/bigale)
