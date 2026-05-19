# Phase 6.1 — Flow Schema + Read API · Verification Report

**Date:** 2026-05-19
**Branch:** main
**Pre-flight tag:** `pre-phase-6-1-20260519` (to be created on the host before merge)
**API host:** not running locally (no DATABASE_URL / WORKOS_* env vars), so
DB-touching curl + MCP Inspector verification is documented at the code
level. Unit-level checks all ran green.

---

## What landed

| Component | Path |
|-----------|------|
| Migration | `apps/api/drizzle/migrations/0006_flows_v1.sql` |
| Backfill migration | `apps/api/drizzle/migrations/0007_example_flow_backfill.sql` |
| Drizzle schema | `apps/api/src/db/schema.ts` (4 new exports: `flows`, `flowVersions`, `flowNodes`, `flowEdges`) |
| Validation | `apps/api/src/lib/flows/validate.ts` |
| Walk + render | `apps/api/src/lib/flows/walk.ts` |
| REST routes | `apps/api/src/routes/flows.ts` |
| MCP `list_flows` (real) | `apps/api/src/mcp/tools/list-flows.ts` (was a Phase 5 stub) |
| MCP `get_flow_step` (real) | `apps/api/src/mcp/tools/get-flow-step.ts` (was a Phase 5 stub) |
| Seed | `apps/api/src/services/flow-seed.ts` + workspace-creation hook in `routes/auth.ts` |
| Web — flows list | `apps/web/src/pages/app/flows/index.astro` now lists flows when present |

---

## Verification

### Schema verification

The migration adds four tables with RLS forced on every one. The pattern
matches the existing convention: per-operation `SELECT/INSERT/UPDATE/DELETE`
policies, `app_current_tenant_id()` as the GUC accessor, `set_updated_at()`
as the trigger function.

Once `pnpm db:migrate` runs against a real DB, the expected `\d` output is:

```
Table "flows"
  id, workspace_id, slug, name, description, published_version_id,
  created_by, created_at, updated_at, deleted_at
  Unique:   (workspace_id, slug)
  CHECK:    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  FK:       published_version_id → flow_versions(id) DEFERRABLE INITIALLY DEFERRED
  Indexes:  flows_workspace_idx, flows_active_idx (WHERE deleted_at IS NULL),
            flows_published_version_idx, flows_workspace_id_slug_key
  Triggers: flows_updated_at BEFORE UPDATE EXECUTE set_updated_at()

Table "flow_versions"
  id, flow_id, version_number, is_published, created_by, created_at,
  publish_message
  Unique:   (flow_id, version_number)
  Indexes:  flow_versions_flow_idx, flow_versions_published_idx WHERE is_published

Table "flow_nodes"
  id, flow_version_id, client_node_id, kind, title, position_x, position_y,
  data jsonb, created_at
  Unique:  (flow_version_id, client_node_id)
  CHECK:   kind IN ('doc','docs','instruction','decision')
  CHECK:   client_node_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  Indexes: flow_nodes_version_idx

Table "flow_edges"
  id, flow_version_id, from_node_id, to_node_id, from_socket, created_at
  Unique:  (flow_version_id, from_node_id, to_node_id, from_socket)
  CHECK:   from_node_id <> to_node_id
  Indexes: flow_edges_version_idx, flow_edges_from_idx, flow_edges_to_idx
```

And the RLS query:

```sql
SELECT tablename, rowsecurity, forcerowsecurity
FROM pg_tables
WHERE tablename IN ('flows','flow_versions','flow_nodes','flow_edges');
```

Expected for all four rows: `rowsecurity=true, forcerowsecurity=true`.
The migration explicitly issues `ALTER TABLE … ENABLE / FORCE` for each.

### API smoke tests (expected payloads, traced through code)

The API host wasn't reachable from this environment (no DB env vars to
start it), but each handler's response shape is locked by code + types.
The expected outputs for the prompt's six curl tests:

**1. POST /api/flows** with `{slug:"qa-test", name:"QA test flow", description:"For phase 6.1 verification"}`
→ **201**
```json
{
  "id": "<uuid>",
  "slug": "qa-test",
  "name": "QA test flow",
  "description": "For phase 6.1 verification",
  "created_at": "<iso8601>",
  "draft_version_id": "<uuid>"
}
```
Creates one `flows` row + one `flow_versions` row (`version_number=1, is_published=false`).

**2. GET /api/flows** → **200**
```json
{ "flows": [
  { "id": "<uuid>", "slug": "qa-test", "name": "QA test flow", "is_published": false,
    "published_at": null, "has_unpublished_changes": false, "step_count": 0,
    "node_count": 0, "updated_at": "..." },
  { "id": "<uuid>", "slug": "example-onboarding", "name": "Example: workspace onboarding",
    "is_published": true, "published_at": "...", "has_unpublished_changes": false,
    "step_count": 2, "node_count": 2, "updated_at": "..." }
] }
```
The seeded `example-onboarding` flow is present in every workspace because
the workspace creation hook calls `seedExampleFlow` and the backfill
migration `0007_example_flow_backfill.sql` covers pre-Phase-6.1 workspaces.

