# BOPPL Live Context Engine — Design System

*Dark-first. Notion-clean. Obsidian-restrained. macOS-precise.*

## Aesthetic north stars

The product is a writing tool people will sit inside for hours. Every visual choice has to serve focus, not flair. Three reference points I'm holding while making each call:

- **Notion** — block thinking, generous whitespace, calm typography, gentle hover states. What I'm taking: the rhythm and the restraint.
- **Obsidian** — dense when it needs to be, minimal chrome, panels that get out of the way. What I'm taking: sidebar discipline, keyboard-first ergonomics.
- **macOS native apps** (Things 3, Bear, Linear, Craft, Raycast) — precise spacing, hairline borders, optical adjustments, blur where it earns its place. What I'm taking: the polish.

What we are **not** doing:
- Rounded-everything cartoon UI
- Neon gradients
- Glassmorphism that fights legibility
- Dense engineer-tool styling (this isn't a CLI)
- Spline-style 3D objects (those live on the marketing site, never in the app)

**Dark is the primary mode.** Light exists for people who need it, but we design dark first and treat light as a port. This is a tool people use at 1am and at 9am — dark serves both.

---

## Color tokens

All values below are dark-mode tokens. Light-mode versions are derived inversions with hand-tuned contrast at the bottom of this section.

### Surfaces

```css
--surface-canvas      #0b0c0e   /* app background, full-bleed */
--surface-base        #14161a   /* default panel/card surface */
--surface-raised      #1c1f24   /* elevated cards, dropdowns */
--surface-overlay     #232730   /* popovers, modals */
--surface-input       #1a1d22   /* form fields */
--surface-hover       #1f232a   /* interactive hover */
--surface-active      #272c34   /* interactive pressed */
--surface-selected    rgba(139, 120, 240, 0.12);  /* selected row tint */
```

A note on the choice: Notion runs warmer (#191919 base). We run slightly cooler — a hint of blue keeps text legible over long sessions without going clinical. The 5-step ladder from canvas to overlay gives clean elevation without needing shadows when we want it.

### Borders and dividers

```css
--border-subtle    #1d2027   /* 1px hairlines on raised surfaces */
--border-default   #2a2e36   /* standard component borders */
--border-strong    #3c424c   /* focused / emphasized */
--border-focus     #8b78f0   /* keyboard focus ring (accent) */
```

Borders carry a lot of the structure. We do not use shadows where a 1px border will work — that's the macOS-app discipline.

### Text

```css
--text-primary     #ededed   /* body and headings */
--text-secondary   #a0a4ad   /* secondary text, labels */
--text-tertiary    #6b7280   /* placeholder, captions */
--text-disabled    #4a4f59
--text-inverse     #0b0c0e   /* text on accent fills */
--text-accent      #b0a3f5
```

Body text is `#ededed`, not pure white. Pure white on `#0b0c0e` is 19:1 contrast — past readable into glare territory. `#ededed` is ~16:1 and easier on the eye over hours.

### Accent — the brand color

```css
--accent-50     #f3f1ff
--accent-100    #e5e0ff
--accent-200    #cdc2ff
--accent-300    #ad9eff
--accent-400    #8b78f0   /* primary accent — buttons, links, focus */
--accent-500    #6b5cd4   /* hover */
--accent-600    #5444b8
--accent-700    #3f3290
```

A tuned violet that connects to the BOPPL brand palette (deep violet is one of your three site colors) but at lower saturation. The marketing site can scream coral and lime; the editor whispers in violet.

### Semantic

```css
--success-default   #22c55e
--success-bg        rgba(34, 197, 94, 0.12);
--warning-default   #f59e0b
--warning-bg        rgba(245, 158, 11, 0.12);
--danger-default    #ef4444
--danger-bg         rgba(239, 68, 68, 0.12);
--info-default      #3b82f6
--info-bg           rgba(59, 130, 246, 0.12);
```

Used sparingly. Most of the UI never touches these. They show up in toasts, error states, and the comment-resolved chip.

### Editor-specific

```css
--editor-cursor       #8b78f0
--editor-selection    rgba(139, 120, 240, 0.22);
--editor-block-hover  rgba(255, 255, 255, 0.025);
--editor-handle       #4a4f59      /* drag handle on hover */
--editor-comment      #f59e0b      /* comment anchor underline */
--editor-ghost-text   #6b7280      /* AI ghost text */
--code-bg             #0e1014
--code-border         #2a2e36
--mermaid-stroke      #8b78f0
--mermaid-fill        #1c1f24
```

### Light mode (derived, secondary)

```css
--surface-canvas    #ffffff
--surface-base      #fafafa
--surface-raised    #f4f5f7
--surface-overlay   #ffffff
--surface-input     #ffffff
--surface-hover     #f0f1f4
--surface-active    #e8eaee

--text-primary      #1c1f24
--text-secondary    #5a606b
--text-tertiary     #8b929e

--border-subtle     #ececef
--border-default    #e4e6eb
--border-strong     #c8ccd3

--accent-400        #6b5cd4   /* shifts darker in light mode for AA */
```

---

## Typography

```css
--font-sans    "Inter", -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
--font-serif   "Source Serif 4", "Iowan Old Style", "Georgia", serif;   /* optional read mode */
--font-mono    "JetBrains Mono", "SF Mono", "Menlo", monospace;
```

Inter is the call here. Notion-clean without being SF Pro (which we can't legally embed on the web). Variable font — load weights 400, 500, 600, 700 only.

### Scale (rem; 1rem = 16px)

```css
--text-xs     0.6875rem / 1rem        /* 11/16 — micro labels */
--text-sm     0.8125rem / 1.125rem    /* 13/18 — secondary UI */
--text-base   0.875rem  / 1.375rem    /* 14/22 — body in chrome */
--text-md     1rem      / 1.5rem      /* 16/24 — editor body default */
--text-lg     1.125rem  / 1.625rem    /* 18/26 — section headings */
--text-xl     1.375rem  / 1.75rem     /* 22/28 — H3 */
--text-2xl    1.75rem   / 2.125rem    /* 28/34 — H2 */
--text-3xl    2.25rem   / 2.625rem    /* 36/42 — H1 / page title */
```

Editor body sits at `--text-md` (16px). UI chrome (sidebar, headers, buttons) sits at `--text-base` (14px). This matches Obsidian's approach — chrome shrinks back so the writing surface can breathe.

### Weights

```css
--weight-regular    400   /* body text — minimum, no lower */
--weight-medium     500   /* emphasis, buttons */
--weight-semibold   600   /* headings, section titles */
--weight-bold       700   /* H1, primary CTAs only */
```

The minimum-400 rule from your BOPPL work carries over. Nothing below 400 anywhere in the product.

### Tracking

```css
--tracking-tight    -0.01em    /* H1, H2 */
--tracking-normal   0
--tracking-wide     0.04em     /* uppercase micro-labels */
```

---

## Spacing

4px base, multiplied:

```css
--space-0     0
--space-1     4px
--space-2     8px
--space-3     12px
--space-4     16px
--space-5     20px
--space-6     24px
--space-7     32px
--space-8     40px
--space-9     48px
--space-10    64px
--space-11    80px
--space-12    96px
```

**Editor reading width:** 720px max. The Obsidian / Craft sweet spot for prose at 16px. Wider goes airy and tires the eye; narrower feels cramped. A "wide mode" toggle bumps this to 1080px for tables and code-heavy docs.

**Sidebar width:** 240px default, 200px min, 360px max, user-resizable. Persists per-user.

**Chrome heights:** 44px top bar (macOS toolbar feel), 32px tab bar, 24px optional status bar.

---

## Border radius

```css
--radius-sm     4px      /* tag chips, micro pills */
--radius-md     6px      /* buttons, inputs — default */
--radius-lg     8px      /* cards, dropdowns, modals */
--radius-xl     12px     /* large surfaces, command palette */
--radius-2xl    16px     /* hero cards (rare) */
--radius-full   9999px   /* avatars, fully-rounded chips */
```

Notion uses 4–6px on buttons; Obsidian uses 4px; macOS apps use 6–8px. We sit at 6px default, stepping up to 8 or 12 for larger surfaces.

---

## Elevation

Shadows in dark mode are tricky — they vanish into the background. We use inset highlights plus outset shadows:

```css
--elev-1   inset 0 1px 0 rgba(255, 255, 255, 0.04);
           /* inset top-light highlight only, for cards */

--elev-2   inset 0 1px 0 rgba(255, 255, 255, 0.05),
           0 2px 8px rgba(0, 0, 0, 0.4);
           /* dropdowns, popovers */

--elev-3   inset 0 1px 0 rgba(255, 255, 255, 0.06),
           0 8px 24px rgba(0, 0, 0, 0.5);
           /* modals, command palette */

--elev-4   inset 0 1px 0 rgba(255, 255, 255, 0.08),
           0 16px 48px rgba(0, 0, 0, 0.6);
           /* full-screen overlays */
```

The inset highlight is the Linear / Raycast trick. It gives a surface its "lift" without relying on a shadow that disappears against dark backgrounds.

---

## Motion

```css
--ease-out      cubic-bezier(0.16, 1, 0.3, 1);         /* default — exponential out, snappy */
--ease-in-out   cubic-bezier(0.65, 0, 0.35, 1);        /* layout transitions */
--ease-spring   cubic-bezier(0.34, 1.56, 0.64, 1);     /* sidebar resize, modal appear */

--duration-instant      100ms
--duration-fast         150ms     /* default for hovers and state changes */
--duration-base         200ms
--duration-slow         300ms     /* modals, sidebars */
--duration-deliberate   400ms     /* command palette open */
```

Defaults:
- Any state change: `150ms` `--ease-out`
- Layout shift: `200–300ms` `--ease-in-out`
- Reduced motion: respect `prefers-reduced-motion: reduce` — drop to `100ms` and flatten easing

---

## Component patterns

### Buttons

Three variants × three sizes. All buttons share:
- `border-radius: var(--radius-md)` (6px)
- `font-weight: var(--weight-medium)` (500)
- `letter-spacing: 0`
- `cursor: pointer`
- Transitions: `background 150ms, border 150ms`

| Variant | Background | Hover | Text | Border |
|---|---|---|---|---|
| Primary | `--accent-400` | `--accent-500` | `--text-inverse` | none |
| Secondary | `--surface-raised` | `--surface-hover` | `--text-primary` | 1px `--border-default` |
| Ghost | transparent | `--surface-hover` | `--text-secondary` | none |
| Danger | `--danger-default` | shade -10% | white | none |

| Size | Height | Padding-x | Text |
|---|---|---|---|
| sm | 28px | 10px | `--text-sm` |
| md | 32px | 14px | `--text-base` |
| lg | 40px | 18px | `--text-md` |

Focus ring: `2px solid var(--border-focus)`, offset 1px.

### Inputs

```
Text input
  height: 32px   padding: 0 10px
  background: var(--surface-input)
  border: 1px solid var(--border-default)
  border-radius: var(--radius-md)
  font: var(--text-base) var(--font-sans)
  color: var(--text-primary)
  placeholder: var(--text-tertiary)
  
  :focus
    border-color: var(--accent-400)
    box-shadow: 0 0 0 3px rgba(139, 120, 240, 0.2)
```

Textarea inherits the same. Search input adds a leading 14px Lucide-search icon at `--text-tertiary`.

### Sidebar nav item

```
Default
  height: 28px   padding: 0 8px 0 12px
  font: var(--text-base)
  color: var(--text-secondary)
  border-radius: var(--radius-md)

Hover
  background: var(--surface-hover)
  color: var(--text-primary)

Active
  background: var(--surface-selected)
  color: var(--text-primary)
  + leading 2px accent bar (positioned 2px from the edge)
```

**Important:** no colored left-border. Active state uses a 2px indicator bar offset 2px from the edge — same visual signal, different mechanism. (This matches your BOPPL site rule.)

### Tabs (top of editor)

```
height: 32px   padding: 0 10px
font: var(--text-base)
color: var(--text-secondary)
border-bottom: 1px solid transparent

Hover  
  color: var(--text-primary)

Active  
  color: var(--text-primary)
  border-bottom: 1.5px solid var(--accent-400)
```

### Dropdown menu / context menu

```
Container
  background: var(--surface-overlay)
  border: 1px solid var(--border-default)
  border-radius: var(--radius-lg)
  box-shadow: var(--elev-2)
  padding: 4px
  min-width: 200px

Item
  height: 30px   padding: 0 10px
  font: var(--text-base)
  color: var(--text-primary)
  :hover  background: var(--surface-hover)

Divider
  height: 1px   margin: 4px 0
  background: var(--border-subtle)

Keyboard hint (right-aligned)
  font: var(--text-sm)
  color: var(--text-tertiary)
```

### Modal / dialog

```
Overlay
  background: rgba(0, 0, 0, 0.5)
  backdrop-filter: blur(8px)

Container
  background: var(--surface-overlay)
  border: 1px solid var(--border-default)
  border-radius: var(--radius-xl)
  box-shadow: var(--elev-3)
  max-width: 480px (default)
  padding: 24px

Title    font: var(--text-xl) var(--weight-semibold)  tracking: tight
Body     font: var(--text-base)  color: var(--text-secondary)
Footer   flex justify-end gap-8px  padding-top: 16px
```

### Toast

```
Position: bottom-right, 24px from edges
Background: var(--surface-overlay)
Border: 1px solid var(--border-default)
Border-radius: var(--radius-lg)
Box-shadow: var(--elev-2)
Padding: 12px 16px

Layout: [16px semantic icon][8px gap][text at --text-base]

Auto-dismiss: 4s
Pause on hover
Stack vertically from bottom
Max 3 visible at once
```

### Command palette (⌘K)

```
Position: top-center, 20vh from top
Width: 640px max
Background: var(--surface-overlay)
Border: 1px solid var(--border-default)
Border-radius: var(--radius-xl)
Box-shadow: var(--elev-3)
Backdrop: rgba(0, 0, 0, 0.4) + backdrop-filter: blur(12px)

Input
  height: 48px
  font: var(--text-lg)
  placeholder color: var(--text-tertiary)
  border-bottom: 1px solid var(--border-subtle)
  (no other borders)

Result row
  height: 40px   padding: 0 16px
  flex: [14px icon][label][right-aligned shortcut]
  :hover, :selected  background: var(--surface-hover)

Group header
  padding: 8px 16px
  font: var(--text-xs)
  color: var(--text-tertiary)
  letter-spacing: var(--tracking-wide)
  text-transform: uppercase
```

This is the Raycast / Linear pattern. Single most-used surface in the app. Worth nailing.

### Tooltip

```
Background: var(--surface-overlay)
Border: 1px solid var(--border-default)
Border-radius: var(--radius-md)
Box-shadow: var(--elev-2)
Padding: 4px 8px
Font: var(--text-sm)
Color: var(--text-primary)

Delay: 400ms in, 100ms out
```

### Avatar

```
Sizes: sm 20px / md 24px / lg 32px / xl 40px
Border-radius: var(--radius-full)
Background: deterministic from sha256(user_id) → palette of 12 muted hues
Foreground: var(--text-primary) initials, var(--weight-medium)
Stack border: 1.5px var(--surface-canvas) (for overlap groups)
```

### Tag chip

```
Height: 22px   padding: 0 8px
Border-radius: var(--radius-sm)
Background: var(--surface-raised)
Font: var(--text-xs)
Color: var(--text-secondary)
:hover (interactive)  background: var(--surface-hover)
```

---

## Editor surface

The heart of the app. Specs that govern the writing surface:

### Page chrome

The doc title is editable inline — no separate input field. Title is `--text-3xl` `--weight-semibold` `--tracking-tight`. The cursor sits naturally below; body is `--text-md` (16px).

### Block hover affordance

On hover, a 16×16 drag handle (`⋮⋮` icon, color `--editor-handle`) appears 24px to the left of the block. An "add block" `+` button appears 8px above the handle on hover of the previous-block end. Both fade in over 100ms.

### Slash menu

Triggered by `/` at start of empty line or after space. Opens an `--surface-overlay` panel directly below the cursor, `--elev-2`, 280px wide. Filters as you type. First result auto-selected. Tab or click inserts. Esc dismisses.

### Selection and cursors

- Text selection: `--editor-selection` (accent at 22% opacity)
- Caret: `--editor-cursor` (accent)
- Multi-user cursors show a username chip at `--text-xs` `--weight-medium` above caret, color-coded per user from a 12-hue palette

### Code blocks

Background `--code-bg` (slightly darker than body), 1px `--code-border`, `--font-mono` at `--text-base`. Syntax highlighting via Shiki using the `github-dark` theme re-tuned to our palette. Copy button top-right, visible on hover.

### Mermaid

Rendered with custom theme — strokes `--mermaid-stroke` (accent), fills `--mermaid-fill`, text `--text-primary`. Renders inline; click expands to a modal.

### KaTeX

Rendered in `--text-primary` at the same size as surrounding text for inline math. Display math centers, gets 16px vertical margin.

### AI ghost text

Appears inline at cursor, color `--editor-ghost-text`, same font and size as surrounding text. Tab inserts and advances cursor; Esc dismisses; any other keystroke aborts. A tiny "AI" pill at `--text-xs` appears 4px right of the ghost text's end — fades in 200ms after suggestion appears, so it doesn't feel pushy.

### Comments

Anchored text gets a 1.5px underline in `--editor-comment` (warning amber, 60% opacity). Hovering opens a small popover at `--elev-2` with the thread. Resolved comments lose the underline; show on demand via a "Show resolved" toggle.

### Sidebar

Doc tree at top, search bar above it, settings/profile at bottom. Doc tree uses 28px-tall rows, 16px icon column, 8px indent per nesting level. Active doc gets the 2px accent indicator described in the nav-item spec.

### Right rail (Phase 2, hideable)

Width 280px, same surface treatment as sidebar. Three tabs:
- **Outline** — clickable headings extracted from current doc
- **Comments** — threaded comments for current doc
- **Related** — AI-suggested related docs via semantic similarity

---

## Iconography

**Library:** Lucide React. Single source. Every icon at one of: 12, 14, 16, 20, 24 px. Stroke 1.5px (Lucide default). No mixing with other icon sets.

**Color rule:** icons inherit the text color of their parent. Manual color overrides only for semantic icons (e.g., the green check in a "success" toast).

---

## Layout grid

Three-zone layout (sidebar | content | optional right rail):

```
┌─────────────────────────────────────────────────────────┐
│  Top bar (44px)                                         │
├──────────┬──────────────────────────────────┬───────────┤
│          │                                  │           │
│ Sidebar  │  Editor canvas                   │  Right    │
│ 240px    │  max-width: 720px centered       │  rail     │
│          │  (1080px in "wide" mode)         │  280px    │
│          │                                  │  (opt)    │
│          │                                  │           │
├──────────┴──────────────────────────────────┴───────────┤
│  Status bar (24px, optional)                            │
└─────────────────────────────────────────────────────────┘
```

Responsive collapse points:
- Below **1200px**: right rail folds into a button in the top bar
- Below **900px**: sidebar folds into an overlay drawer (toggled from top bar)
- Below **640px**: read-only view only (Phase 3 introduces full mobile editing)

---

## Loading states

Two patterns, used in their right places:

**Skeleton (for content):** `--surface-raised` bars with a subtle shimmer (`background-position` animation, 1.4s loop). Width approximates expected content. Always preferable to spinners for known-shape content.

**Spinner (for in-flight actions):** 16px circular spinner in `--accent-400`. Used in buttons during submit, in the search bar during query, never as a page-level loader.

---

## Empty states

Every "no data yet" state has four elements:
1. Small icon — 24px Lucide, color `--text-tertiary`
2. Headline — `--text-md` `--weight-medium` `--text-primary`
3. Subline — `--text-base` `--text-secondary`, max 2 lines
4. Optional primary action button

Max width: 320px. Centered in container.

Never have a blank space. Empty is a designed state.

---

## Accessibility floor

Non-negotiable:
- **Contrast minimum:** AA (4.5:1 body, 3:1 large text). The dark palette above is verified AA across all combinations.
- **Focus visible:** every interactive element. 2px `--border-focus` ring, never removed except where replaced with an equivalent indicator.
- **Keyboard navigation:** every flow operable without a mouse. ⌘K for command palette; arrow keys + Enter for menu navigation; Esc dismisses.
- **Reduced motion:** respect `prefers-reduced-motion: reduce`.
- **Screen reader:** every icon-only button has an `aria-label`.
- **High contrast mode:** all border colors switch to `--border-strong` when `forced-colors: active`.

---

## Implementation note

These tokens are designed to drop straight into a `globals.css` `:root` block, with a `.light` class providing the light-mode override. For Tailwind: extend `tailwind.config.ts`'s `theme.colors` with `surface.*`, `text.*`, `border.*`, `accent.*`; `theme.fontSize` with the type scale; `theme.borderRadius` with the radius scale; `theme.boxShadow` with the elevation scale. The values are already named in `var(--token)` form, so Tailwind v4's `@theme` directive can consume them directly.

---

## What's deliberately out of scope

So we don't drift:
- **No glassmorphism beyond the explicit backdrop-blur on modals and command palette.** The macOS-app inspiration ends at "subtle."
- **No emoji in UI chrome.** Emoji belong inside user docs. Lucide everywhere else.
- **No animation on text values.** Text doesn't slide, fade between values, or jiggle. It appears, it changes, that's it.
- **No gradients in the editor surface.** Gradients live on the marketing site only.
- **No custom scrollbars in chrome.** Native scrollbars only, restyled minimally via `scrollbar-color: var(--border-default) transparent`.
- **No theme switcher in MVP.** Dark-first means dark-only at launch; light mode lands in Week 8 as part of productization polish.
