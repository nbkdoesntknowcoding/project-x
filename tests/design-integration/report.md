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

**Started:** 2026-05-19T20:00:00+05:30

---

### Page 2.1 — Signup (`/signup`)

**Status:** ✅ Pass

**Completed:** 2026-05-19T20:30:00+05:30

**Reference:** `app-references/Signup.html`
**Target:** `apps/web/src/pages/signup.astro`

#### What was rebuilt

Complete rewrite of `signup.astro` as a standalone page (no BaseLayout) to match the reference pixel-for-pixel.

**Key design decisions:**
- Auth accent overridden locally to near-white (`--accent-rgb: 244, 245, 247`) since auth pages use a different accent than the rest of the app (which uses amber)
- Aux colors defined locally: `--aux-1-rgb: 124,156,255` (blue), `--aux-2-rgb: 200,162,255` (violet), `--aux-3-rgb: 255,144,120` (coral)
- All CSS class names prefixed with `s-` to avoid conflicts with global styles
- `import '../styles/global.css'` in frontmatter provides the token system; `<style is:global>` adds page-specific styles
- Star particles created by `is:inline` script to bypass Astro's scoped style restriction
- Auth flow preserved: email button shows spinner (1.2s) → green "✓ Check your inbox" → redirects to `/auth/login?intent=signup`

#### Verified elements

| Element | Status |
|---------|--------|
| Animated fluid background (6 blobs, goo filter, aurora, grid, scan line, 60 stars) | ✅ |
| SVG goo filter (`feGaussianBlur stdDeviation=22` + `feColorMatrix 22 -11`) | ✅ |
| Topbar — 64px height, μ Mnema brand, "Already have an account? Sign in →" | ✅ |
| Auth card — 420px, `rgba(6,7,10,0.72)` glass, `blur(24px) saturate(140%)`, 20px radius | ✅ |
| Gradient border via `::before` mask-composite trick | ✅ |
| Under-glow via `::after` | ✅ |
| 56px μ glyph icon (`var(--surface-2)` bg, 16px radius) | ✅ |
| h1 "Create your account" (600, 24px, -0.02em) | ✅ |
| Sub text — 14px `var(--ink-muted)` | ✅ |
| Email field — label + "REQUIRED" hint, 13px 14px padding, `rgba(255,255,255,0.03)` bg | ✅ |
| Email validation — button disabled until valid email format | ✅ |
| "Continue with email →" submit state — spinner → green "✓ Check your inbox" | ✅ |
| "OR CONTINUE WITH" divider with `::before`/`::after` lines | ✅ |
| 2×2 SSO grid — Google, GitHub, Microsoft, Apple (with correct brand SVGs) | ✅ |
| Legal text with Terms + Privacy Policy links | ✅ |
| "Already have an account? Sign in" below card | ✅ |
| Trust strip — "4,800+ WORKSPACES · SOC 2 TYPE II · MCP 2025-11-25" | ✅ |
| Fixed corner mark — "MNEMA · v2.0 · AUTH" | ✅ |
| Fixed status pill — pulsing green dot + "ALL SYSTEMS LIVE" | ✅ |
| Light mode — `[data-theme="light"]` overrides present for card, inputs, SSO, blobs | ✅ |

---

### Page 2.2 — Login (`/login`)

**Status:** ✅ Pass

**Completed:** 2026-05-19T21:15:00+05:30

**Reference:** `app-references/Login.html`
**Target:** `apps/web/src/pages/login.astro` (new file)

#### What was built

New standalone `/login` visual page. The existing `/auth/login.astro` is preserved as the pure WorkOS redirect entry point. The visual page lives at `/login` and links to `/auth/login` for all auth actions.

**Key design decisions:**
- Workspace chip reads `mnema-last-workspace` from localStorage — shown when present, hidden when absent
- Mode toggle (magic link vs password) is pure client-side JS — all paths redirect to `/auth/login` on submit
- Password field hidden by default (`display:none`), shown when Password tab active
- Button label changes dynamically: "Send sign-in link" (magic link) / "Sign in" (password)
- 5th SSO button spans full 2-column grid via `grid-column: 1 / -1` — "Continue with SSO" + "SAML" badge
- `signup.astro`'s "Sign in" links updated from `/auth/login` → `/login`

