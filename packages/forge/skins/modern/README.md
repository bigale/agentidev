# Modern skin + CSSZ adapter

Implementation of the [CSSZ × SmartClient evaluation](./evaluation.html) — a hybrid that uses SmartClient for structure/statefulness and CSSZ for tokens/scoping. Plus the standalone modern override skin (Phase 1) for environments that don't need CSSZ recursion yet.

## Files

| File | Phase | Role |
|---|---|---|
| `skin-modern.css` | 1 | Standalone modern override skin. Uses `--sc-*` internal vars on `.sc.skin-modern { ... }`. Drop-in if you don't need sub-tree theming. |
| `sc-cssz-adapter.css` | 2 | The strategic deliverable. Retargets SC class names to read from `var(--cssz-*, sc-default)`. Single-class selectors only. |
| `theme-modern.css` | 3 | The CSSZ vocabulary that paints the adapter modern. `.theme-modern` (light) + `.theme-modern.dark` (dark). |
| `theme-sunset.css` | — | Demo tenant overlay (warm orange brand). Pattern for white-labeling — copy, swap hue, rename. |
| `cssz.css` | 3 | The CSSZ engine for non-SC HTML on the page (cards, buttons outside SC widgets). |
| `example.html` | — | Load order, activation, and a sub-tree override demo. |
| `evaluation.html` | — | Full strategic doc — read this for the *why* (capability matrix, risks, phased plan). |
| `showcase.html` | — | Visual reference: three SC layout templates with classic ↔ modern toggle. |

## Deploy to sc-mortgage-demo

After editing any skin file in this directory, run:

```
cd ~/repos/agentidev
npm run build:mortgage-skin
```

The script syncs `sc-cssz-adapter.css`, `theme-modern.css`, and `theme-sunset.css` from this dir into the `sc-mortgage-demo` deploy clone. Idempotent — re-running with no source changes prints "Already in sync." Default location: tries `experiments/mortgage-calculator/dist/` (in-tree) first, then `~/repos/sc-mortgage-demo/`. Override via `SC_MORTGAGE_DEMO_DIR=...` env var if your clone lives elsewhere.

The script doesn't touch git — commit + push in the deploy repo manually after verifying the diff:

```
cd <deploy-clone>
git diff skin/
git add skin/ && git commit -m '...' && git push
```

CF Pages auto-deploys ~30s after push.

## Quick start (recommended path: adapter + theme)

```html
<!-- 1) SC runtime (your existing setup) -->
<!-- 2) Stock skin (your existing skin_styles.css) -->
<link rel="stylesheet" href="./sc-cssz-adapter.css">  <!-- 4 -->
<link rel="stylesheet" href="./theme-modern.css">     <!-- 5 -->

<body class="sc theme-modern">
  <!-- SC widgets render normally; the adapter resolves their classes
       against the theme-modern vocabulary -->
</body>
```

Toggle dark mode:

```js
document.body.classList.toggle('dark');
```

## Tenant white-label

Add a tenant theme on top of `theme-modern` to rebrand without touching markup. Override only the brand-relevant CSSZ vars (accent, selection tint, optional warm/cool page bg).

```html
<body class="sc theme-modern theme-sunset">
  <!-- whole calc rebrands; chrome stays neutral, accent + page tint flip -->
</body>
```

Pattern for adding a new tenant (e.g. `theme-acme`):

1. Copy `theme-sunset.css` → `theme-acme.css`
2. Replace `theme-sunset` selectors with `theme-acme`
3. Swap the OKLCH hue (sunset uses 50°; try 25° for red, 145° for green, 240° for blue)
4. Add `'acme'` to the calc's `applyTenant()` allowlist in `index.html`
5. Activate via URL: `?tenant=acme`

Keep tenant overrides minimal — just `--cssz-accent`, `--cssz-on-accent`, `--cssz-bg` (subtle tint), and `--cssz-row-selected`. Heavy chrome rebrands feel cheap; light accent rebrands feel professional.

## Sub-tree theming (the CSSZ recursive-scoping property)

Drop CSSZ vars on any descendant. Only the rescoped vars override:

```html
<body class="sc theme-modern">
  <!-- Default modern look -->
  <div class="sectionStack">...</div>

  <!-- Tenant-branded panel -->
  <div style="
    --cssz-accent: oklch(58% .15 25);
    --cssz-button-bg: oklch(58% .15 25);
    --cssz-button-text: #fff;
  ">
    <div class="buttonPrimary">Branded</div>
  </div>

  <!-- Dark panel inside light page -->
  <div class="dark" style="
    --cssz-bg: oklch(18% .005 250);
    --cssz-surface: oklch(20% .005 250);
    --cssz-text: oklch(96% .003 250);
  ">...</div>
</body>
```

## CSSZ vocabulary

All variables prefixed `--cssz-`. Adapter rules cascade through three levels: `var(--cssz-component-specific, var(--cssz-semantic, sc-default))`. Override at any level.

