# UI Context — SmartClient + CSSZ Stack

**One-page map.** Land here first when you're about to build, design, or debug UI in this stack. Everything in this doc is a pointer to the canonical source — don't duplicate, link.

---

## Stack overview

```
SmartClient v14.1p (Tahoe skin)
  ↓ widgets stamp class names on DOM
sc-cssz-adapter.css                       (color/font overrides via CSSZ vars)
  ↓ resolves --cssz-* vars at paint time
theme-modern.css                          (Linear/Vercel-leaning Inter palette)
  ↓ optional tenant overlay
theme-<tenant>.css                        (e.g. theme-sunset.css — accent + page tint)
  ↓
Calc / dashboard / plugin app HTML        (consumes SC + skin via standard layouts)
  ↓ optional D3 from jsDelivr ESM (zero CF Pages quota)
Domain bundle (mortgage / future domains) (window.MortgageBundle, IIFE)
```

External deps: SmartClient runtime (vendored, ~27MB SDK subset, LGPL); D3 v7 from jsDelivr; Inter + JetBrains Mono from Google Fonts.

---

## Where to read first

| For… | Read this |
|---|---|
| Adapter discipline + CSSZ vocabulary | `packages/forge/skins/modern/README.md` |
| Strategic CSSZ × SC architecture rationale | `packages/forge/skins/modern/evaluation.html` |
| Visual reference (hand-rolled SC mocks) | `packages/forge/skins/modern/showcase.html` |
| Live CSS files (modify here, sync via `npm run build:mortgage-skin`) | `packages/forge/skins/modern/{sc-cssz-adapter,theme-modern,theme-sunset}.css` |
| SmartClient widget catalog (627 examples by name + category + components) | `packages/bridge/scripts/sc-showcase-index.md` |
| SC Playwright testing + state-suffixed class names + SectionStack quirks | `packages/ai-context/sources/smartclient-playwright.md` (auto-syncs to `.claude/rules/`) |
| Mortgage profit-center invariants + cross-context contracts | `~/repos/ddd-apps/docs/contexts/mortgage/CONTEXT.md` |
| Mortgage UBIQUITOUS_LANGUAGE (loan terms + CSSZ vocabulary + calc-specific terms) | `~/repos/ddd-apps/docs/UBIQUITOUS_LANGUAGE.md` |
| Three-repo system map (agentidev + ddd-apps + sc-mortgage-demo) | `~/repos/ddd-apps/docs/CONTEXT_MAP.md` |

---

## Widget vocabulary (what we actually use)

From `sc-showcase-index.md` — the widgets with the most coverage in the SDK and how we use them in this stack:

| Widget | SDK examples | We use it for |
|---|---|---|
| `ListGrid` | 274 | Dashboard tables (sessions, scripts, schedules); not used in mortgage calc. |
| `DynamicForm` | 211 | The 4-input mortgage form; future archetype-aware forms. |
| `VLayout` / `HLayout` | 149 / 105 | Root layout for everything. |
| `Label` | 75 | Containers for HTML content (result panel, recents, chart hosts). Often the right widget when you want SC sizing + arbitrary HTML. |
| `Window` | 16 | Modals (share modal in calc). |
| `SectionStack` | (catalog) | Collapsible sections (calc's "Explore your loan"). **DOM gets recreated on animate** — render charts via `Label.setContents`, not direct DOM manipulation. |
| `TabSet` | 20 | Future: chart-view switcher, detail tabs. |
| `TileGrid` | 10 | Canonical SC widget for **archetype picker cards** (upcoming spec). |
| `PortalLayout` | 13 | Dashboard rearrangeable cards. |
| `ToolStrip` | 13 | Dashboard toolbar. |
| `HTMLFlow` | 20 | Alternative to Label for HTML; may be more reflow-stable in some scenarios (worth testing). |

When you need a widget for a new task, grep the showcase index first:
```bash
grep -i "<your concept>" packages/bridge/scripts/sc-showcase-index.md
grep "_(Animation)_" packages/bridge/scripts/sc-showcase-index.md   # by category
grep "TileGrid" packages/bridge/scripts/sc-showcase-index.md         # by widget
```

---

## Adapter discipline (the rules that prevent breakage)

From `packages/forge/skins/modern/README.md`. The full version lives there; this is the cheat sheet:

**MAY set on SC widgets:**
- `color`, `background`, `background-color`
- `font-family`, `font-weight`, `font-size` (cautiously — some widgets size from font)
- `box-shadow`, `border-radius`
- focus rings, `accent-color`
- `filter` (for sprite recolor — Tahoe header icons need `brightness(0)` on light themes)
- `transition` (color-only; never on layout properties)

**MUST NOT set on SC-measured elements:**
- `padding`, `margin`, `gap`
- `display: flex` / `display: grid` (changes layout model)
- `width`, `height` (SC sets these inline)
- `border` (changes box-sizing dimensions; use `box-shadow: inset 0 0 0 1px var(--cssz-border)` instead)
- `line-height` that affects element height
- `position`

**Why:** SC reads CSS via `getComputedStyle` to size/position children. Override these and you get clipped headers (windowHeader was 17px not 30px), hidden chrome (close icons disappear), or accumulating drift (1px/row on listGridCell × 360 rows of amortization).

**State-suffixed classes (no space, always enumerate):**

| Base | State variants |
|---|---|
| `formTitle` | `formTitleFocused`, `formTitleOver`, `formTitleDisabled` |
| `textItemLite` | `textItemLiteFocused`, `textItemLiteDisabled` (Lite is what Tahoe stamps on the actual `<input>`) |
| `tab` | `tabSelected`, `tabOver`, `tabDisabled` |
| `button` | `buttonOver`, `buttonDown`, `buttonSelected`, `buttonFocused`, `buttonDisabled`, `buttonPrimary` |
| `gridRow` | `gridRowOver`, `gridRowSelected` |
| `listGridCell` | `listGridCellOver`, `listGridCellSelected`, `listGridCellSelectedOver` |
| `sectionHeader` | `sectionHeaderopened`, `sectionHeaderclosed` (lowercase suffixes — the outlier) |

Selector pattern that catches all states: `[class*="textItem"]`, `[class*="sectionHeader"]`.

---

## Theme + tenant pattern (CSSZ vocabulary)

CSSZ vars are the canonical theming surface. Override at any container — the recursive scoping is the whole point.

**Semantic vars** (the contract): `--cssz-bg`, `--cssz-surface`, `--cssz-text`, `--cssz-muted`, `--cssz-border`, `--cssz-border-soft`, `--cssz-accent`, `--cssz-on-accent`, `--cssz-icon`, `--cssz-row-over`, `--cssz-row-selected`, `--cssz-row-selected-text`.

**Component-specific vars** (override slots, default to semantic): `--cssz-button-bg`, `--cssz-window-bar-bg`, `--cssz-section-bg`, `--cssz-tab-selected-bg`, `--cssz-input-bg`, etc.

**Type vars:** `--cssz-font` (Inter — see "Inter is canonical" below), `--cssz-mono` (JetBrains Mono), `--cssz-fs` (12.5px).

**Spacing vars:** `--cssz-pad` (8px), `--cssz-radius` (6px), `--cssz-input-pad` (6px 8px).

**Activation:** add `theme-modern` class to body. Add `dark` for dark mode. Add `theme-<tenant>` for brand overlay (e.g., `?tenant=sunset`). Subtree theming: drop CSSZ vars on any descendant, recursive scoping kicks in.

**Inter is canonical.** Upstream `frontend-design` skill says "avoid Inter" — that rule does NOT apply here. The modern theme is built around Inter + JetBrains Mono and tested with them. Tenant overlays may swap accent hue and page tint but font stays Inter unless the user explicitly asks for a font swap.

---

## Known SC quirks (recurring traps)

Memory entries — the canonical write-up:
- `~/.claude/projects/-home-bigale-repos-agentidev/memory/feedback_smartclient_minimum.md` — `ISC_DataBinding` is mandatory for forms; `waitForSystemDone` hangs on data-URI imgs; SC click handlers don't await async returns.
- `~/.claude/projects/-home-bigale-repos-agentidev/memory/feedback_smartclient_sectionstack.md` — SectionStack RECREATES section item DOMs on animate (render charts via `Label.setContents`); `sectionExpanded` callback unreliable (use delegated DOM click listener); state-suffixed classes pattern.

Recurring lessons that bite if forgotten:

1. **SectionStack DOM recreation.** Charts inside section bodies must be set via `Label.setContents(htmlString)` — direct `host.innerHTML = '...'` gets orphaned the next time *any* sibling section animates.
2. **Tahoe header icons are near-white PNGs.** On a light `--cssz-window-bar-bg`, close.png / maximize.png vanish. Recolor via `filter: var(--cssz-window-icon-filter, brightness(0))`; dark theme sets it to `none`.
3. **OKLCH hue interpolation** rotates through unrelated hues at large distances. For `color-mix(in oklch, accent X%, surface)` between hue 270 (indigo) and 95 (warm-white), the midpoint passes through 180 (green). Use `in srgb` for blends that should stay close to the source hue.
4. **Form items are `textItemLite*`, not `textItem*`** in Tahoe. Match `[class*="textItem"]` to catch both.
5. **JavaScript: URL footgun.** `href='javascript:expr'` evaluates `expr` and renders the return value as the page body. Always wrap with `void(...)`.

---

## Showcase recipes (grep patterns)

```bash
# By category
grep "_(Animation)_" packages/bridge/scripts/sc-showcase-index.md
grep "_(Tiling)_"    packages/bridge/scripts/sc-showcase-index.md
grep "_(Layout)_"    packages/bridge/scripts/sc-showcase-index.md
grep "_(Drag & Drop)_" packages/bridge/scripts/sc-showcase-index.md

# By widget
grep "TileGrid"      packages/bridge/scripts/sc-showcase-index.md
grep "PortalLayout"  packages/bridge/scripts/sc-showcase-index.md
grep "DetailViewer"  packages/bridge/scripts/sc-showcase-index.md

# By widget combination (cards using TileGrid + form)
grep "TileGrid.*DynamicForm" packages/bridge/scripts/sc-showcase-index.md
grep "ListGrid.*Label"       packages/bridge/scripts/sc-showcase-index.md

# By concept (substring match against example names)
grep -i "expand\|collapse" packages/bridge/scripts/sc-showcase-index.md
grep -i "hover\|over"      packages/bridge/scripts/sc-showcase-index.md
grep -i "filter"           packages/bridge/scripts/sc-showcase-index.md
```

For the actual example source code (when grep on the index isn't enough), the SmartClient SDK is at the path in `$SMARTCLIENT_SDK` env var (typically a sibling repo). Read example files there.

---

## Live precedent (what's already shipped)

What this stack looks like in production today. Read the source for patterns to copy or evolve.

**Mortgage calculator** — `~/repos/agentidev/experiments/mortgage-calculator/dist/index.html` (deployed at `https://sc-mortgage-demo.pages.dev/`)

| Pattern | What to look at |
|---|---|
| Modern theme + dark toggle + tenant overlay | `<head>` script tags for theme application; toggle button HTML+JS |
| 4-input DynamicForm + result panel | `isc.DynamicForm.create({ID: "calcForm", ...})` |
| D3 stacked-area chart with CSSZ-themed fills | `renderChart()` function |
| SectionStack with charts inside (using `setContents` pattern) | `renderBalanceChart()` + the SectionStack config |
| Dynamic affiliate CTA banner | `renderCTA()` function + `.cssz-cta` styles |
| Scenario URL hash encoding (CompressionStream + base64url) | `encodeScenario` / `decodeScenario` |
| Share modal (SC `Window` with embedded QR) | `openShare()` |
| Theme transitions + scenario-load animations + reduced-motion | `theme-modern.css` + `playLoadAnimation()` + the `@media (prefers-reduced-motion: reduce)` block |

---

## Mobile / device adaptation (SmartClient's idiom)

SmartClient is **desktop-first, scales down** — explicitly contrarian vs "mobile-first" frameworks because enterprise users need full productivity surfaces (search, analyze, update). The SC platform handles mobile adaptation with its own primitives; we should use those rather than reaching for CSS media queries (which fight SC's JS-driven layout measurement).

**Source:** Smart GWT MobileDevelopment reference (v14.1p), SC technology overview, Isomorphic mobile strategy page.

### Device flags

SC sets these at boot, components query them:

- `isc.Browser.isTouch` — touch device of any kind
- `isc.Browser.isHandset` — phone-sized
- `isc.Browser.isTablet` — tablet-sized
- `isc.Browser.isDesktop` — desktop browser

Manual overrides exist (`Browser.setIsTablet()` etc.) for unusual devices. **Read these flags; don't sniff user-agents directly.**

### What SC adapts automatically (no work for us)

- `SelectItem` / `ComboBoxItem` go full-screen on touch with explicit dismiss
- `Menu` goes full-screen, replaces simultaneous submenus with slide-in + back button
- `Calendar` drops Day/Week/Month tabs and uses device pivot
- `Window` / dialog fills the screen and drops rounded edges
- Slider thumbs / resize edges get expanded touch hit areas (visual size unchanged)
- `SpinnerItem` switches to side-by-side +/- instead of stacked
- Touch events normalize to mouse events: tap → mouseDown/mouseUp/click; touch-and-slide → drag/drop; touch-and-hold → contextMenu + hover fallback. **Existing desktop code largely "just works" on touch.**

### Discrete adaptive sizing (not fluid responsive)

Closer to **container queries than to media queries.** Components declare 2+ discrete render modes; the layout picks the one that fits. `AdaptiveMenu` is the poster child — renders inline / dropdown / mixed based on available space. Don't think "shrink everything fluidly"; think "discrete states, layout picks one."

### SplitPane — the master pattern

If you take one mobile pattern from SC, take this one. **`SplitPane` solves master-detail as a component**, not as application code:

- Desktop / tablet landscape: renders 2-3 panes simultaneously
- Phone / tablet portrait: switches to single pane with automatic Back navigation + header slot for the selected record's title
- Nests inside a `TabSet`

Wherever we have a "list on left, detail on right" structure (calc form + picker, dashboard sessions list + detail, plugin browser + plugin instance), `SplitPane` is the right primitive. Manual HLayout reorgs reinvent this badly.

### Wide-screen strategies (when SplitPane isn't enough)

In rough preference order (best → worst):

1. **Convert to `SplitPane`** — almost always the right answer
2. Horizontal touch scrolling via `overflow:auto` parents (lazy fallback)
3. `FlowLayout` to stack horizontal elements vertically when narrow
4. Shrink the scrolling component

### Mobile-specific accommodations worth knowing

- **Viewport meta:** SC auto-adds one that locks zoom to 100% (configurable). For iOS Safari's auto-hiding toolbars, use `minimal-ui` and reserve a ~20px landscape banner zone.
- **Soft-keyboard hints:** `TextItem.browserInputType: "email" | "tel" | "number" | "url"` etc.
- **Native helper apps:** standard `<a href="tel:...">` `mailto:` `sms:` patterns work.
- **Offline:** HTML5 manifest + `DataSource.useOfflineStorage` flag.

### Two opinions worth stealing

- **Don't mimic native UI.** Consistency between *your* desktop and mobile rendering matters more than looking like the host platform. Platform redesigns (iOS 6 → 7) invalidate mimicry investment. Use SC's CSS3-heavy skins (Shiva, Tahoe, Twilight, Stratus, Obsidian) — they work across both contexts.
- **Mobile is not the performance bottleneck.** Worst case is often an older desktop running IE. Modern phones run full frameworks fine. Mobile-specific ultra-light frameworks make you under-deliver on both sides.

### How this changes our design defaults

| Old default | New default |
|---|---|
| CSS `@media (max-width: 768px)` for layout collapse | Use SC's `isHandset` flag at component-creation time + `SplitPane` for master-detail surfaces |
| HLayout for form-and-picker pair, manually swapped to VLayout on small screens | `SplitPane` (auto desktop-multi-pane / mobile-single-pane with Back nav) |
| Custom mobile breakpoints / fluid sizing | Discrete render modes; component declares 2+ and picks via flag/container size |
| Mimic native iOS / Android conventions | Consistent SC-skin appearance across desktop + mobile of the same app |
| Mobile-specific lightweight build | One build; SC handles adaptation |

Memory note worth saving when we settle a mobile decision: the trap of reaching for CSS media queries with SC. The right answer is almost always `isHandset` + `SplitPane` + device-aware components.

## When this doc is wrong

If you find the stack diverged from this doc, the canonical sources win — fix the doc to match. Triggers worth updating for:
- New widget added to the calc (or any plugin) that joins the "what we use" set
- New CSSZ var introduced (or one renamed/removed)
- New SC quirk discovered (also add a memory entry)
- New tenant theme shipped (note the pattern + naming convention)
- Stack-level dep changes (bumped SC version, changed CDN, swapped a vendored library)
