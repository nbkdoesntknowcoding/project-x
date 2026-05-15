# Claude Code Prompt Sequence — Master Outline

*BOPPL Live Context Engine. Local-first build, deployment gated.*

---

## The local-only gate

Read this first. It governs everything below.

**The entire build runs locally until you explicitly say "deploy now" (or equivalent direct command).** No prompt in Phases 0–5 will provision a Fly app, a Neon database, an Upstash instance, a Vercel project, a WorkOS production environment, a Stripe account, or a Cloudflare DNS record. None of them will configure a custom domain. None of them will push secrets to a cloud service.

Until that command lands, we operate exclusively on:
- `localhost:5173` — Astro dev server (web)
- `localhost:8080` — Fastify (api)
- `localhost:1234` — Hocuspocus (collab)
- `localhost:5432` — Postgres 16 + pgvector (Docker)
- `localhost:6379` — Redis 7 (Docker)
- WorkOS sandbox/dev environment for auth (free; no domains needed)

Deployment is its own phase (Phase D). The prompts for it exist in this outline, but they are explicitly tagged **DO NOT EXECUTE** until you issue the deploy command in your own words.

Every individual Claude Code prompt carries this rule in its header. If a prompt ever tries to deploy, that's a bug — kill the session and report back.

---

## How the prompt sequence works

Each prompt:
- Builds **one testable thing**. You verify it works before sending the next prompt.
- Carries the **local-only gate** at the top, restated.
- Lists exact package versions, file paths, and concrete code patterns.
- Ends with a **verification checklist** — you run the listed commands, confirm each passes, only then move on.
- Includes a **"Do NOT" list** spelling out anti-patterns and out-of-scope work for that prompt.

You paste each prompt directly into Claude Code, let it run, verify, then come back here for the next one. Same surgical pattern as the theboringpeople.in build.

If Claude Code wants to do more than the prompt says — even something that "seems obviously useful" — that's the signal to stop and re-scope, not to let it run.

---

## Phase 0 — Local Dev Foundation

Three prompts to get a working local dev environment with auth and the editor shell. End state: a logged-in user can write markdown in the editor, save on blur, refresh, see it again. No collab, no MCP, no autocomplete yet.

| Prompt | Builds | Test it by |
|---|---|---|
| **0.1 — Repository Foundation** | pnpm monorepo (`apps/api`, `apps/web`, `packages/shared`), TypeScript strict, ESLint + Prettier + Husky, Docker Compose (Postgres 16 + pgvector + Redis 7), Drizzle ORM, full schema with RLS, Fastify with `/health`, Astro shell | `pnpm install && docker compose up -d && pnpm db:migrate && pnpm dev` → `/health` returns 200, Astro renders, Postgres has all tables with RLS enabled |
| **0.2 — Authentication Layer** | WorkOS AuthKit dev environment, sign-in flow at `/auth/login`, session cookies, JWT issuance with `org_id` claim, workspace bootstrap on first login (creates workspace + makes user owner), auth-protected `/app` route | Click "Sign in", complete WorkOS hosted login, land on `/app` with a workspace auto-created, JWT cookie set with correct `tenant_id` claim |
| **0.3 — Editor Shell** | Milkdown 7.18 Crepe editor mounted in `/app/d/[doc_id]`, slash menu, KaTeX, Mermaid, code blocks with Shiki, title-as-inline-editable, doc save to Postgres on blur via REST `POST /api/docs/:id`, RLS-enforced read on load | Create new doc, type content, blur, refresh page, doc reappears with all formatting intact; round-trip a markdown file through the editor and verify byte-identical output |

---

## Phase 1 — Collab + Persistence

Three prompts to add real-time collaboration without breaking markdown fidelity.