### Type

| Variable | Modern default |
|---|---|
| `--cssz-font` | `"Inter", system-ui, sans-serif` |
| `--cssz-mono` | `"JetBrains Mono", ui-monospace` |
| `--cssz-fs` | `12.5px` |

### Spacing

| Variable | Modern default |
|---|---|
| `--cssz-pad` | `8px` |
| `--cssz-radius` | `6px` |
| `--cssz-input-pad` | `6px 8px` |

### Semantic color

| Variable | Used by | Modern light |
|---|---|---|
| `--cssz-bg` | page background | `oklch(98.4% .002 95)` |
| `--cssz-surface` | panels, cards, inputs | `#ffffff` |
| `--cssz-surface-mute` | disabled surfaces | `oklch(96% .005 270)` |
| `--cssz-text` | body text | `oklch(20% .01 270)` |
| `--cssz-muted` | secondary text | `oklch(55% .01 270)` |
| `--cssz-text-mute` | disabled text | `oklch(55% .01 270)` |
| `--cssz-border` | hairline borders | `oklch(92% .005 270)` |
| `--cssz-border-soft` | row dividers | `oklch(95% .005 270)` |
| `--cssz-accent` | focus rings, primary buttons | `oklch(58% .18 270)` |
| `--cssz-on-accent` | text on accent surfaces | `#ffffff` |
| `--cssz-icon` | icon color (inherits via `currentColor`) | `currentColor` |

### Row state (lists, grids)

| Variable | Used by |
|---|---|
| `--cssz-row-over` | `.gridRowOver`, `.listGridCellOver`, hover bg |
| `--cssz-row-selected` | `.gridRowSelected`, `.listGridCellSelected` bg |
| `--cssz-row-selected-text` | text color on selected rows |

### Component overrides (default to semantic)

| Variable | Default chain |
|---|---|
| `--cssz-button-bg`, `--cssz-button-bg-over`, `--cssz-button-bg-down`, `--cssz-button-bg-disabled` | → `--cssz-surface` / `--cssz-row-over` |
| `--cssz-button-text` | → `--cssz-text` |
| `--cssz-tool-bg` | → `--cssz-surface` |
| `--cssz-section-bg`, `--cssz-section-text` | → `--cssz-surface` / `--cssz-text` |
| `--cssz-header-bg` (grid header) | → `--cssz-section-bg` |
| `--cssz-window-bar-bg`, `--cssz-window-bar-text` | → `--cssz-surface` / `--cssz-text` |
| `--cssz-tab-bg`, `--cssz-tab-text`, `--cssz-tab-selected-bg`, `--cssz-tab-selected-text` | → transparent / `--cssz-muted` / `--cssz-surface` / `--cssz-text` |
| `--cssz-input-bg` | → `--cssz-surface` |
| `--cssz-form-title`, `--cssz-form-title-align` | → `--cssz-muted`, `left` |

## Relationship to existing forge tokens

`packages/forge/tokens.css` defines `--af-*` tokens scoped to `:root` (a global theme system). `packages/forge/overrides.css` maps SC classes to those `--af-*` vars.

The CSSZ adapter is an *additive* alternative naming convention. Notable differences:

| Concern | `--af-*` (existing) | `--cssz-*` (this) |
|---|---|---|
| Scope | `:root` (global) | any element (recursive) |
| Activation | always-on | activated by class on container |
| Sub-tree theming | not native | native (the whole point) |
| Dark mode | `[data-theme="dark"]` on `<html>` | `.dark` class anywhere |

Use whichever fits the page. For the dashboard's main shell, `--af-*` is fine. For pages that need per-tenant theming or per-panel overrides (an embedded marketing zone, a tenant-branded preview, a "compare two themes" demo), `--cssz-*` shines.

## Adapter discipline

Per evaluation §7's "hostile bits", the adapter only paints — never resizes — anything SC measures via `getComputedStyle`.

**MAY set:** color, background, font-family, font-weight, box-shadow, border-radius, focus rings, accent-color, filter (sprite recolor).

**MUST NOT set on SC-measured elements:** padding, margin, display, gap, width, height, border (changes box size), line-height, position. SC reads these back to size/position children. Overrides cause clipping (we hit this on `.windowHeader`), hidden chrome (close icon), or row-height drift (listGrid).

**Border alternative:** use `box-shadow: inset 0 -1px 0 var(--cssz-border)` for a 1px separator without changing the box. The adapter uses inset shadows for: window/section/tab/grid bottom separators.

**Animations** are CSS-driven via a `body.cssz-loading` class — app code adds it on scenario load and `setTimeout` removes it. Two effects:
- `.textItemLite` family flashes a 700ms accent tint (sRGB blend, not OKLCH — the latter rotates hue through unrelated colors)
- `.cssz-result` (an app-supplied wrapper class) fades + slides in over 400ms

