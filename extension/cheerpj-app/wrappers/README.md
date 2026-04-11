# CheerpJ wrapper JARs

Tiny Java wrapper classes that extend the cheerpj runtime's `runMain` API
to handle real-world Java libraries that don't expose a `main` method
suitable for `cheerpjRunMain`. Each wrapper compiles to a few hundred
bytes of bytecode and is mounted as an `extraJars` entry on
`host.runtimes.get('cheerpj').runMain({...})`.

The compiled JARs live in `~/.agentidev/cheerpx-assets/` (served by
`packages/bridge/asset-server.mjs`). Sources live here so they can be
rebuilt and audited.

## NoLogValidator.java

Used by Phase 1.8 (NIST HL7 v2 validator). CheerpJ 4.0's Java 11 runtime
is missing the `Java_java_lang_StackStreamFactory_checkStackWalkModes`
JNI binding, which means any code that calls `Logger.info(...)` blows
up: `SimpleFormatter.format()` walks the stack via `StackWalker` to
infer the caller class, hitting the missing JNI.

Workaround: a wrapper that calls `LogManager.getLogManager().reset()`
(removes all handlers from the root logger) before delegating to
`com.aav.nist.BrowserValidator.main(args)`. With no handlers, no formatter
is invoked, so the JNI never gets called.

Build:

```bash
cd /tmp && mkdir -p nl && cd nl
cp $AGENTIDEV/extension/cheerpj-app/wrappers/NoLogValidator.java .
javac --release 11 -cp /path/to/nist-validator.jar NoLogValidator.java
jar cf nolog-wrap.jar NoLogValidator.class
cp nolog-wrap.jar ~/.agentidev/cheerpx-assets/nolog-wrap.jar
```

## BshEval.java

Used by Phase 3 (BeanShell runtime composition). BeanShell exposes
`bsh.Interpreter().eval(String)` which returns the value of the last
expression in the script. There's no built-in `bsh.Interpreter` main
that takes `-e <code>`, so this wrapper calls eval() with `args[0]`
and prints the toString of the result.

Build:

```bash
cd /tmp && mkdir -p bsh && cd bsh
cp $AGENTIDEV/extension/cheerpj-app/wrappers/BshEval.java .
javac --release 8 -cp ~/.agentidev/cheerpx-assets/bsh-2.0b5.jar BshEval.java
jar cf bsh-eval.jar BshEval.class
cp bsh-eval.jar ~/.agentidev/cheerpx-assets/bsh-eval.jar
```

## Why not check in the JARs themselves

- The wrapper JARs are tiny (a few hundred bytes each), but the
  *underlying* JARs they reference (`bsh-2.0b5.jar`, `nist-validator.jar`)
  are large and have their own licenses/sourcing concerns. Keeping
  everything in `~/.agentidev/cheerpx-assets/` outside the repo means
  there's one consistent place for "things asset-server serves" without
  bloating the extension bundle. When we ship plugins for real (Phase 4+)
  the plugin manifest will declare its asset URLs.