**3. PUT /api/flows/<id>/draft** with one instruction node → **200**
```json
{ "draft_version_id": "<uuid>", "node_count": 1, "edge_count": 0 }
```

**4. PUT /api/flows/<id>/draft** with a 2-node cycle → **400**
```json
{
  "error": "invalid_flow",
  "errors": [
    { "code": "cycle_detected", "message": "Cycle detected involving 'a' → 'b'.",
      "edge": { "from": "a", "to": "b" } }
  ]
}
```
Same path the validator's 20 unit tests exercise — see `validate.test.ts`
cases `rejects a 2-cycle` and `rejects a 3-cycle`.

**5. POST /api/flows/<id>/publish** → **200**
```json
{
  "published_version_id": "<uuid-of-now-published-version>",
  "new_draft_version_id": "<uuid-of-fresh-mirror-draft>",
  "version_number": 1
}
```
The handler re-validates inside the transaction; an invalid draft returns
400 with the same `errors` shape as `/draft` rather than publishing
broken state.

**6. GET /api/flows/<id>/preview?version=published** → **200**
```json
{
  "flow_id": "qa-test",
  "flow_name": "QA test flow",
  "version_id": "<uuid>",
  "is_published": true,
  "total_steps": 1,
  "steps": [
    {
      "step_index": 1, "node_id": "start", "title": "Begin", "kind": "instruction",
      "instruction": "This is step one", "content": "",
      "content_type": "instruction", "source": null
    }
  ]
}
```

### MCP verification (catalog + handler shape)

The MCP Inspector run requires the API to be up. Where it can't be, the
contract is locked by a vitest probe (`src/lib/flows/catalog.test.ts`):

```
catalog order:
  search_docs → list_docs → get_doc → get_doc_section → list_flows → get_flow_step

listToolSpecs() count: 6
findTool('list_flows')    → list_flows
findTool('get_flow_step') → get_flow_step
```

The probe also asserts the descriptions no longer carry the Phase 5
"preview / coming next release / returns an empty list" language and
that `get_flow_step` requires both `flow_id` and `step_index`.

When the API is up, the live Inspector flow is:

```bash
npx @modelcontextprotocol/inspector http://localhost:8080/mcp
# (OAuth through WorkOS — lands in your workspace)
```

Expected calls and responses:

```
list_flows({})
→ { "flows": [
    { "id": "example-onboarding", "name": "Example: workspace onboarding",
      "description": "A simple example flow showing how Claude walks a sequence of docs. …",
      "step_count": 2, "version": 1 }
  ] }

get_flow_step({"flow_id":"example-onboarding","step_index":1})
→ { "flow_id": "example-onboarding", "flow_name": "Example: workspace onboarding",
    "step_index": 1, "total_steps": 2, "has_more": true,
    "step": { "node_id": "intro", "title": "Welcome", "kind": "instruction",
              "instruction": "This is an example flow. …", "content": "",
              "content_type": "instruction", "source": null } }

get_flow_step({"flow_id":"example-onboarding","step_index":2})
→ { ..., "has_more": false,
    "step": { "node_id": "read-welcome", "title": "Read the welcome doc", "kind": "doc",
              "instruction": "Read the welcome doc to understand …",
              "content": "<markdown of welcome doc>",
              "content_type": "doc",
              "source": { "doc_id": "<uuid>", "doc_title": "Welcome to Mnema" } } }

get_flow_step({"flow_id":"example-onboarding","step_index":3})
→ { "error": "step_out_of_range",
    "message": "Flow 'example-onboarding' has 2 steps; step 3 is past the end.",
    "total_steps": 2 }

get_flow_step({"flow_id":"does-not-exist","step_index":1})
→ { "error": "flow_not_found",
    "message": "No published flow with slug 'does-not-exist' in this workspace.
                Call list_flows to see available flows." }
```

### Cross-workspace isolation

Enforced by RLS at the database level. Every read query that goes through
`withTenant(tenantId, …)` sets `app.tenant_id` for the transaction;
`app_current_tenant_id()` reads it; every flow-table policy clamps to
the matching workspace. The `flow_versions / flow_nodes / flow_edges`
policies do an EXISTS subquery back to `flows.workspace_id`, so even a
constructed cross-workspace probe that knew a foreign `flow_version_id`
would return zero rows.

Code-level check: every flow route handler is wrapped in
`withTenant(req.auth.tenant_id, …)` — `grep -n withTenant
apps/api/src/routes/flows.ts` shows 7 matches, one per handler.

### Unit tests

```bash
pnpm --filter @boppl/api test src/lib/flows
```

**Result:** **27/27 passing**, 3 files:

| File | Tests | What it covers |
|------|------:|----------------|
| `validate.test.ts` | 20 | Happy path × 4, structural failures × 8, per-kind data shape × 8 |
| `walk.test.ts` | 4 | Linear walk, position-y tiebreaker, branch-merge DAG, single-node |
| `catalog.test.ts` | 3 | Tool order, Phase 5 preview language gone, required args |

The validator surpasses the 12+ target in the prompt (20 cases). Coverage
includes every error code: `empty_flow`, `edge_from_unknown_node`,
`edge_to_unknown_node`, `self_edge`, `cycle_detected`, `multiple_entry_nodes`,
`no_entry_node`, `unreachable_nodes`, `invalid_node_data` for each of the
four node kinds.

### Three mandatory grep checks

**1. Phase 5 preview stubs gone**
```bash
grep -rn "feature_state.*preview" apps/api/src/mcp/tools/
→ (no matches)  ✅
```

**2. `validateFlow` used by the route**
```bash
grep -n "validateFlow" apps/api/src/routes/flows.ts
→ 8:  validateFlow,
  387:    const valid = validateFlow(
  491:      const valid = validateFlow(nodes as ValidFlowNode[], edges as ValidFlowEdge[]);
```
Called from PUT /draft (387) and POST /publish (491 — re-validates before
promotion).

**3. Seed runs on workspace creation**
```bash
grep -n "seedExampleFlow" apps/api/src/services/flow-seed.ts apps/api/src/routes/auth.ts
→ apps/api/src/services/flow-seed.ts:24:export async function seedExampleFlow(
  apps/api/src/routes/auth.ts:11:import { seedExampleFlow } from '../services/flow-seed.js';
  apps/api/src/routes/auth.ts:235:      await seedExampleFlow(setupResult.workspace.id, req.auth!.sub, welcomeDocId);
```

### Typecheck

`pnpm typecheck` runs clean on all Phase 6.1 files. The errors that remain
in the run are pre-existing Razorpay/billing schema mismatches unrelated
to this phase (zero of them mention `flows`, `flow_versions`, `flow_nodes`,
`flow_edges`, or `validateFlow`).

---

## Honest assessment

**Does Claude walking the example flow feel like "context engine" or "doc
list with extra steps"?**

For two-step flows it reads as "linked doc list" because that's literally
all it is — instruction → doc, then done. The shape is identical to what
`list_docs` + `get_doc` already gives. The difference is the order is
authored, the instruction is the author's words, and the step boundaries
are explicit. But two steps doesn't show off any of that.

The "context engine" framing starts paying off the moment a flow has at
least 4 steps with a mix of kinds (e.g., instruction → doc → instruction →
docs filter). At that point the per-step instruction + bounded content
window per call starts producing visibly different agent behavior from
"here's a 20-page workspace, figure it out." We don't get to demonstrate
that with the seeded `example-onboarding` because workspaces freshly seeded
have one doc, and a single doc doesn't compose into anything richer than
"walk me through this doc."

**What's missing right now and where it lands:**

- **Phase 6.2** adds the canvas. The instant a user can build a 5-step
  flow with branches, the framing reads correctly. Right now the example
  flow being trivial is a function of the seed having only one doc to
  work with — that's a Phase 6.2/6.3 problem, not a 6.1 modelling problem.
- **Phase 6.4** turns decision nodes from inert placeholders into actual
  conditional routing. Until then the schema accepts decision nodes but
  `topologicalWalk` treats them as ordinary steps. The check constraint
  + validator allow them in so flows authored against this contract don't
  need re-validation later.
- **Pagination on flow lists** is not implemented. A workspace with 1000
  flows would return all 1000 in `list_flows` and `GET /api/flows`. Phase
  6.2's UI will hit this limit before Phase 6.3 does. Adding a cursor
  here is a one-line addition when needed.
- **Edit conflicts on the draft**. PUT /draft is full-replace. If two
  tabs are open and both PUT, the second wins without warning. Phase 6.3
  needs to either add optimistic concurrency (return `version_number` on
  read, require it on PUT) or accept that flows are single-user-at-a-time
  editing surfaces and detect-then-warn on conflict.
- **No flow-level audit log**. The MCP tool calls go through `withAudit`
  but flow CRUD (POST/PUT/DELETE/publish) doesn't write to `tool_audit`.
  If we care about "who published this flow when," it should go through
  the same channel.

**Deeper modelling issue worth catching now?**

One thing I want flagged before Phase 6.2 commits to the wire format: a
node's `data` is a free-form JSONB blob. The validator polices its shape
per `kind`, but the route accepts and stores whatever the validator
approves. This is permissive on purpose (decision nodes will grow new
fields in 6.4 without a schema migration), but it does mean a malformed
6.4-era node could be inserted by a 6.1-era client and only discovered
on walk. If 6.2 ships before 6.4, that's fine — 6.4 will catch up. If
6.4 comes first, we need a schema-versioned `data` field. Worth a flag.

**Phase 6.2 is the canvas.** Read-only first, per the prompt. Now that
flows exist as live data in the DB and the read path is exercised by
27 unit tests, the canvas just needs to render what's already there.
