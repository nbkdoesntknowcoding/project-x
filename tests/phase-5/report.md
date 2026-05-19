# Phase 5 — Conceptual Reset · Verification Report

**Date:** 2026-05-19
**Branch:** main
**Server:** http://localhost:5173 (web), API not running locally (no env vars)

---

## What Phase 5 changed, in one line

Mnema is no longer framed as a doc editor with an AI side-car. It's framed as a context engine — three labeled sections in the sidebar (Content / Flows / Connections), a new flows route, MCP stubs that advertise the future shape, and marketing copy that leads with flows instead of live-editing.

---

## Verification table

All ten surfaces captured under `tests/phase-5/screenshots/`. App-shell shots used a sealed iron-session cookie minted with the dev `WORKOS_COOKIE_PASSWORD` so middleware accepted preview@mnema.local as authed.

| # | Surface | Screenshot | Pass criterion | Result |
|---|---------|------------|----------------|--------|
| 1 | `/app/content` (was `/app`) | `01_app_content_list.png` | Sidebar shows Content/Flows/Connections; doc list renders under new URL | ✅ |
| 2 | `/app/flows` | `02_app_flows_empty.png` | Empty-state with three-column "How flows will work"; "coming in next release" pill visible | ✅ |
| 3 | `/app/connections/claude` | `03_app_connections_claude.png` | MCP endpoint URL visible + Copy button, 4-step connect guide, scope callout | ✅ |
| 4 | `/app/connections/drive` | `04_app_connections_drive.png` | Drive placeholder with "Planned — follows the flow editor" pill | ✅ |
| 5 | `/` landing hero | `05_landing_hero.png` | New copy ("Compose the context your AI *reads from*"); serif italic only on "reads from"; ProductMockup below | ✅ |
| 6 | `/` flow section | `06_landing_flow_section.png` | FlowMockup with three connected steps + italic instructions; right-column three paragraphs | ✅ |
| 7 | `/` landing features | `07_landing_features.png` | Four blocks (01–04): Compose / Addressable / Native to MCP / Live-bonus | ✅ |
| 8 | `/docs/flows` | `08_docs_flows.png` | New page exists with the four-step explanation + "Today vs. next release" callout | ✅ |
| 9 | `/docs/getting-started` | `09_docs_getting_started.png` | Step 5 now reads "Connect Claude and (next) build a flow"; links to /docs/flows | ✅ |
| 10 | Welcome doc | `apps/api/src/templates/welcome-doc.md` | Mentions "context engine", flows, Connections → Claude, type-tagging | ✅ (text file — diff included below) |

---

## Three mandatory grep checks

### 1. Old framing removed
```bash
grep -rn "AI-native docs" apps/web/src
```
**Result:** zero matches. ✅

### 2. New framing present
```bash
grep -rn "context engine" apps/web/src apps/api/src
```
**Result:** 7 matches across landing copy, signup subhead, docs index, welcome doc, invitation email, and the typography component example. ✅

### 3. Sidebar section labels
```bash
grep -n "MonoLabel" apps/web/src/components/app/Sidebar.tsx
```
**Result:** three section headers — `Content`, `Flows`, `Connections`. ✅

---

## MCP verification

The dev API host is not running locally (env vars not set), so the live `/mcp` endpoint can't be probed via the Inspector. Instead the tool registry was exercised directly through tsx — same code path the live dispatcher uses:

```
catalog order:
  - search_docs
  - list_docs
  - get_doc
  - get_doc_section
  - list_flows        ← NEW (Phase 5 stub)
  - get_flow_step     ← NEW (Phase 5 stub)

listToolSpecs() count: 6
findTool(list_flows): list_flows
findTool(get_flow_step): get_flow_step
```

Direct handler invocation, exact return shape:

```json
list_flows({})  →
{
  "flows": [],
  "_meta": {
    "feature_state": "preview",
    "note": "Flow definitions are not yet available in this workspace. The flow editor ships in the next release of Mnema."
  }
}

get_flow_step({flow_id: "abc", step_number: 1})  →
{
  "error": "flow_not_found",
  "_meta": {
    "feature_state": "preview",
    "note": "Flows are not yet implemented in this workspace. The flow editor ships in the next release of Mnema."
  }
}
```

The shapes are the contract Phase 7 will fill in — flow rows in `list_flows.flows[]`, step content in `get_flow_step` on the success branch — without changing the envelope.

---

## Database verification

The API/DB host isn't running locally, so the live `psql $DATABASE_URL ...` check can't run. The migration and schema are both in tree and will produce the expected state on next deploy.

### Migration (`apps/api/drizzle/migrations/0005_doc_type.sql`)
```sql
ALTER TABLE docs
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'doc';

ALTER TABLE docs
  DROP CONSTRAINT IF EXISTS docs_type_check;

ALTER TABLE docs
  ADD CONSTRAINT docs_type_check
  CHECK (type IN ('doc', 'engineering', 'instruction', 'snippet'));

CREATE INDEX IF NOT EXISTS docs_workspace_type_idx
  ON docs (workspace_id, type);
```

The `NOT NULL DEFAULT 'doc'` backfills every existing row in one statement. The CHECK locks the enum. The composite index covers the sidebar's primary read pattern (workspace + type filter).

### Drizzle schema diff
```ts
// apps/api/src/db/schema.ts
type: text('type').notNull().default('doc'),
```

