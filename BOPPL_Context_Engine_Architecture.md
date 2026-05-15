# BOPPL Live Context Engine — Architectural Plan

*Hosted edition. Productized from day one.*

## What this is and the call I'm making

This document supersedes the original research brief on hosting. We're shipping a productized Live Context Engine — not an internal tool — so the architecture has to support paying customers signing up, using it, and trusting us with their context. The product-build itself stays close to the research's locked decisions (Milkdown, Hocuspocus, Postgres + pgvector, WorkOS AuthKit, Gemini Flash-Lite, voyage-3-large). What changes is the infrastructure layer, redrawn around managed services in Mumbai-adjacent regions.

The headline call: **everything that matters for latency runs in or near Mumbai.** Fly.io's Bombay machines, Neon's `aws-ap-south-1`, Upstash Redis Mumbai. The frontend is global via Vercel's edge. We trade the simplicity of one VPS for the latency profile of three regional managed services — and we get the SaaS-ready posture for free.

Working name: **BOPPL Live Context Engine** (Context Engine for short). Productization implies an eventual standalone product name — flag it as an open decision; the architecture doesn't care.

---

## Stack decision table

| Layer | Chosen | What changed | One-line reason |
|---|---|---|---|
| Backend host | **Fly.io, BOM region** | Was: Hostinger KVM 4 VPS | BOM region; Railway tops out at Singapore (~80ms RTT vs ~25ms) |
| Frontend host | **Vercel** | Was: served from same VPS | Global edge cache; matches theboringpeople.in stack |
| Frontend framework | **Astro 5 + React 19 islands** | Unchanged | Marketing pages static; editor surface as a React island |
| Postgres | **Neon, ap-south-1 (Mumbai)** | Was: self-hosted Postgres on VPS | Same region as Fly BOM; branching; pgvector built-in |
| Connection pool | **Neon built-in pooler** | Was: PgBouncer container | `*.pooler.neon.tech` — one fewer thing to maintain |
| Redis | **Upstash, Mumbai** | Was: self-hosted Redis 7.4 | Serverless; same region; free tier covers year 1 |
| Reverse proxy / TLS | **Fly built-in (Anycast + LE)** | Was: Caddy 2.8 | Nothing to configure |
| Collab server | **Hocuspocus 4.0** | Topology only | Now a separate Fly *process* in the same app |
| API framework | **Fastify** | Unchanged | MCP plugin + REST + autocomplete SSE in one process |
| Editor | **Milkdown 7.18 (Crepe)** | Unchanged | mdast-canonical, round-trip lossless |
| CRDT | **Yjs 13.6 + y-prosemirror** | Unchanged | Only mature ProseMirror binding |
| AI autocomplete | **Gemini 2.5 Flash-Lite** | Unchanged | Cheapest mainstream sub-600ms TTFT |
| Embeddings | **voyage-3-large @ 1024d** | Unchanged | 200M free tokens; top retrieval per dollar |
| Auth | **WorkOS AuthKit + Connect** | Unchanged | DCR + PKCE + SSO/SCIM; B2B free tier to 1M MAU |
| MCP transport | **Streamable HTTP (2025-11-25)** | Unchanged | Anthropic-supported; SSE deprecated |
| Backup | **Neon PITR + branch snapshots** | Was: pg_dump + restic | PITR is automatic; 7-day point-in-time restore |
| Observability | **Sentry + Axiom + Grafana Cloud** | Was: Grafana Cloud + Sentry | Axiom for log shipping from Fly (no agent needed) |
| Multi-tenancy | **Postgres RLS + tx-local GUC** | Stakes raised | Productization makes this load-bearing, not hygiene |
| Billing (Phase 2) | **Stripe + WorkOS Connect for orgs** | New layer | We're selling this; usage tracking from day one |
| CI/CD | **GitHub Actions + Fly + Vercel** | New | Auto-deploy on `main`; preview deploys on PR |

---

## Topology

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       User in Bangalore (browser)                       │
└─────────────────────────────────────────────────────────────────────────┘
        │                                                       │
        │ HTTPS to context.theboringpeople.in                  │
        ▼                                                       │
