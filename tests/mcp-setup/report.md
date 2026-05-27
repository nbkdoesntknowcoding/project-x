# MCP Setup Report — Cloudflare Tunnel + Vercel Integration

_Last updated: 2026-05-20_

---

## What was built

Full end-to-end path from Claude Desktop → Cloudflare Tunnel → local API → Postgres.

| Layer | Component | Status |
|-------|-----------|--------|
| Tunnel | Cloudflare Quick Tunnel (trycloudflare.com) | ✅ Live |
| API | Fastify on localhost:8080, exposed via tunnel | ✅ Running |
| MCP tools | search_docs, list_docs, get_doc, get_doc_section, list_flows, get_flow_step | ✅ All 6 verified |
| Auth | Bearer JWT signed with HMAC-SHA256, audience = tunnel URL | ✅ Verified |
| Claude Desktop | claude_desktop_config.json updated with mnema MCP entry | ✅ Done |
| Vercel deployment | project-x project, env vars set, build config added | ⏳ Deploying |

---

## Verification results

All tool calls made against:
`https://lone-tutorials-officially-explanation.trycloudflare.com/mcp`

### tools/list
```
✅ search_docs
✅ list_docs
✅ get_doc
✅ get_doc_section
✅ list_flows
✅ get_flow_step
```

### list_flows
```json
{
  "flows": [
    {
      "id": "example-onboarding",
      "name": "Example: workspace onboarding",
      "step_count": 2,
      "version": 1
    }
  ]
}
```

### get_flow_step(flow_id="example-onboarding", step_index=1)
```json
{
  "flow_id": "example-onboarding",
  "step_index": 1,
  "total_steps": 2,
  "has_more": true,
  "step": {
    "kind": "instruction",
    "title": "Welcome",
    "instruction": "This is an example onboarding flow..."
  }
}
```

### get_flow_step(flow_id="example-onboarding", step_index=2)
```json
{
  "flow_id": "example-onboarding",
  "step_index": 2,
  "total_steps": 2,
  "has_more": false,
  "step": {
    "kind": "doc",
    "title": "Read the welcome doc",
    "doc_id": "16252807-88d5-45cd-9170-563f4a4714d5"
  }
}
```

---

## Daily operations

### Starting the tunnel

**Every session, run this first:**

```bash
# Start Cloudflare quick tunnel (ephemeral URL — changes each restart)
cloudflared tunnel --url http://localhost:8080 --logfile /tmp/cf-tunnel.log &
sleep 8
TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cf-tunnel.log | head -1)
echo "Tunnel: $TUNNEL_URL"
```

### When the tunnel URL changes (each restart)

1. **Update API env vars** — edit `.claude/worktrees/peaceful-liskov-edda9c/.env`:
   ```
   MCP_BASE_URL=https://<new-tunnel-url>
   JWT_AUDIENCE_MCP=https://<new-tunnel-url>/mcp
   ```

2. **Restart the API**:
   ```bash
   kill $(pgrep -f "tsx.*server\.ts" | grep -v collab)
   cd .claude/worktrees/peaceful-liskov-edda9c/apps/api
   pnpm --filter @boppl/api dev:api &> /tmp/api.log &
   ```

3. **Issue a new MCP token** — the old token has the wrong audience. Go to
   `http://localhost:5173/app/connections/claude` and click **Connect** to
   generate a fresh token. The config snippet on that page auto-fills with
   the current `PUBLIC_MCP_URL`.

4. **Update Claude Desktop config**:
   - Open: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Replace the `Authorization` header value with the new Bearer token
   - Restart Claude Desktop

### Upgrading to a stable tunnel URL (Path A1)

To avoid the URL changing each restart:
```bash
# 1. Login to Cloudflare (opens browser)
cloudflared tunnel login

# 2. Create a named tunnel on your domain
cloudflared tunnel create mnema-api
cloudflared tunnel route dns mnema-api api.yourdomain.com

# 3. Start the named tunnel
cloudflared tunnel run --url http://localhost:8080 mnema-api
```

Then update `MCP_BASE_URL` to your stable custom domain — no token rotation needed.

---

## Files changed

| File | Change |
|------|--------|
| `apps/api/src/config/env.ts` | Added `CORS_ORIGINS` env var |
| `apps/api/src/server.ts` | CORS origins now read from `CORS_ORIGINS` env var |
| `apps/web/src/env.d.ts` | Added `PUBLIC_MCP_URL` type |
| `apps/web/src/pages/app/connections/claude.astro` | Config snippet uses `PUBLIC_MCP_URL` |
| `apps/api/src/mcp/tools/list-flows.ts` | Added to worktree; removed `deleted_at` ref |
| `apps/api/src/mcp/tools/get-flow-step.ts` | Added to worktree; removed `deleted_at` ref |
| `apps/api/src/lib/flows/walk.ts` | Copied to worktree from main branch |
| `vercel.json` | Build config for monorepo deployment |
| `.env` (all 3 worktrees) | `MCP_BASE_URL`, `JWT_AUDIENCE_MCP`, `PUBLIC_MCP_URL` updated |

---

## Vercel deployment notes

- Project: `project-x` in `nbkdoesntknowcodings-projects`
- Env vars set: `PUBLIC_API_URL`, `PUBLIC_MCP_URL`, `WORKOS_*`, `JWT_*`, `PUBLIC_SITE_URL`, `PUBLIC_COLLAB_URL`
- WorkOS redirect URI on Vercel: `https://project-x.vercel.app/auth/callback`
- **Must add** `https://project-x.vercel.app/auth/callback` to WorkOS dashboard → redirects allowlist

---

## Vercel deployment status

- Production URL: **`https://project-x-sandy-alpha.vercel.app`** — ✅ Live, app rendering correctly
- Root fix: switched to `@astrojs/vercel` adapter (was `@astrojs/node` which Vercel can't run). Root Directory set to `apps/web` in Vercel project settings.
- Vercel SSO Protection: ✅ Disabled
- **Pending**: Add `https://project-x-sandy-alpha.vercel.app/auth/callback` to WorkOS dashboard → redirects allowlist (auth flow will fail until done)
- **Pending**: Add `https://project-x-sandy-alpha.vercel.app` to `CORS_ORIGINS` Vercel env var so the web app can reach the API tunnel

---

## Known limitations

1. **Quick tunnel URL is ephemeral** — changes on every `cloudflared` restart. Tokens must be re-issued when it changes.
2. **No named Cloudflare tunnel configured** — requires Cloudflare account login (browser OAuth didn't complete during setup). See "Upgrading to stable tunnel URL" above.
3. **Collab server not tunneled** — Yjs real-time editing won't work from the Vercel deployment. Local dev is unaffected.
4. **`flow_nodes` / `flow_edges` missing from worktree DB** — applied migrations `0006` and `0007` manually. Example flow nodes were seeded directly for workspace `a67e6584-6e16-4f4a-a465-3d41f3d9e9db`.
5. **`flows.deleted_at` column doesn't exist in local DB** — `list-flows.ts` and `get-flow-step.ts` patched in the worktree to remove the `isNull(flows.deletedAt)` condition. Main branch schema has this; local DB doesn't. A migration to add the column would make the tools match the main branch.
