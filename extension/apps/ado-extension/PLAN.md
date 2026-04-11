# Plan: ADO Extension as Agentidev Plugin

> **STATUS (Apr 2026)**: This plan predates the host-capability-interface + plugin architecture decision. It currently describes adding the ADO extension as a workspace package (`packages/ado-extension/`) using webpack + `copy-assets.mjs`. The *new* direction is to port it to a plugin under `extension/apps/ado-extension/` (this directory) that targets the `HostCapabilities` interface — see `plans/host-capability-interface.md` in this repo.
>
> **Before starting implementation**: rewrite this plan to target the plugin model. The `copy-assets.mjs` concept maps to build-time plugin assembly, the vss-extension.json maps to a plugin manifest, and the ADO SDK integration runs inside the extension sandbox or an offscreen document. The RTG BizApps area paths and `rtgbizapps` org URL remain work-specific config (not public).
>
> Keeping this doc as a reference point for the ADO-specific content (work item handlers, DS backends, form tab contribution) that will be ported into the plugin.

---

## Context

The `agentidev` repo (formerly `contextual-recall`) contains the Chrome extension, bridge server, and SmartClient/Agentiface shared code. At work, there is a standalone Azure DevOps extension (`ado-extension/`) that reuses SmartClient SDK, Agentiface components, and portable sandbox files from the Chrome extension.

Currently the ADO extension lives as a subdirectory of the old `contextual-recall_old` repo and uses a `copy-assets.mjs` script to pull shared files from a sibling `extension/` folder. The goal is to fork agentidev, restructure it so the ADO extension is a proper workspace package, and the shared assets come from the monorepo instead of ad-hoc copies.

## What Already Exists (ado-extension/)

```
ado-extension/
  vss-extension.json          # ADO marketplace manifest (rtg-bizapps-qa-tool)
  package.json                # ado-qa-manager, webpack build
  webpack.config.js           # Bundles hub + form-tab, copies static assets
  scripts/copy-assets.mjs     # Copies SC SDK + Agentiface + sandbox from ../extension
  src/
    hub/ado-bridge.js         # ADO SDK bridge (1,436 lines) - parent frame
    hub/hub.html              # Hub page, hosts sandbox iframe
    form-tab/form-tab-bridge.js  # Work item form tab (186 lines)
    form-tab/form-tab.html
    sandbox/                  # SmartClient sandbox (app.js, renderer.js, etc.)
    agentiface/               # Forge components (copied from extension)
    smartclient/              # SC SDK (copied from extension)
```

## Approach

### Option A: ADO extension as a workspace package (recommended)

Add `packages/ado-extension` to the agentidev monorepo. The `copy-assets.mjs` script gets updated to pull from the monorepo's `extension/` directory (same repo, different package). Shared code lives in one place.

### Option B: Separate repo, npm dependency

Fork agentidev, strip everything except the ADO extension, and depend on `@bigale/agentidev-bridge` etc. via npm. More isolation but harder to keep SmartClient assets in sync.

**Go with Option A** -- the copy-assets script already assumes a sibling directory structure, and a monorepo keeps everything aligned.

---

## Implementation Steps

### Step 1: Create the workspace package

```bash
# From the forked agentidev repo root
mkdir -p packages/ado-extension
cp -r /path/to/ado-extension/* packages/ado-extension/
```

Add to root `package.json` workspaces (already has `"packages/*"`), so it is automatically included.

### Step 2: Update copy-assets.mjs paths

The current script assumes `ado-extension/` is a sibling of `extension/`:
```javascript
// OLD (sibling layout)
const EXT = join(ROOT, '..', 'extension');
const AGENTIFACE = join(ROOT, '..', 'agentiface');
```

Update to navigate from `packages/ado-extension/` to `extension/` in the monorepo:
```javascript
// NEW (monorepo layout)
const REPO_ROOT = join(ROOT, '..', '..');
const EXT = join(REPO_ROOT, 'extension');
const AGENTIFACE = join(REPO_ROOT, 'packages', 'forge');  // forge = agentiface package
```

### Step 3: Fix the "contextual-recall" reference

In `copy-assets.mjs` line 4, update the comment:
```
- * from the contextual-recall extension into the ADO extension source tree.
+ * from the agentidev extension into the ADO extension source tree.
```

### Step 4: Verify ado-bridge.js hardcoded paths

The ADO bridge has these org-specific values that need review:

- **Line 40**: `BRIDGE_URL = 'ws://localhost:9876'` -- OK, bridge port is the same
- **Lines 213-216**: Hardcoded area paths (RediSKU, InsightIQ, IFR, Ad Note Creator) -- these are work-specific, keep as-is
- **Line 284**: `https://dev.azure.com/rtgbizapps/` -- work org URL, keep as-is
- **Line 1377**: Default org name `rtgbizapps` -- keep as-is

No agentidev-specific paths need updating in ado-bridge.js.

### Step 5: Update webpack.config.js (if needed)

The webpack config copies from `src/smartclient` and `src/agentiface` which are populated by `copy-assets.mjs`. No changes needed to webpack itself -- the copy script is the only thing that knows where shared assets live.

### Step 6: Add npm scripts to root package.json

```json
{
  "scripts": {
    "ado:copy": "node packages/ado-extension/scripts/copy-assets.mjs",
    "ado:build": "npm run ado:copy && npm -w packages/ado-extension run build",
    "ado:dev": "npm run ado:copy && npm -w packages/ado-extension run dev",
    "ado:package": "npm run ado:copy && npm -w packages/ado-extension run package"
  }
}
```

### Step 7: Add .gitignore entries for copied assets

The SmartClient SDK and Agentiface files in `packages/ado-extension/src/` are copied, not source. Add to `.gitignore`:

```gitignore
# ADO extension - copied assets (regenerated by copy-assets.mjs)
packages/ado-extension/src/smartclient/
packages/ado-extension/src/agentiface/
```

Keep `packages/ado-extension/src/sandbox/` tracked since it has ADO-specific files (ado-grid-state.js, templates.js with tpl_ado_qa).

**Exception**: The portable sandbox files (renderer.js, app.js, inspector.js, inspector-ui.js) are also copied. Either:
- Gitignore them too and always run copy-assets before build
- Or stop copying them and import from `../../extension/smartclient-app/` in webpack resolve aliases

### Step 8: Test the build

```bash
npm run ado:copy    # copies SC SDK + Agentiface + sandbox portables
npm run ado:build   # webpack production build
ls packages/ado-extension/dist/   # verify hub/, form-tab/, sandbox/, smartclient/
```

### Step 9: Test packaging

```bash
npm run ado:package   # creates .vsix file
# Verify it is under 50MB (VSIX marketplace limit)
```

---

## File Changes Summary

| File | Change |
|------|--------|
| `packages/ado-extension/` | New directory (copy from old location) |
| `packages/ado-extension/scripts/copy-assets.mjs` | Update paths to monorepo layout |
| `packages/ado-extension/package.json` | No changes needed (already standalone) |
| `package.json` (root) | Add ado: npm scripts |
| `.gitignore` | Add copied asset exclusions |

---

## Work Environment Prompt

Use this prompt to implement at work:

```
I need to add the ADO extension as a workspace package in my fork of the
agentidev repo. The ADO extension source is at packages/ado-extension/.

Tasks:
1. Update packages/ado-extension/scripts/copy-assets.mjs to resolve paths
   relative to the monorepo root (two directories up from the package):
   - EXT = ../../extension
   - AGENTIFACE = ../../packages/forge
   Update the comment on line 4 to say "agentidev" instead of "contextual-recall".

2. Add these scripts to the root package.json:
   - "ado:copy": "node packages/ado-extension/scripts/copy-assets.mjs"
   - "ado:build": "npm run ado:copy && npm -w packages/ado-extension run build"
   - "ado:dev": "npm run ado:copy && npm -w packages/ado-extension run dev"
   - "ado:package": "npm run ado:copy && npm -w packages/ado-extension run package"

3. Add to .gitignore:
   packages/ado-extension/src/smartclient/
   packages/ado-extension/src/agentiface/

4. Run `npm run ado:copy` and verify it copies assets correctly.
5. Run `npm run ado:build` and verify dist/ output.
6. Run `npm run ado:package` and verify .vsix is under 50MB.
```

---

## Notes

- The bridge server (`packages/bridge/`) is optional for the ADO extension. It only connects if running locally for AI generation features. No bridge code changes needed.
- The ADO extension has hardcoded RTG BizApps area paths and org URLs. These are intentional work-specific config, not something to abstract.
- SmartClient SDK files are large (~30MB). The copy script already filters to Tahoe skin only and excludes .gz files to stay under the 50MB VSIX limit.
- The `packages/forge/` package IS the agentiface components. The copy script currently looks for a sibling `agentiface/` directory -- update it to point to `packages/forge/`.
