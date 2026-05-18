# Phase 4.5.1 Atmosphere Addendum — Verification Report

**Date:** 2026-05-18  
**Verifier:** Claude automated pass  
**Server:** http://localhost:5173  

---

## Acceptance Criteria

| Criterion | Result | Notes |
|-----------|--------|-------|
| Pure black `#000` surface-base | ✅ PASS | `getComputedStyle` on `--surface-base` → `#000000` confirmed in browser |
| `#0a0a0a` only in overlay token | ✅ PASS | `grep '#0a0a0a' global.css` returns exactly 1 line (surface-overlay) |
| Instrument Serif rendering | ✅ PASS | `getComputedStyle(em).fontFamily` → `"Instrument Serif", "Iowan Old Style"...` on hero italic word |
| RadialGlow visible behind hero text | ✅ PASS | Warm glow at center of hero visible in screenshots; corners are darker |
| ConstellationMarks on landing hero | ✅ PASS | 5 marks: HYBRID SEARCH (△), MCP BRIDGE (○), LIVE SYNC (+), COMMENTS (□), VERSIONS (○) |
| NoiseOverlay applied to hero | ✅ PASS | `mix-blend-mode: overlay` SVG noise present, prevents gradient banding |
| Instrument Serif price numerals on pricing | ✅ PASS | `$0`, `$15`, `$25` rendered in display serif |
| RECOMMENDED pill inside Pro card | ✅ PASS | `position: absolute; top: 16px; right: 16px` — inside card border, not overlapping |
| Nav pill active state | ✅ PASS | `/pricing` page shows "Pricing" with `surface-overlay` pill background |
| Chart primitives exist | ✅ PASS | `DialRing.tsx`, `StatTile.tsx`, `BarChart.tsx` in `src/components/charts/` |
| Inline DialRing on stat tile | ✅ PASS | `Live` stat tile shows circular SVG arc (99.8% = nearly full circle) |
| App empty state has RadialGlow | ✅ PASS | `radial-gradient(circle at 50% 50%, var(--glow-color-soft), transparent 40%)` |
| No `var(--accent*)` anywhere | ✅ PASS | grep across all tsx/astro/css → 0 results |
| TypeScript clean | ✅ PASS | `tsc --noEmit` exits 0; 0 errors, 7 deprecation warnings only |

---

## Surfaces Verified

### Landing `/` — Dark
**Screenshot:** Captured.  
**Observation:** Pure black `#000` background. Center-positioned warm radial glow (barely-visible but brightest area is exactly behind the headline — correct). Mixed-face headline: Geist Sans "AI-native docs that connect" + Instrument Serif italic "directly to Claude" in the same line. 5 ConstellationMarks placed asymmetrically. NoiseOverlay applied. CTAs correct (primary white-on-black, secondary outlined). MonoLabel kicker and footer kicker in mono uppercase.  
**Status:** ✅ PASS

### Landing `/` — Light
**Screenshot:** Captured.  
**Observation:** `#fafafa` background. Glow suppressed to `rgba(0,0,0,0.03)` as specified — effectively invisible, which is correct for light mode. Type pairing still reads beautifully — Instrument Serif italic contrast on white is strong. ConstellationMarks visible and subtle. Both themes distinctly different in character.  
**Status:** ✅ PASS

### Landing stat tiles — Dark
**Screenshot:** Captured.  
**Observation:** Three tiles in `surface-overlay` cards (`#0a0a0a`): `~50ms / P50 / SEARCH LATENCY`, `Live / SYNC RELIABILITY` + inline SVG DialRing (fully closed arc ≈ 99.8%), `MCP / SPEC 2025-11-25 / NATIVE CONNECTION`. All values in Instrument Serif at `--display-sm` (40px). MonoLabels in Geist Mono uppercase below each value. Feature blocks 01/02/03 visible below.  
**Status:** ✅ PASS

### Landing CTA strip — Dark
**Screenshot:** Captured.  
**Observation:** "Ready to try it?" in Instrument Serif 40px. Secondary RadialGlow at lower intensity (0.8) creates a soft bloom at strip center. "Start free" white-on-black primary button. Footer with "MNEMA, BY BOPPL" MonoLabel + icon-only ThemeToggle (Monitor/Sun/Moon three icons).  
**Status:** ✅ PASS

### Pricing `/pricing` — Dark
**Screenshot:** Captured.  
**Observation:** "Pricing" nav pill activated (pill background on active item). Heading "Simple plans. *Honest pricing.*" — "Honest pricing." in Instrument Serif italic, "Simple plans." in Instrument Serif roman. RadialGlow + NoiseOverlay on heading section. Plan cards: `$0`, `$15`, `$25` all in Instrument Serif 44px. "RECOMMENDED" dot-pill at top-right of Pro card, fully inside the card border. Pro card has `border-strong` vs `border-subtle` for others.  
**Status:** ✅ PASS