| Prompt | Builds | Test it by |
|---|---|---|
| **1.1 — Hocuspocus + Yjs Integration** | Hocuspocus 4.0 as a separate Node process (`apps/api/src/collab/server.ts`), runs on `localhost:1234`, JWT auth on connection, `@milkdown/plugin-collab` on the client, y-prosemirror binding, multi-cursor presence | Open same doc in two browser windows, edit in one, see the change appear in the other within 200ms; cursors show user name chips |
| **1.2 — Debounced Markdown Persistence** | `onStoreDocument` extension with `debounce: 3000, maxDebounce: 15000`, `MilkdownTransformer.fromYDoc()` for canonical serialization, single transaction writing `yjs_state` + `markdown` + `content_hash` + `updated_at`, SIGTERM handler that flushes before shutdown | Edit a doc, stop typing, watch the network tab — single write fires at 3s mark; kill the Hocuspocus process mid-edit, restart it, doc state recovers exactly |
| **1.3 — Round-Trip CI Harness** | Test corpus of 50 representative markdown docs (`tests/fixtures/round-trip/`), test that asserts `parse(serialize(parse(md))) === parse(md)` for every fixture, GitHub Actions workflow that runs on every PR | `pnpm test:round-trip` passes; deliberately corrupt a Milkdown transformer to verify the test catches it |

---

## Phase 2 — MCP Server

Four prompts to expose docs to claude.ai as an MCP connector. Read-only. This is the moment the product becomes useful — claude.ai can actually pull our context.

| Prompt | Builds | Test it by |
|---|---|---|
| **2.1 — MCP Plugin + Streamable HTTP Transport** | Fastify MCP plugin at `POST /mcp`, Streamable HTTP transport (spec 2025-11-25), `initialize` handshake, OAuth-protected resource metadata at `/.well-known/oauth-protected-resource`, 401 with correct `WWW-Authenticate` header, `Origin` allowlist validation | Hit `POST /mcp` with no auth → 401 with `WWW-Authenticate: Bearer resource_metadata=…`; hit `/.well-known/oauth-protected-resource` → JSON with `authorization_servers` populated |
| **2.2 — JWT Verification + Tenant Resolution** | JWT verification middleware using cached JWKS, `aud` claim check against `localhost:8080/mcp` (dev) or prod equivalent, transaction wrapper that calls `SET LOCAL app.tenant_id`, "wrong tenant" CI test running every named query under a deliberately wrong tenant ID and asserting zero rows | CI test passes; manually mint a token with wrong `aud` → API returns 401; correct token + tenant A query → cannot read tenant B docs |
| **2.3 — Read Tools: list_docs, get_doc, get_doc_section** | Three MCP tool handlers, exact tool descriptions from research §5, JSON schema validation via zod, cursor-based pagination on `list_docs`, heading-tree section extraction on `get_doc_section` | Use `mcp-inspector` CLI to hit each tool with sample args; results match research §5 example shapes; ambiguous heading in `get_doc_section` returns multiple matches with breadcrumbs |
| **2.4 — Read Tool: search_docs (Keyword Mode)** | `search_docs` tool with `mode: "keyword"` only (semantic comes in Phase 3), `tsvector` GIN index query with `ts_rank_cd` ranking, snippet generation with `<mark>` tags, 300-char excerpts | Search for an exact string from a known doc → result returns with highlight; search for a non-existent string → empty results, no error |

---

## Phase 3 — Search + Autocomplete

Four prompts to upgrade search to hybrid and add Cursor-style ghost-text autocomplete.