#### Verified states

| State | Status |
|-------|--------|
| Magic link mode (default) — email field only, "Send sign-in link →" | ✅ |
| Password mode — password field + "Forgot?" appear, button → "Sign in →" | ✅ |
| Email validation — button disabled until valid format | ✅ |
| Magic link submit — spinner (1.2s) → green "✓ Check your inbox" → redirect | ✅ |
| Password submit — spinner (1.1s) → green "✓ Welcome back" → redirect | ✅ |
| Workspace chip absent — hidden (no localStorage entry) | ✅ |
| Workspace chip present — shows gradient avatar + domain + "Switch" link | ✅ |
| "Switch" click — dismisses chip | ✅ |
| Wide SSO button — "Continue with SSO" + "SAML" badge spanning full width | ✅ |
| All SSO buttons → `/auth/login` | ✅ |
| Topbar — "New to Mnema? Create an account →" → `/signup` | ✅ |
| Card footer — "Don't have an account? Create one" → `/signup` | ✅ |

---

### Page 2.3 — CreateWorkspace wizard (`/onboarding/workspace`)

**Status:** ✅ Pass

**Completed:** 2026-05-19T22:30:00+05:30

**Reference:** `app-references/CreateWorkspace.html`
**Target:** `apps/web/src/pages/onboarding/workspace.astro`

#### What was rebuilt

Complete rewrite of `workspace.astro` as a standalone 4-step wizard page (no BaseLayout) to match the reference pixel-for-pixel. All backend wiring preserved: auth check, workspace-exists check, `POST /api/auth/create-workspace` call from Step 1.

**Key design decisions:**
- CSS namespaced with `cw-` prefix throughout
- Amber accent `--accent-rgb: 255,179,112` (global app accent, no override)
- 4-blob fluid background only (no stars, no grid, no scan line)
- Topbar shows signed-in user email + initial avatar + "Sign out" link
- Step 1 "Continue" button calls `POST /api/auth/create-workspace` with the workspace name; on error shows inline message; on success advances to step 2
- Step 1 "Skip for now" advances without creating (for dev/preview purposes)
- Steps 2–4 are visual/navigational only
- All dynamic values (email, initial, suggested name, slug) injected server-side from `auth.email`
- Step indicator pill: active step has amber `--accent` number, done steps have green `--status-sync` number
- Icon picker: 6 gradient swatches + upload button; first swatch auto-selected
- Slug sync: name input drives slug input + preview URL + MCP endpoint + done title in real-time
- Step 4 "Enter workspace" → `/app`

#### Verified states

| Element | Status |
|---------|--------|
| Topbar — brand + email + avatar initial + "Sign out" | ✅ |
| 4-blob animated fluid background (amber, blue, violet, coral) | ✅ |
| Step indicator pill — 4 steps + separators | ✅ |
| Step indicator — active step shows amber number | ✅ |
| Step indicator — done steps show green number | ✅ |
| Card glassmorphism — `rgba(6,7,10,0.72)` + `blur(24px) saturate(140%)` + gradient border | ✅ |
| Step 1 — eyebrow, h1, sub, name field, URL field with prefix+suffix, icon picker, visibility options, preview panel | ✅ |
| Step 1 — slug auto-derived from name, preview URL updates live | ✅ |
| Step 1 — icon picker selection updates preview icon | ✅ |
| Step 1 — privacy toggle (Private / Org-wide) | ✅ |
| Step 2 — invite rows (email icon, input, role dropdown, remove), "Add another", "Paste emails", role legend, avatar-stack preview | ✅ |
| Step 3 — connect card (Claude logo, PENDING tag, MCP URL + copy, 3-step list with done/pending states, test connection + npx hint), 4 client chips | ✅ |
| Step 4 — gradient μ glyph, "{slug} is live", 3 next-action cards, "Enter workspace" → /app | ✅ |
| Hint strip — "Press Enter to continue · Step N of 4" (hidden on step 4) | ✅ |
| Back/forward navigation between all steps | ✅ |

---

## Chunk 2 — Summary

**Status:** ✅ Complete

**Pages:** Signup (`/signup`), Login (`/login`), CreateWorkspace (`/onboarding/workspace`)

**Next:** Chunk 3 — Core app pages
