# Flow Feature Repair Diagnosis

**Run at:** 2026-05-20T16:00 IST

## Symptom
User reports: "API can't be reached" error when trying to open or create flows on deployed Vercel app.

---

## Diagnostic Results

### Local API
- **Process running:** ✅ YES — `tsx src/server.ts` (PID 33763)
- **/health response:** ✅ 200 `{"status":"healthy","services":{"database":true,"redis":true}}`

### Cloudflare Tunnel
- **cloudflared process running:** ✅ YES — two tunnels: port 8080 (API) and port 1234 (collab)
- **Current tunnel URL (API):** `https://lone-tutorials-officially-explanation.trycloudflare.com`
- **Tunnel reachable from public internet:** ✅ YES — 200 from public curl
- **Tunnel → localhost:8080 forwarding works:** ✅ YES

### Vercel Deployment
- **Deployment URL responds:** ✅ YES — `https://project-x-sandy-alpha.vercel.app/` returns 200
- **Vercel `PUBLIC_API_URL`:** `https://lone-tutorials-officially-explanation.trycloudflare.com`
- **Match between Vercel env and current tunnel URL: ✅ MATCH** — not the bug

### CORS
- **`CORS_ORIGINS` in API .env:** `http://localhost:5173,http://localhost:5175,http://localhost:6274`
- **`project-x-sandy-alpha.vercel.app` in allowlist: ❌ NO** — client-side API calls from
  the Vercel deployment will fail with CORS errors (SSR calls are unaffected)

### Flow API Endpoints (through tunnel)
- **GET /api/flows:** ✅ 401 (endpoint exists, auth required — correct)
- **GET /api/flows/example-onboarding:** ✅ 401 (endpoint exists, auth required — correct)
- **POST /api/flows allowed:** 400 on OPTIONS (no preflight CORS headers returned because Vercel domain not in allowlist)
- **Phase 6.3 edit routes in flows.ts:** ✅ Present (PUT /draft, POST /publish, GET /versions)

### Frontend Code
- **apps/web/src/pages/app/flows/index.astro exists:** ✅ YES (design-integration version)
- **apps/web/src/pages/app/flows/[slug].astro exists:** ❌ **MISSING — THIS IS THE PRIMARY BUG**
- **apps/web/src/components/flows/ exists:** ❌ **MISSING ENTIRELY** — all 16 component files gone
- **apps/web/src/lib/flows/cycle-detect.ts:** ❌ MISSING
- **apps/web/src/lib/relative-time.ts:** ❌ MISSING

### MCP Layer
- **POST /mcp returns 401 with WWW-Authenticate:** ✅ YES — MCP is healthy

---

## Root Cause

**The Phase 6.1/6.2/6.3 frontend work was never merged into main.**

The git graph shows two branches diverged from commit `3685f44`:
1. The **design integration branch** (268b4e6 "Phase 6.3 Chunk 3") — which rebuilt `index.astro` — **was merged into main**
2. The **Phase 6.1/6.2/6.3 flow feature branch** (5413648 → 7afe3e5 → ea95c86) — which has all the canvas components — **was never merged into main**

Result: `main` has the design-integrated list page (`index.astro`) that links to `/app/flows/:slug`, but the slug page and all 16 canvas component files are only on the orphaned branch.

When any user clicks a flow card, Astro returns 404 (no route handler for `/app/flows/:slug`), which the user experiences as "API can't be reached."

**Secondary issue:** `project-x-sandy-alpha.vercel.app` is not in `CORS_ORIGINS`, so client-side API calls (New Flow button, inline Walk button) from the deployed app would hit CORS errors even after the slug page is restored.

---

## Files Missing from HEAD (to restore from commit ea95c86)

```
apps/web/src/pages/app/flows/[slug].astro
apps/web/src/components/flows/FlowCanvas.tsx
apps/web/src/components/flows/FlowHeader.tsx
apps/web/src/components/flows/FlowsListPage.tsx
apps/web/src/components/flows/NodeInspector.tsx
apps/web/src/components/flows/WalkSimulator.tsx
apps/web/src/components/flows/AddNodePalette.tsx
apps/web/src/components/flows/DocPicker.tsx
apps/web/src/components/flows/DocSidebar.tsx
apps/web/src/components/flows/PublishModal.tsx
apps/web/src/components/flows/VersionHistoryPanel.tsx
apps/web/src/components/flows/edges/EditableEdge.tsx
apps/web/src/components/flows/nodes/DecisionNode.tsx
apps/web/src/components/flows/nodes/DocNode.tsx
apps/web/src/components/flows/nodes/DocsNode.tsx
apps/web/src/components/flows/nodes/InstructionNode.tsx
apps/web/src/components/flows/nodes/NodeShell.tsx
apps/web/src/lib/flows/cycle-detect.ts
apps/web/src/lib/relative-time.ts
```

---

## Repair Plan

**Step 2.D — Restore missing frontend files** (the root cause)
- `git checkout ea95c86 -- <each missing file>`
- This restores the Phase 6.3 versions of all flow components without touching `index.astro`

**Step 2.C — Add Vercel domain to CORS** (secondary issue)
- Add `https://project-x-sandy-alpha.vercel.app` to `CORS_ORIGINS` in `.env`
- Restart API server

**Steps to skip (already healthy):**
- 2.A — Tunnel URL in Vercel ✅ already matches
- 2.B — Tunnel dead ✅ tunnel is alive
- 2.E — API flow endpoints 404 ✅ endpoints exist
- 2.F — MCP layer broken ✅ MCP responds correctly