┌─────────────────────────────────────┐                         │
│  Vercel (Astro + React islands)     │                         │
│  - Marketing pages (static)         │                         │
│  - /app/* editor SSR                │                         │
│  - /pricing, /privacy, /terms       │                         │
└─────────────────────────────────────┘                         │
        │                                                       │
        │ HTTPS / WSS to api.theboringpeople.in                 │
        ▼                                                       ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Fly.io app: boppl-context (primary: BOM)                              │
│  ┌────────────────────────────────┐  ┌──────────────────────────────┐  │
│  │  process: api (Fastify)        │  │  process: collab (Hocuspocus)│  │
│  │  - POST /mcp                   │  │  - WSS /collab/<doc_id>      │  │
│  │  - POST /api/complete (SSE)    │  │  - Yjs sync + presence       │  │
│  │  - REST /api/*                 │  │  - onStoreDocument debounce  │  │
│  │  - BullMQ worker (embeddings)  │  │                              │  │
│  └────────────────────────────────┘  └──────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ Neon Postgres    │   │ Upstash Redis    │   │ WorkOS AuthKit   │
│ aws-ap-south-1   │   │ Mumbai           │   │ auth.theboring…  │
│ - pgvector       │   │ - Rate limits    │   │ - OAuth 2.1 + DCR│
│ - tsvector       │   │ - Session store  │   │ - JWT issuer     │
│ - RLS FORCE      │   │ - BullMQ queue   │   │ - JWKS endpoint  │
│ - branching      │   │ - Tool cache     │   └──────────────────┘
└──────────────────┘   └──────────────────┘

External APIs called from Fly:
  - Gemini API (autocomplete completions)
  - Voyage API (embeddings on edit)

External callers hitting Fly:
  - Claude.ai → POST https://api.theboringpeople.in/mcp (OAuth-protected)
  - Browser → WSS https://api.theboringpeople.in/collab (JWT in token)
```

---

## Critical request paths

I'll walk the same three paths the research called out, updated for the distributed topology. Per-step behavior is unchanged — only the network hops shift.

**Path 1 — MCP read from claude.ai.** Claude.ai opens `POST https://api.theboringpeople.in/mcp` with `Authorization: Bearer <JWT>` and `MCP-Protocol-Version: 2025-11-25`. Fly Anycast routes to the nearest BOM machine. Fastify hits the `mcp` plugin, verifies JWT against cached WorkOS JWKS (1-hour TTL), extracts `tenant_id` from the `org_id` claim, and validates `aud == https://api.theboringpeople.in/mcp`. It checks a Postgres connection out of Neon's pooled endpoint, opens a transaction, calls `SET LOCAL app.tenant_id = $1`, and dispatches to the named tool. `get_doc` reads `docs.markdown` directly. `search_docs` runs the RRF CTE over `tsvector` + pgvector. Redis is checked first with key `t:{tenant_id}:tool:{tool_name}:{sha256(args)}` and a 5-minute TTL. **p95 target: ≤200ms** — achievable because Fly BOM, Neon ap-south-1, and Upstash Mumbai all live within the AWS Mumbai availability zone footprint, roughly 5–10ms apart.

**Path 2 — Editor write.** Browser running Milkdown + `@milkdown/plugin-collab` opens `wss://api.theboringpeople.in/collab/<doc_id>` with the JWT in the connection token. Fly's edge upgrades the connection to the `collab` process running Hocuspocus. `onAuthenticate` verifies the JWT and checks `doc_acl` for write permission. Edits propagate as Yjs binary updates to all connected peers and the in-memory `Y.Doc` on the server. After 3s of edit-inactivity (`debounce: 3000`, `maxDebounce: 15000`), `onStoreDocument` runs: `Y.encodeStateAsUpdate(doc)` produces a Uint8Array; `MilkdownTransformer.fromYDoc()` produces the canonical markdown; both columns plus `sha256(markdown)` and `updated_at` are written to Neon in one transaction. If `content_hash` changed, a BullMQ job (queued in Upstash) re-chunks and re-embeds the doc via Voyage. The BullMQ worker runs inside the `api` process.

**Path 3 — Autocomplete.** User types in the editor; the ghost-text ProseMirror plugin debounces 350ms, gated on cursor-at-end-of-word or end-of-line. On fire, it `AbortController.abort()`s any in-flight request and POSTs `/api/complete` with ~500 tokens of prefix + ~100 tokens of suffix + a 150-token cached system prompt. Fastify reads `tenant_id` from JWT, hits the Upstash sliding-window rate-limit (60/min/user, 1000/day/user, $5/day/tenant), and calls `streamText({model: 'gemini-2.5-flash-lite', maxTokens: 60, stop: ['\n\n']})` via Vercel AI SDK 5. Provider chunks stream back over SSE; the client coalesces frames at 33ms via `requestAnimationFrame`. Tab inserts; Escape dismisses; any keystroke during the stream aborts both the browser fetch and — via `req.signal` propagation — the upstream Gemini call, so cancelled completions don't bill.

---

## Multi-tenancy as a product requirement

The "productize from day one" answer changes the stakes. We're not just preventing leaks between BOPPL workspaces — we're protecting paying customers from each other *and from us*. The defense-in-depth stack from the research stays, but I'm adding explicit invariants tested in CI:

1. **Every tenant-scoped table has RLS FORCE-enabled.** No exceptions.
2. **`SET LOCAL app.tenant_id` — transaction-local — is non-negotiable.** CI fails any PR that uses session-local instead.
3. **Every Redis key carries the `t:{tenant_id}:` prefix** and a tenant-scoped epoch counter that invalidates on any write.
4. **Every workspace gets a synthetic canary doc on signup** containing a unique secret string. A search-log scanner alerts if that string ever appears in another tenant's query results.
5. **`tool_audit` logs every MCP call** with tenant, tool, args summary, and result row count. Weekly anomaly job flags any cross-tenant pattern.
6. **JWT `aud` claim is verified** against `https://api.theboringpeople.in/mcp` on every request. Tokens minted for other resources are rejected even with valid signatures.
7. **The CI suite includes a "wrong tenant" test** that runs every named query under a non-superuser role with a deliberately wrong `app.tenant_id` and asserts zero rows returned. This test runs on every PR and blocks merge.

---

## Network topology and regions

| Service | Region | Why this region |
|---|---|---|
| Fly.io app `boppl-context` | `bom` (Bombay) | Primary; team is in Bangalore |
| Fly.io secondary (Phase 3) | `sin` (Singapore) | Failover when we have customers outside India |
| Neon Postgres | `aws-ap-south-1` (Mumbai) | Same AWS region peering with Fly BOM |
| Upstash Redis | Mumbai | Same region |
| Vercel | Global edge | Frontend served from nearest PoP |
| WorkOS AuthKit | us-east (hosted) | JWT verification is local against cached JWKS — region doesn't matter |

Latencies worth caring about:
- Fly BOM → Neon Mumbai: ~5–10ms typical
- Fly BOM → Upstash Mumbai: ~5–10ms typical
- Fly BOM → Gemini (Google Mumbai): ~30–60ms TTFT
- Browser (Bangalore) → Fly BOM: ~20–30ms
- Browser (Bangalore) → Vercel edge: ~20–40ms

---

## Environment variable inventory

Production. Secrets stored in Fly Secrets (encrypted at rest) and Vercel Environment Variables (encrypted). Non-secret config in `fly.toml` and `.env.example`.

**Backend (Fly app `boppl-context`):**

```bash
# Database
DATABASE_URL                # Neon pooled: postgresql://...@ep-xxx-pooler.ap-south-1.aws.neon.tech/main
DATABASE_DIRECT_URL         # Neon direct: postgresql://...@ep-xxx.ap-south-1.aws.neon.tech/main
DB_SSL_MODE=require

# Redis (Upstash)
REDIS_URL                   # rediss://default:xxx@mumbai-x.upstash.io:6379

# Auth
WORKOS_API_KEY
WORKOS_CLIENT_ID
WORKOS_COOKIE_PASSWORD      # min 32 chars
JWT_AUDIENCE=https://api.theboringpeople.in/mcp
JWT_ISSUER=https://auth.theboringpeople.in

# MCP
MCP_PROTOCOL_VERSION=2025-11-25
MCP_BASE_URL=https://api.theboringpeople.in
MCP_ORIGIN_ALLOWLIST=https://claude.ai

# AI providers
GEMINI_API_KEY
VOYAGE_API_KEY
AUTOCOMPLETE_MODEL=gemini-2.5-flash-lite
EMBEDDING_MODEL=voyage-3-large
AUTOCOMPLETE_DEBOUNCE_MS=350
AUTOCOMPLETE_MAX_TOKENS=60

# Rate limits
RATE_LIMIT_USER_PER_MIN=60
RATE_LIMIT_USER_PER_DAY=1000
RATE_LIMIT_TENANT_DAILY_USD=5

# Observability
SENTRY_DSN
AXIOM_TOKEN
AXIOM_DATASET=boppl-context-prod

# Server
NODE_ENV=production
API_PORT=8080
COLLAB_PORT=1234
LOG_LEVEL=info
```

**Frontend (Vercel project `boppl-context-web`):**

```bash
# Public (exposed to client)
PUBLIC_API_URL=https://api.theboringpeople.in
PUBLIC_COLLAB_URL=wss://api.theboringpeople.in/collab
PUBLIC_AUTH_URL=https://auth.theboringpeople.in
PUBLIC_SENTRY_DSN

# Server-side (Astro server endpoints + AuthKit hooks)
WORKOS_API_KEY
WORKOS_CLIENT_ID
WORKOS_COOKIE_PASSWORD
WORKOS_REDIRECT_URI=https://context.theboringpeople.in/auth/callback
```

---

## Deployment topology

**Fly app config (`fly.toml`):**

```toml
app = "boppl-context"
primary_region = "bom"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  API_PORT = "8080"
  COLLAB_PORT = "1234"

[processes]
  api    = "node dist/api/server.js"
  collab = "node dist/collab/server.js"

# API: HTTPS on 443
[[services]]
  internal_port = 8080
  protocol = "tcp"
  processes = ["api"]
  
  [services.concurrency]
    type = "requests"
    soft_limit = 200
    hard_limit = 250

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
  
  [[services.http_checks]]
    interval = "10s"
    timeout = "2s"
    path = "/health"

# Collab: WSS on 443 via a different hostname (api.theboringpeople.in/collab routes to the same app's collab process via path-based routing in Fastify, OR a separate Fly service on a subdomain — choose path-based for simplicity)
[[services]]
  internal_port = 1234
  protocol = "tcp"
  processes = ["collab"]
  
  [[services.ports]]
    port = 8443
    handlers = ["tls"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "2gb"
  processes = ["api"]

[[vm]]
  size = "shared-cpu-1x"
  memory = "1gb"
  processes = ["collab"]

[deploy]
  strategy = "rolling"

[[restart]]
  policy = "on-failure"
  retries = 3
```

A note on the `/collab` routing: the simplest path is a Fastify proxy from `/collab/*` on the api process to the collab process via internal Fly DNS. That way claude.ai and the editor share one origin (`api.theboringpeople.in`), simplifying CORS and OAuth `redirect_uri` handling. The collab process never gets a public hostname.

**Vercel project config:** Astro framework preset, root `frontend/`, build `pnpm build`, output `dist/`. Two environments (preview, production). Custom domain `context.theboringpeople.in` bound to production. Preview deploys get auto-generated subdomains.

**Neon project config:** One project `boppl-context-prod`. Branches:
- `main` — production, schema = git `main`
- `staging` — auto-applies migrations from git `staging`
- `dev-{username}` — ephemeral per-developer branches (created on PR, destroyed on merge)

Pooled endpoint enabled. Autoscale 0.25–1 CU. PITR retention 7 days. Allowlist Fly's outbound IPs.

**Upstash config:** One Redis database `boppl-context-prod`, Mumbai region, eviction `allkeys-lru`, max memory 256MB (free-tier ceiling — upgrade trigger at 80% sustained).

**WorkOS config:** Production environment, custom domain `auth.theboringpeople.in`. OAuth 2.1 + PKCE enabled. Dynamic Client Registration enabled (for claude.ai connector). Redirect URIs: `https://claude.ai/api/mcp/auth_callback` plus `https://context.theboringpeople.in/auth/callback` for the web app's own login. Default scope: `docs:read`. Optional scope: `docs:write` (gated, requires explicit consent step).

---

## Cost projection

**Year 1, BOPPL-only scale** (5 BOPPL users + ~10 early external customers = ~50 active users, 5,000 docs, 400 MCP calls/min peak, 30K autocompletes/month):

| Line item | Service / tier | Monthly USD |
|---|---|---|
| Fly.io (api 2GB + collab 1GB, BOM) | Pay-as-you-go | ~$11 |
| Neon Postgres | Free tier (3 GB, 300 compute hours) | $0 |
| Upstash Redis | Free tier (10K commands/day) | $0 |
| Vercel | Hobby | $0 |
| WorkOS AuthKit | Free <1M MAU | $0 |
| Sentry | Developer free | $0 |
| Axiom | 0.5 TB free | $0 |
| Grafana Cloud | Free tier | $0 |
| Gemini 2.5 Flash-Lite | 30K req × 615 tokens × $0.10/$0.40 per MTok | ~$2.20 |
| Voyage embeddings | 5M tokens (200M free) | $0 |
| Domain + Cloudflare DNS | Amortized | $1 |
| **Total** | | **~$14–15/mo** |

**Real-customer scale** (200 active users, 50K docs, 2K MCP calls/min, 200K autocompletes/month):

| Line item | | Monthly USD |
|---|---|---|
| Fly.io (2× api scaled to 4GB + 2× collab 2GB) | | ~$70 |
| Neon Postgres | Launch tier (10 GB, autoscale 1-4 CU) | ~$25 |
| Upstash Redis | Pay-as-you-go | ~$10 |
| Vercel | Pro | $20 |
| WorkOS AuthKit | Still free | $0 |
| Gemini autocomplete | | ~$15 |
| Voyage embeddings | After 200M free | ~$8 |
| Sentry | Team | $26 |
| Axiom | Pro | $25 |
| **Total** | | **~$200/mo** |

At 200 users, that's $1/user/month in infrastructure cost. If you price at $15–25/seat, gross margin sits north of 90% before sales/support. The unit economics work.

---

## Build sequence

**Week 1 — Foundation (MVP-track).** Provision: Fly app, Neon project, Upstash, Vercel project, WorkOS environment, three domains (`context.`, `api.`, `auth.theboringpeople.in`). Apply the full Postgres schema from research §4 with RLS policies. Stand up Fastify with `/health`, basic Astro shell on Vercel. Scaffold Milkdown Crepe editor with slash menu, Mermaid, KaTeX, code blocks — no collab yet. Save markdown to Neon on blur. **Goal:** a logged-in BOPPL user writes a markdown doc, refreshes, sees it. No collab. No MCP. No autocomplete.

**Week 2 — Collab + MCP read path (MVP).** Add Hocuspocus 4.0 as the `collab` Fly process. Configure `debounce: 3000, maxDebounce: 15000`. Add `@milkdown/plugin-collab` to the client. Implement four read-only MCP tools (`list_docs`, `get_doc`, `search_docs` in keyword-only mode, `get_doc_section`). Verify Streamable HTTP transport against the claude.ai connector inspector. Add the RLS-setting middleware and the "wrong tenant" CI test. Round-trip test harness in CI.

**Week 4 — Search + autocomplete (MVP-complete, launch candidate).** Add embeddings table; voyage-3-large chunker as a BullMQ job triggered on `content_hash` change. Switch `search_docs` to RRF hybrid. Build the autocomplete plugin: ProseMirror `Decoration.widget`, 350ms debounce, SSE to `/api/complete`, Vercel AI SDK 5 streaming Gemini Flash-Lite, AbortController on every keystroke. Per-tenant Redis rate limits live. Tool audit log on. **This is the closed-beta launch.**

**Week 8 — Productization layer.** Public signup flow (WorkOS-hosted sign-up via AuthKit). Workspace creation flow on first login. Workspace member invitation system. Per-workspace settings UI. Marketing pages on `context.theboringpeople.in/` (landing, /pricing, /docs, /privacy, /terms). Status page. Billing scaffolding: Stripe Customer + Subscription objects created on signup, no plans active yet — just usage tracking. Comments anchored to Yjs block IDs. Doc versions UI. ParadeDB evaluation if hybrid retrieval is weak.

**Week 12 — Paid launch readiness.** `append_to_doc` behind `docs:write` scope. `boppl://rate-limit` MCP resource (so Claude can introspect quota). Per-folder ACLs. Mobile read view. Stripe checkout live. Three pricing tiers plumbed end to end. First paying customer.

**Explicit MVP cut:** Week 4 ships closed beta to BOPPL + selected friendly accounts. Public productization starts Week 8 and goes paid Week 12. Comments, versions UI, write-back tools, and pricing tiers are all post-MVP.

---

## What I'm explicitly punting

Listed so we don't trip into them:

- SSO/SAML on WorkOS (turns on via dashboard when an enterprise lead asks)
- SCIM provisioning (same trigger)
- Git-style doc branching (interesting; not Phase 1)
- AI summaries on save
- Doc-to-slide-deck export
- Mobile editor (read-only is in scope; full editing is Phase 3)
- White-label
- Multi-region failover (Phase 3, when customers exist outside India)
- Self-hosted enterprise tier (Phase 4)

---

## Risk register

Carried from research, hosting risks updated:

1. **Editor-to-markdown serialization edge cases.** Unchanged. CI fuzz-tests every block type with `parse(serialize(parse(md))) === parse(md)` on a 50-doc corpus. Pin Milkdown at 7.18.x; quarterly upgrades with full re-run.

2. **Yjs state divergence and recovery.** Mostly unchanged. New angle: Fly machine restarts during rolling deploy. Mitigation: SIGTERM handler calls `Server.destroy()` synchronously, `min_machines_running = 1`, `doc_versions` snapshots every 50 store events as recovery anchor.

3. **claude.ai MCP connector spec changes.** Unchanged. Pin `MCP-Protocol-Version: 2025-11-25`, transport behind a thin adapter, RSS subscribe to spec page.

4. **Cost blowup from autocomplete.** Unchanged. Hard Upstash rate limits, AbortController on every keystroke, provider behind feature flag, Sentry alert on >$1/day/tenant.

5. **Multi-tenant data leak.** Stakes raised by productization. RLS FORCE, `SET LOCAL`, tenant-prefixed Redis keys, canary docs, `tool_audit` anomaly report. CI "wrong tenant" test on every PR.

6. **Neon free-tier compute-hour ceiling.** 300 hours/month sounds generous but autoscale burns it under load. Mitigation: weekly compute-hour monitor; pre-emptive Launch-tier upgrade at 80% consumption; staging branch capped at 0.25 CU.

7. **Fly BOM region capacity.** BOM is smaller than US-East and occasionally constrained. Mitigation: design for graceful degradation to `sin` (Singapore); quarterly chaos drill that fails over.

8. **Vendor sprawl operational burden.** Five vendors (Fly + Neon + Upstash + Vercel + WorkOS) vs one VPS. Mitigation: one Notion runbook page per vendor with login, on-call escalation, and "what breaks if this goes down" notes. Same login email across all five; 1Password for secrets.

---

## Open decisions

I'm flagging these so they don't get decided by accident:

1. **Product name.** "BOPPL Live Context Engine" is a working name. For productization, a punchier consumer-facing name matters. Think Acolyte / QuickQuote level of clarity.
2. **Pricing model.** Per-seat vs per-workspace vs usage-based. I'd lean per-seat ($15 pro / $25 team / enterprise custom) based on Notion/Linear precedent, but this is your business call.
3. **Free-tier limits.** What's the free tier permitted to do, and where does it hit the wall hard enough to convert? Suggest: 1 workspace, 3 users, 100 docs, 500 MCP calls/month, no autocomplete.
4. **Public marketing positioning.** Is the product "the live context engine for AI workflows" or "Notion for AI instructions" or something else? Affects landing page copy, not architecture.

---

## What's next

Once you sign off on this plan, the next deliverables are:

1. **The design system document** — shipped alongside this one. Notion + Obsidian + macOS app discipline, dark-first.
2. **Claude Code prompt sequence (master outline)** — the ordered list of surgical prompts that build this, what each one produces, dependencies between them.
3. **First Claude Code prompt — Week 1 Foundation** — provisioning + schema + auth + minimal editor + minimal Fastify. Production-ready, copy-paste-into-Claude-Code ready.

Subsequent prompts ship one at a time, same one-section-at-a-time pattern as the theboringpeople.in build.
