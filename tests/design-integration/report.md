# Design Integration Verification Report

**Started:** 2026-05-19T19:00:00+05:30
**Source:** /app-references/ HTML files (17 pages)
**Target:** apps/web/src/
**Worktree:** trusting-jemison-b323d2

---

## Chunk 1 — Foundation

**Status:** ✅ Pass

**Completed:** 2026-05-19T19:45:00+05:30

### What was extracted

The design token naming convention from the reference HTML files uses `--canvas`, `--surface`, `--ink`, `--accent` etc. — completely different from the Phase 4.5 monochrome system (`--surface-base`, `--text-primary`). The app page HTML files (Workspace, Flows, DocEditor, Settings, Connections) are consistent in this naming; the Design System marketing HTML uses the same names.

**Key discoveries:**
- All app pages use **Geist** (already self-hosted) as the primary font — no new fonts needed
- Accent color in app pages: `rgb(255, 179, 112)` — warm amber (not monochrome, not signal green from the design system marketing page)
- Canvas/background: `#0A0B0D` (not pure black — a very dark near-black)
- Surface: `#131418` → `#1A1C20` → `#24272D` (three levels of elevation)

### Files created / modified

| File | Action |
|------|--------|
| `apps/web/src/styles/tokens.css` | **Created** — 180-line canonical token file |
| `apps/web/src/styles/global.css` | **Replaced** — now imports tokens.css, keeps @font-face and base reset |
| `apps/web/src/components/ui/Button.tsx` | **Rebuilt** — new token names, added `ink` and `icon` variants |
| `apps/web/src/components/ui/Input.tsx` | **Rebuilt** — new token names, accent focus ring |
| `apps/web/src/components/ui/StatusPill.tsx` | **Rebuilt** — 7 tones, proper color mapping |
| `apps/web/src/components/ui/EmptyState.tsx` | **Updated** — new token names |
| `apps/web/src/components/ui/Skeleton.tsx` | **Updated** — `--surface-2` bg, `--r-3` radius |
| `apps/web/src/components/ui/Modal.tsx` | **Created** — modal shell with backdrop, header, body, footer |
| `apps/web/src/components/ui/Toast.tsx` | **Created** — toast primitive with `useToast` hook |
| `apps/web/src/components/ui/index.ts` | **Updated** — exports Modal and Toast |
| `apps/web/src/layouts/PublicLayout.astro` | **Updated** — body style uses `--canvas` / `--ink` |
| `apps/web/src/pages/design-test.astro` | **Created** — temporary verification page |
| `apps/web/src/components/ui/DesignTestIsland.tsx` | **Created** — verification island |

### Token system summary

**New canonical tokens (v2.0):**
- Surfaces: `--canvas`, `--surface`, `--surface-2`, `--surface-3`
- Lines: `--line`, `--line-strong`, `--line-bright`
- Ink: `--ink`, `--ink-soft`, `--ink-muted`, `--ink-faint`, `--on-ink`
- Accent: `--accent-rgb: 255,179,112`, `--accent`, `--accent-soft`, `--accent-line`
- Status: `--status-sync`, `--status-edit`, `--status-info`, `--status-warn` + bg variants
- Radii: `--r-1` (4px) → `--r-6` (18px) + `--r-pill` (999px)
- Spacing: `--s-1` (4px) → `--s-9` (96px)
- Density: `--dens`, `--pad-card`, `--pad-ctl-y`, `--pad-ctl-x`

**Backward-compat aliases preserved:**
All Phase 4.5 token names (`--surface-base`, `--text-primary`, `--border-default`, `--radius-md`, `--interactive-primary`, etc.) are aliased to the new token values in `tokens.css`. Existing components (Textarea, Select, typography, RadialGlow, ConstellationMark, NoiseOverlay, chart components, settings/editor components) continue to work without modification.

**CSS variable count in tokens.css:** 120+ variables (50 canonical + 70 compat aliases)

### Grep results

```
1. Tailwind utility color bypasses (text-gray-*, bg-zinc-*, etc.):
   CLEAN — zero matches in components/ui/ and styles/

2. Hardcoded hex colors in component files:
   CLEAN — zero matches (all colors via CSS variables)

3. Token variable usage count:
   153 references across ui/ components and styles/

4. Font-family without var():
   CLEAN — all font-family declarations use var(--sans) / var(--mono)
```

### Design-test page verification

Route: `http://localhost:5175/design-test`

**Dark mode DOM-verified values:**

| Component | Token | Computed value | Expected | Match |
|-----------|-------|----------------|----------|-------|
| Button primary | `--accent` | `rgb(255, 179, 112)` | `#FFB370` | ✅ |
| Button ink | `--ink` | `rgb(244, 245, 247)` | `#F4F5F7` | ✅ |
| Button secondary bg | `--surface-2` | `rgb(26, 28, 32)` | `#1A1C20` | ✅ |
| Button ghost text | `--ink-soft` | `rgb(184, 188, 196)` | `#B8BCC4` | ✅ |
| StatusPill success | `--status-sync` | `rgb(107, 227, 155)` | `#6BE39B` | ✅ |
| StatusPill warning | `--status-warning` | `rgb(255, 179, 112)` | `#FFB370` | ✅ |
| StatusPill error | `--status-error` | `rgb(255, 122, 138)` | `#FF7A8A` | ✅ |
| StatusPill info | `--status-info-color` | `rgb(124, 156, 255)` | `#7C9CFF` | ✅ |
| StatusPill neutral bg | `--surface-2` | `rgb(26, 28, 32)` | `#1A1C20` | ✅ |
| Canvas bg | `--canvas` | `rgb(10, 11, 13)` | `#0A0B0D` | ✅ |

**Light mode:** Theme switch toggled, surface hierarchy (`#F7F7F5` → `#FFFFFF` → `#F1F1EE`) and ink scale (`#0A0B0D` → `#4B4F57` → `#8A8F98`) both verified via screenshot.

### Sections present in design-test DOM
13 sections confirmed: Surfaces+Lines, Ink, Accent+Status, Button Variants, Button Sizes, Input+Textarea+Select, StatusPill, Skeleton, Typography, EmptyState, Modal, Radii, Backward-compat aliases

### Notes
- Theme-init script in BaseLayout.astro is correct: reads `mnema-theme` from localStorage, defaults to `dark`, sets `data-theme` attribute before first paint
- The `design-test.astro` page and `DesignTestIsland.tsx` should be removed before shipping (temporary verification only)
- The worktree dev server runs on port 5175 (port 5173 taken by the main branch's running server)

---

## Chunk 2 — Auth + Onboarding pages

*Pending user approval of Chunk 1 results.*