| Prompt | Builds | Test it by |
|---|---|---|
| **3.1 — Embeddings + Voyage Chunker** | BullMQ worker (`apps/api/src/workers/embed.ts`), voyage-3-large chunker (~500 tokens with 50-token overlap, heading-aware splits), triggered on `content_hash` change, idempotent re-embedding, embeddings written to `embeddings` table with pgvector HNSW index | Edit a doc, watch the worker queue, embeddings appear with correct `chunk_index` and `heading_path`; edit same doc again with no content change → no re-embedding |
| **3.2 — Hybrid Search via RRF** | `search_docs` upgraded to support `mode: "semantic"` and `mode: "hybrid"`, RRF SQL CTE (k=60) blending tsvector + pgvector cosine, mode defaults to `"hybrid"` | Semantic query for a concept never named verbatim → returns the relevant doc; keyword query for an exact error code → returns the doc with that code; hybrid mode beats both individually on a calibration set |
| **3.3 — Autocomplete ProseMirror Plugin** | `apps/web/src/editor/plugins/autocomplete.ts`, `Decoration.widget` for ghost text styled per design system (`--editor-ghost-text`), 350ms debounce gated on end-of-word or end-of-line, Tab accept, Esc dismiss, AbortController on every keystroke | Type into editor, ghost text appears after pause; press Tab → text inserts; press Esc → dismisses; type fast → no requests fire mid-keystroke |
| **3.4 — SSE Streaming + Gemini Flash-Lite** | `/api/complete` SSE endpoint, Vercel AI SDK 5 `streamText({model: 'gemini-2.5-flash-lite'})`, request signal propagation so cancelled completions abort the upstream Gemini call, Redis sliding-window rate limit (60/min/user, 1000/day/user, $5/day/tenant), `tool_audit` log entry for every completion | Watch network tab during typing — SSE stream connects, tokens stream in, cancel mid-stream → server log shows upstream abort fired; rate limit kicks in at exactly 60 in 60s |

---

## Phase 4 — Productization

Four prompts to turn the working tool into a product. Signups, marketing pages, billing scaffolding, polish.

| Prompt | Builds | Test it by |
|---|---|---|
| **4.1 — Public Signup + Workspace Creation + Invitations** | WorkOS-hosted sign-up flow open to the public, post-signup workspace creation wizard (name, slug), member invitation system (email + role), pending invitations table, accept/decline UI | New user signs up, creates workspace, invites a teammate, teammate accepts and joins with `editor` role; non-owner cannot delete workspace |
| **4.2 — Comments + Doc Versions UI** | Comments anchored to Yjs block IDs (block IDs stable across edits), comment thread popover styled per design system, resolve/reopen flow, `doc_versions` snapshots written every 50 store events, versions UI showing diff between any two versions, "restore this version" action | Add comment to a paragraph, resolve it, hide resolved → underline disappears; edit doc 100 times, versions list shows 2 snapshots; restore from yesterday's version, doc reverts |
| **4.3 — Marketing Pages + Light Mode** | Static Astro pages at `/`, `/pricing`, `/docs`, `/privacy`, `/terms`, `/status`, all using the BOPPL marketing palette (hot coral / acid lime / deep violet), light mode toggle in app chrome (`.light` class override), persisted per-user | Hit `/` not signed in → marketing landing renders; toggle light mode in app → instant switch, all surfaces stay legible, no flash on reload |
| **4.4 — Stripe Scaffolding** | Stripe Customer + Subscription objects created on workspace signup (test mode), webhook handler for subscription events, usage metering on MCP tool calls + autocomplete requests, billing settings page (read-only for now, no plans active) | Sign up new workspace → Stripe customer created in test dashboard; make 100 MCP calls → usage record on subscription updates |

---

## Phase 5 — Paid Launch

Two prompts that turn productization into a sellable thing.

| Prompt | Builds | Test it by |
|---|---|---|
| **5.1 — Write-Back Tool + ACLs + Mobile Read View** | `append_to_doc` MCP tool gated by `docs:write` scope (requires explicit consent at OAuth time), `boppl://rate-limit` MCP resource, per-folder ACL UI, mobile read-only view of docs (no editing) | Mint a `docs:read`-only token → `append_to_doc` returns 403; mint with `docs:write` → append works, version snapshot taken; load doc on phone → read view, no editor surface |
| **5.2 — Stripe Checkout + Pricing Tiers** | Three plans: Free (1 workspace, 3 users, 100 docs, 500 MCP calls/month, no autocomplete), Pro ($15/seat/month), Team ($25/seat/month with SSO/SCIM hooks ready), Stripe Checkout integration, plan enforcement middleware on every gated endpoint, upgrade/downgrade flows | Free workspace at 99 docs → can create 1 more; at 100 → blocked with upgrade CTA; upgrade to Pro → unlock; downgrade reverts limits cleanly |