`prefers-reduced-motion: reduce` disables both transitions and animations.

**For app-level breathing room** (taller header, wider rows), set the SC widget property in app code rather than padding the chrome:

```js
isc.Window.create({ headerHeight: 28, ... });
isc.ListGrid.create({ rowHeight: 24, cellHeight: 24, ... });
```

## SectionStack content (charts, canvases, custom DOM)

When putting a chart/canvas/SVG/widget inside a SectionStack section, **render via `Label.setContents(htmlString)`, not direct DOM manipulation**. SC's SectionStack rebuilds the inner DOM of every section's items when *any* section animates expand/collapse. A chart that you appended directly into the section's host div will be orphaned — the host element is recreated, your DOM goes with the old detached one.

Pattern (used by the mortgage calc's balance chart):

```js
// Build into a detached <div>, then hand the HTML to SC.
const tmp = document.createElement('div');
const svg = d3.select(tmp).append('svg')
  .attr('viewBox', '0 0 480 224')        // fixed viewBox — chart scales via CSS
  .attr('preserveAspectRatio', 'none')    // stretch to fill container
  .style('width', '100%').style('height', '100%');
// ...build chart inside svg...
mySectionLabel.setContents(
  "<div style='width:100%;height:224px;'>" + tmp.innerHTML + "</div>"
);
```

`preserveAspectRatio="none"` plus `width: 100%; height: 100%` lets the SVG fill whatever container size SC ends up giving you (you can't read `clientWidth` on a detached element).

## SectionStack — dynamic resize

SC's `sectionExpanded` / `sectionCollapsed` callbacks fire inconsistently across versions and don't fire at all on programmatic `expandSection()` / `collapseSection()`. **Use a delegated DOM click listener instead**, deferred ~350ms so SC's animation settles before reading `sectionIsExpanded()`:

```js
document.addEventListener('click', (e) => {
  if (!e.target.closest('[class*="sectionHeader"], [eventproxy^="isc_SectionHeader_"]')) return;
  setTimeout(() => {
    let total = 4;  // small pad
    for (const id of Object.keys(MY_SECTIONS)) {
      total += 37;  // Tahoe section header height
      if (myStack.sectionIsExpanded(id)) total += MY_SECTIONS[id];
    }
    myStack.setHeight(total);
  }, 350);
});
```

The `[class*="sectionHeader"]` selector matches both `sectionHeaderopened` and `sectionHeaderclosed` — SC's state-suffixed class convention (lowercased here, weirdly — most SC suffixes are PascalCase like `tabSelected` or `formTitleFocused`).

## Known limitations

From the [evaluation §7](./evaluation.html):

1. **Sprite-image chrome.** Stock skin paints scrollbar grips, tab scroller arrows, some menu glyphs from base64 PNG/SVG sprites. The adapter doesn't touch those (except header icons via `--cssz-window-icon-filter`). If they leak, patch with a small `skin-patches.css`.
2. **Tahoe header icons recolor.** `close.png`, `maximize.png` etc. are near-white PNGs designed for Tahoe's stock dark header. On a light `--cssz-window-bar-bg` they vanish. Fixed via `filter: var(--cssz-window-icon-filter, brightness(0))`; dark-mode themes set the var to `none`.
3. **Single-class selectors.** SC's CSSOM reader is finicky about multi-class selectors and `@`-rules. The adapter uses single-class SC names exclusively (`.tabSelected`, not `.tab.selected`).
4. **Density is JS, not CSS.** SC's `resizeFonts(n)` / `resizeControls(n)` is called once, before component creation. If you want CSSZ-driven density, expose `--cssz-density` and call `resizeFonts/Controls` from a small bootstrap.
5. **SVG symbols.** SC's `sprite:svg:#id` graphics use `currentColor`. The adapter sets `color: var(--cssz-icon)` on `.icon` so they follow the theme — but verify against your real screens.
6. **No `box-sizing` reset.** Earlier versions did `.sc * { box-sizing: border-box }` — too broad, presumed SC's box model. SC's internal divs were authored against the browser default; flipping caused subtle 1-2px sizing drift.

## Validation checklist

When wiring this into a real SC app:

- [ ] Adapter loaded **after** stock `skin_styles.css`
- [ ] Theme block (theme-modern.css) loaded after the adapter
- [ ] `<body class="sc theme-modern">` activates the look
- [ ] Inter + JetBrains Mono loaded (via Google Fonts or self-hosted)
- [ ] Dark mode toggle wired via `.dark` class + persisted to localStorage
- [ ] App-shell layout renders cleanly
- [ ] DynamicForm fields show focus ring (`--cssz-accent` border + box-shadow)
- [ ] SectionStack expand/collapse works
- [ ] No leftover sprite-image bleed in scrollbars/tab scrollers/menus
- [ ] Visual diff against `showcase.html` for the three demonstrated templates
