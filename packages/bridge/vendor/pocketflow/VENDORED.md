# Vendored: PocketFlow

Source: https://github.com/The-Pocket/PocketFlow
License: MIT
Upstream commit: `43ef382bb0c9dae8167528618bb40f5a3f9a28a5` (2026-04-29)
File: `__init__.py` only — the entire framework is one 99-line file.

## Why vendored

PocketFlow is zero-dependency. Vendoring means flows can run via the bridge without `pip install pocketflow` on the host machine — only Python 3 itself is required. This matters for engagement deployments where adding pip packages is friction.

## Updating

```bash
cp ~/repos/PocketFlow/pocketflow/__init__.py packages/bridge/vendor/pocketflow/__init__.py
git -C ~/repos/PocketFlow rev-parse HEAD  # update the commit hash above
```

Re-run any flows after updating to confirm no API breakage. PocketFlow's API is small enough that changes are rare and obvious in the diff.
