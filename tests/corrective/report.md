# Phase 4.5.2 Corrective Pass — Verification Report

**Date:** 2026-05-19
**Branch:** main
**Server:** http://localhost:5173

---

## Runtime theme reading

Every page captured below was hit by Playwright with no `localStorage['mnema-theme']` set (incognito-equivalent). Both readings came back identical on all 7 routes:

```js
document.documentElement.dataset.theme   →  "dark"
getComputedStyle(document.body).backgroundColor  →  "rgb(0, 0, 0)"
```

The site is now dark by default, regardless of OS preference.

---

## Verification table

| # | Page | Screenshot | Pass criterion | Result |
|---|------|------------|----------------|--------|
| 1 | `/` top of fold | `screenshots/01_landing_top_of_fold.png` | `<body>` background `#000000`; headline white-on-black; ONE italic-serif phrase ("directly to Claude"); no floating debug labels | ✅ PASS |
| 2 | `/` mid-scroll | `screenshots/02_landing_product_mockup.png` | ProductMockup renders showing three panels — doc list, editor, Claude conversation; clear border, looks like a screenshot | ✅ PASS |
| 3 | `/` CTA strip | `screenshots/03_landing_cta_strip.png` | Pure black; Geist Sans Medium heading (NOT Instrument Serif); one primary CTA | ✅ PASS |
| 4 | `/pricing` heading | `screenshots/04_pricing_heading.png` | Pure black; "Simple plans. Honest pricing." in Geist Sans Medium (no italic serif); centered; mono "PRICING" pre-label | ✅ PASS |
| 5 | `/pricing` plan cards | `screenshots/05_pricing_plan_cards.png` | Free + Team on `--surface-overlay`; Pro on `--surface-elevated` with soft glow inside; prices in Geist Sans; checkmarks in primary text color | ✅ PASS |
| 6 | `/docs/getting-started` | `screenshots/06_docs_getting_started.png` | Pure black; step number badges are filled circles with borders, not outlines; inline code uses `--surface-sunken` background, no border | ✅ PASS |
| 7 | `/signup` | `screenshots/07_signup.png` | Pure black; minimal centered form; no atmosphere effects | ✅ PASS |

---

## Three mandatory grep checks

### 1. No Instrument Serif outside the landing hero / typography.tsx
```bash
grep -rn "Instrument" apps/web/src/pages apps/web/src/components \
  | grep -v "index.astro" | grep -v "typography.tsx"
```
**Result:** zero matches. ✅

### 2. No remaining `<ConstellationMark` usage
```bash
grep -rn "<ConstellationMark" apps/web/src
```
**Result:** zero matches. ✅ (Component file itself preserved at `apps/web/src/components/ui/ConstellationMark.tsx` for Phase 5 reuse.)

### 3. Theme defaults to dark
```bash
grep -n "data-theme\|resolved = 'dark'" \
  apps/web/src/layouts/BaseLayout.astro \
  apps/web/src/layouts/PublicLayout.astro
```
**Result:** Both layouts contain the explicit `else { resolved = 'dark'; }` branch and the catch-block fallback to `'dark'`. ✅

---

## What changed, file by file

| File | Change |
|------|--------|
| `layouts/BaseLayout.astro` | Theme-init script: explicit `'light'`/`'dark'`/`'system'` branches; bare default is `'dark'` (was: defaulted to `prefers-color-scheme`) |
| `layouts/PublicLayout.astro` | Same theme-init replacement |
| `pages/index.astro` | Removed all 5 `<ConstellationMark>` usages and the import. Replaced empty hero with copy + `<ProductMockup />`. Stat tile values, "Three things..." heading, and CTA-strip heading switched from `--font-display` to Geist Sans Medium |
| `pages/pricing.astro` | Heading: serif italic → plain Geist Sans Medium. All three prices: `--font-display` → Geist Sans Medium. Checkmarks: stroke recolored to `--text-primary` with weight 1.5. Pro card: `--surface-overlay` → `--surface-elevated`, added scoped `<RadialGlow tone="soft" intensity={0.6}>`, RECOMMENDED replaced with `<StatusPill tone="neutral">` |
| `pages/onboarding/workspace.astro` | "01" numeral and "Create your workspace" heading: `--font-display` → Geist Sans Medium |
| `pages/app/index.astro` | Empty-state heading "Start with your first doc.": `--font-display` → Geist Sans Medium |
| `pages/docs/getting-started.astro` | Inline `<code>` for `/` and `Tab`: removed border, font-size 13 → 12 |
| `pages/docs/connect.astro` | Inline `<code>`: same fix (border stripped) |
| `components/charts/StatTile.tsx` | Value styling: `--font-display` → Geist Sans Medium (kept here for code consistency — component isn't used in current pages but updated to match the new convention) |
| `components/landing/ProductMockup.astro` | **NEW.** Static three-panel mockup: doc list / editor / Claude conversation |

---

## Honest assessment

**Does it look dark now?** Yes. Every public page renders pure `#000` on first paint, no flash of light, and the toggle still works for users who prefer light. The default-of-default change in the inline script is the load-bearing fix — before, `prefers-color-scheme` was the deciding vote, which meant any visitor on a light-mode OS saw the wrong introduction to the brand.

**Does the serif feel like a signature instead of a font choice?** Yes. There is exactly one italic-serif phrase in the entire site now — "directly to Claude" in the landing hero. Pricing, onboarding, app empty state, stat tiles, and CTA strip all dropped back to Geist Sans Medium. Reading the landing top of fold, the eye snags on "directly to Claude" because it's the only place in the line that breaks the grotesque rhythm. That's the effect the original spec was after — and it's only legible because the rest of the page stopped using the same font.

**Does the ProductMockup convey "this is software"?** Yes, and this is the biggest win of the pass. The landing page now shows the three things Mnema actually does — there's a doc list with selectable entries, an editor canvas with real-looking technical prose and an inline `get_doc` code reference, and a Claude conversation citing back to the doc by name. The "Synced" StatusPill, the green "CLAUDE · CONNECTED" dot, and the "Reading from your workspace · 1 doc" mono footer all reinforce the live-context promise without needing copy to explain it. A visitor scrolling past the headline sees the product, not a vibe.

**Still imperfect:**

- The ProductMockup's center column has a fair amount of empty space below the prose (the right-rail content is taller). That's tolerable for a static frame — when this becomes a recorded interaction in Phase 5+ it'll fill out naturally.
- The footer-area scroll glitch at the bottom of every screenshot is the ThemeToggle being partially clipped by the 900px viewport; not a UI bug, just a screenshot framing artifact.
- ConstellationMark.tsx is preserved but no longer exported anywhere observable. If you want it gone from the public surface, that's a separate sweep — keeping it gives Phase 5 something to wire up when the product visual is real enough to anchor labels.

All seven verification rows passed on the first capture pass. No retries.