---

## Phase D — Deployment

**🛑 DO NOT EXECUTE any prompt in Phase D until the user explicitly issues a deployment command in their own words.** These prompts exist so the deployment path is known and reviewable in advance — not so they can run.

| Prompt | Builds | When |
|---|---|---|
| **D.1 — Production Account Provisioning** | Fly app creation in `bom`, Neon project in `aws-ap-south-1`, Upstash Redis in Mumbai, Vercel project, WorkOS production environment with custom domain `auth.theboringpeople.in`, Cloudflare DNS for `api.` and `context.theboringpeople.in`, Stripe live mode account | Only on command |
| **D.2 — Backend Deploy to Fly + Neon + Upstash** | Dockerfile for the api+collab monorepo build, `fly.toml` with `[processes]` config, secret injection from `fly secrets`, schema migration on Neon `main` branch, Upstash production database wired, smoke test against `https://api.theboringpeople.in/health` | Only on command |
| **D.3 — Frontend Deploy + Claude.ai Connector Registration** | Vercel project linked to monorepo, environment variables set, `context.theboringpeople.in` custom domain bound, Astro production build, claude.ai connector registered via Streamable HTTP transport at `https://api.theboringpeople.in/mcp`, end-to-end smoke test (claude.ai → MCP → search_docs → result returned) | Only on command |

When the time comes, the deployment phase will produce its own pre-flight checklist (database migration plan, secret rotation log, rollback procedure, observability sanity check) before any prompt executes.

---

## Working agreement with Claude Code

When you paste a prompt into Claude Code, expect this loop:

1. **Read** — Claude Code reads the prompt and any referenced files (architecture, design system, schema).
2. **Plan** — outputs the implementation plan inline. If the plan exceeds the prompt's scope (touches files not mentioned, installs packages not listed, adds features not requested), reject the plan and re-scope.
3. **Implement** — generates code and runs commands within the prompt's scope.
4. **Self-verify** — runs the verification checklist at the bottom of the prompt.
5. **Report** — confirms what was built, what was tested, what's left.

You then:
1. Re-run the verification checklist locally yourself.
2. Eyeball the diff for anything outside scope.
3. Commit if clean; revert and re-prompt if not.
4. Come back for the next prompt.

**Hard rules across every prompt:**
- One prompt = one PR-sized change. If Claude Code wants to bundle two prompts' worth of work, stop it.
- Never bypass the local-only gate. If you find yourself running `fly deploy` before Phase D, you've made a mistake.
- Never edit `.env.production`, `fly.toml` secrets, or any production config during Phases 0–5.
- Every prompt's "Do NOT" list is the contract. Violating it is grounds to revert the entire prompt's work.

---

## What you get at the end of Phase 3

After 14 prompts (Phases 0–3 complete), you have a fully functional local Live Context Engine: BOPPL team can sign in, create docs, edit collaboratively, search semantically, use AI autocomplete, and the MCP server is ready for claude.ai to consume — all on `localhost`.

At this point, the right move is to do a deployment dry-run in your head: confirm the architecture plan still fits, confirm the open business decisions (product name, pricing) are answered, confirm you're ready to spend money on production infrastructure. Then issue the deploy command. Then Phase D.

Phases 4 and 5 can happen in production or local — by then either is fine. The local-only gate exists so we don't accidentally ship a half-built product to a domain pointed at real users. Once the MVP is in production, productization work proceeds with normal staging-branch workflow.

---

## Next deliverable

**Prompt 0.1 — Repository Foundation.** Shipped alongside this outline. Paste it into Claude Code to begin. Verify the checklist before requesting Prompt 0.2.