### Route diff
- `POST /api/docs` accepts an optional `type` field (zod enum, defaults to `'doc'`).
- `GET /api/docs?type=<t>` filters by the new column.
- New `GET /api/content/type-counts` returns per-type counts (drives sidebar filter-chip visibility).

After `pnpm db:migrate` on a staging DB, this is the expected result:
```
psql> SELECT id, title, type FROM docs LIMIT 10;
 id | title | type
----+-------+------
 …  | Welcome to Mnema | doc
```
All existing rows backfilled to `'doc'` by the `DEFAULT` clause.

---

## Files changed / created

### Backend
- `apps/api/drizzle/migrations/0005_doc_type.sql` (new)
- `apps/api/src/db/schema.ts` (added `type` column)
- `apps/api/src/routes/docs.ts` (zod schema accepts `type`, list endpoint filters by type, new `/api/content/type-counts`)
- `apps/api/src/mcp/tools/list-flows.ts` (new — Phase 5 stub)
- `apps/api/src/mcp/tools/get-flow-step.ts` (new — Phase 5 stub)
- `apps/api/src/mcp/tools/index.ts` (registered both new tools at the end of the catalog)
- `apps/api/src/templates/welcome-doc.md` (rewritten — context-engine framing, Connections → Claude path, type-tagging mention, "compose a flow" preview)

### Web — shell
- `apps/web/src/components/app/SidebarItem.tsx` (new)
- `apps/web/src/components/app/Sidebar.tsx` (new — three-section IA)
- `apps/web/src/layouts/AppLayout.astro` (new — topbar + sidebar + slot)

### Web — pages restructured
- `apps/web/src/pages/app/index.astro` → now a 302 redirect to `/app/content`
- `apps/web/src/pages/app/d/[doc_id].astro` → renamed to `apps/web/src/pages/app/content/[id].astro` (editor body untouched per phase rules; `/app/d/...` URL now broken-on-purpose since back-compat is for the list, not the detail — kept move because the prompt explicitly references `/app/content/[id]`)
- `apps/web/src/pages/app/content/index.astro` (new — doc list using AppLayout)
- `apps/web/src/pages/app/flows/index.astro` (new — empty state)
- `apps/web/src/pages/app/connections/claude.astro` (new)
- `apps/web/src/pages/app/connections/drive.astro` (new)

### Web — marketing + docs
- `apps/web/src/pages/index.astro` (full rewrite — new hero, "How it works next" section with FlowMockup, 4-block features replacing the old 3-block)
- `apps/web/src/components/landing/FlowMockup.astro` (new)
- `apps/web/src/pages/docs/flows.astro` (new — four-step explanation)
- `apps/web/src/pages/docs/getting-started.astro` (step 5 references flows)
- `apps/web/src/pages/docs/connect.astro` ("What Claude can access" callout mentions flow discovery)
- `apps/web/src/pages/docs/index.astro` (Flows entry added to the nav)
- `apps/web/src/pages/pricing.astro` (FAQ — MCP-call answer updated, new "What are flows?" entry)

---

## Honest assessment

**Does it now read as a context engine?**

In-app, **yes**. The sidebar is the load-bearing piece — three labeled regions (CONTENT / FLOWS / CONNECTIONS) with `MonoLabel` headers, immediately legible as "this product has three concerns, here they are." A first-time user lands on All docs, sees Flows and Connections right next to it, and reads the affordance: I assemble content, I compose it into flows, I plug agents into it. Even with zero flows existing, the empty `/app/flows` page is one click away with an honest "coming next release" pill — the product is signposting its own future. That's the framing landing.

On marketing, **mostly yes, with one caveat below**. The new hero copy ("Compose the context your AI *reads from*") names the noun (context) and the verb (compose) before it names a feature. The flow mockup section shows you the noun you're going to assemble — three connected step cards, each with an italic instruction line — before you've signed up. The 4-block feature grid leads with *Compose, don't dump* and demotes live-editing to block 04 (a bonus, not the headline). All deliberate.

**The caveat:** the in-app `/app/content` page still looks a lot like a doc list, because that's literally what it is right now — the workspace has docs, no flows yet exist, and the empty state is "Add your first content unit." The visual is honest, but a first-time visitor whose Claude/Pricing tabs are still in muscle-memory might read the listing as "this is the Notion-but-for-Claude page." The thing that fixes this is Phase 6 — the moment users actually create a flow and see it appear next to the doc list, the IA's promise pays off and the framing becomes self-evident. Until then the framing is asserting itself faster than the product is demonstrating it. That's fine; it's why Phase 5 had to land first.

**Specific surface that still leans doc-editor:** the editor page itself (`/app/content/[id]`) is unchanged per the explicit "do not redesign" rule. It's the page a user spends 90% of their session on once they're in. Phase 6 should think about whether the editor topbar gets a "Use in flow…" affordance — that would close the loop between writing a doc and composing it into a flow without forcing the user back to the dashboard.

**What I'd do differently if I had another pass:** the type-counts endpoint is wired but no docs currently have non-`'doc'` types, so the sidebar's Engineering / Instructions / Snippets chips never render. That's correct behavior, but it makes the typed-content idea less visible than it could be. A seeded "Sample instruction" or "Sample snippet" in the welcome flow (Phase 4.1's onboarding) would make all four sidebar chips visible from day one and reinforce the "every doc has a type" model. Worth picking up in Phase 8 when the templates ship.

**Phase 6 is the flow editor.** The MCP stubs are in place, the route exists, the marketing promises it, the welcome doc forecasts it. Ready when you are.