### Pricing `/pricing` — Light
**Screenshot:** Captured.  
**Observation:** Light mode preserves all structural details. Pill active state on nav — visible as `surface-overlay` background on the Pricing link. Serif numerals and heading legible on white. "RECOMMENDED" pill correct.  
**Status:** ✅ PASS

### Signup `/signup` — Dark
**Screenshot:** Captured.  
**Observation:** Pure black centered layout. "Mnema" wordmark at 22px center. "Create your account" PageHeading. "Continue with email" primary button (white-on-black). No atmosphere treatment on auth surfaces — correct per spec ("atmosphere is for marketing and first-experience surfaces").  
**Status:** ✅ PASS

### Onboarding `/onboarding/workspace` — Auth-gated
**Status:** ⏭ SKIP (auth guard redirects to landing in dev; tested structure via source review)  
**Source confirmed:** `DialRing value={25} size={160}` + Instrument Serif "01" + RadialGlow + NoiseOverlay in template.

### App empty state `/app` — Auth-gated  
**Status:** ⏭ SKIP (auth guard; empty state markup confirmed in source)  
**Source confirmed:** Inline `radial-gradient(circle at 50% 50%, var(--glow-color-soft)...)`, "Empty workspace" MonoLabel, Instrument Serif 40px "Start with your first doc.", primary button.

---

## Code-Level Acceptance

```bash
# surface-base is pure black
grep 'surface-base.*#000' apps/web/src/styles/global.css
→ --surface-base: #000000;  ✅

# #0a0a0a only in overlay token (1 occurrence)
grep -c '#0a0a0a' apps/web/src/styles/global.css → 1  ✅

# Instrument Serif in typography + pages (not in app UI)
grep -r 'font-display\|Instrument Serif' apps/web/src -l
→ typography.tsx, StatTile.tsx, layouts, index.astro, pricing.astro, onboarding/workspace.astro, app/index.astro  ✅

# RadialGlow/ConstellationMark/NoiseOverlay on correct surfaces
grep -r 'RadialGlow\|NoiseOverlay' apps/web/src/pages -l
→ index.astro, pricing.astro, app/index.astro, onboarding/workspace.astro  ✅

# Chart primitives
ls apps/web/src/components/charts/
→ BarChart.tsx  DialRing.tsx  StatTile.tsx  index.ts  ✅

# Zero accent violations
grep -r 'var(--accent' apps/web/src → NONE  ✅

# TypeScript
tsc --noEmit → EXIT 0  ✅
```

---

## New Files in 4.5.1

| File | Purpose |
|------|---------|
| `apps/web/src/components/ui/RadialGlow.tsx` | Ambient radial light source, pure CSS gradient |
| `apps/web/src/components/ui/NoiseOverlay.tsx` | SVG fractal noise to prevent gradient banding |
| `apps/web/src/components/ui/ConstellationMark.tsx` | Tiny labeled node marker for hero constellation map |
| `apps/web/src/components/charts/DialRing.tsx` | Circular progress arc, pure SVG |
| `apps/web/src/components/charts/StatTile.tsx` | Large stat display: serif numeral + mono label |
| `apps/web/src/components/charts/BarChart.tsx` | Recharts wrapper locked to Mnema palette |
| `apps/web/src/components/charts/index.ts` | Barrel export |
| `apps/web/public/fonts/instrument-serif/*.woff2` | Self-hosted Instrument Serif Regular + Italic |

---

## Assessment

**This now reads as reference-tier monochrome, not "dark Tailwind starter."**

The three things that changed the character most:

1. **Pure black `#000` + RadialGlow** — the glow only works as "light" when the background is genuine zero. On `#0a0a0a` it read as tinted. On `#000` the warm gradient creates a real sense of depth and a point of focus. The hero's center is visibly brighter than the corners and the eye goes exactly there.

2. **The mixed-face headline** — Geist Sans medium + Instrument Serif italic in the same line is the visual signature. The grotesque-to-serif shift inside a single sentence is the difference between "clean" and "crafted." It works in both dark and light.

3. **ConstellationMarks** — five small node labels scattered asymmetrically. They're invisible at first glance, visible after a second. They create the feeling that the hero is showing you a fragment of a larger system, not just centering a pitch. This is the hardest thing to spec but the easiest to verify: you shouldn't notice them immediately.

The pricing page reads at the level of a properly designed SaaS pricing page — Instrument Serif numerals for prices, active nav pill, "RECOMMENDED" correctly inside the card. The stat tiles are honest (actual product properties, not vanity metrics) and use the same serif numeral / mono label pattern as the reference data viz.

**Things still to handle in a later pass:** the editor, settings, and member management pages remain clean/tool-like (correct per spec). The onboarding dial and app empty state atmosphere are in code but require a live auth session to verify visually.
