# Phase A — OAuth 2.1 Authorization Server: Verification Report

**Date:** 2026-05-20  
**Tunnel:** `https://lone-tutorials-officially-explanation.trycloudflare.com`  
**Server:** `http://localhost:8080` → tunneled above

---

## Test Results

### Test 1 — Well-Known Endpoints ✅

| Endpoint | Status | Notes |
|----------|--------|-------|
| `GET /.well-known/oauth-authorization-server` | ✅ 200 | RFC 8414 metadata, issuer matches tunnel URL |
| `GET /.well-known/oauth-protected-resource` | ✅ 200 | RFC 9728, `resource` = tunnel `/mcp` |
| `GET /.well-known/oauth-protected-resource/mcp` | ✅ 200 | Per-resource variant, identical body |
| `GET /.well-known/jwks.json` | ✅ 200 | RSA key `kid=mnema-oauth-key-1`, `alg=RS256` |

```json
{
  "issuer": "https://lone-tutorials-officially-explanation.trycloudflare.com",
  "authorization_endpoint": ".../oauth/authorize",
  "token_endpoint": ".../oauth/token",
  "registration_endpoint": ".../oauth/register",
  "code_challenge_methods_supported": ["S256"],
  "grant_types_supported": ["authorization_code", "refresh_token"]
}
```

---

### Test 2 — Dynamic Client Registration (RFC 7591) ✅

```bash
POST /oauth/register
→ 201 { "client_id": "mnema_client_<hex>", "client_name": "...", ... }
```

- Client ID prefixed `mnema_client_`
- No client secret returned (public clients only)
- DCR works through Cloudflare tunnel

---

### Test 3 — Authorization Endpoint ✅

```
GET /oauth/authorize?response_type=code&client_id=...&code_challenge=...&code_challenge_method=S256
→ 302 Location: https://api.workos.com/user_management/authorize?...&state=<requestId>
```

- No session cookie → correctly redirects to WorkOS
- State param carries the `requestId` UUID (pending request stored in DB)
- Redirect URI points to tunnel `/oauth/callback`

---

### Test 4 — Token Endpoint ✅

```bash
POST /oauth/token (application/x-www-form-urlencoded)
  grant_type=authorization_code, code=invalid
→ 400 { "error": "invalid_grant" }
```

- Accepts `application/x-www-form-urlencoded` (RFC 6749 §4.1.3)
- PKCE verification wired (S256-only)

---

### Test 5 — Security Grep Checks ✅

| Check | Result |
|-------|--------|
| S256-only PKCE | ✅ `code_challenge_method: z.literal('S256')`, `if (method !== 'S256') return false` |
| No HS256 in OAuth code | ✅ Only RS256 — HS256 only in legacy fallback path of `require-bearer.ts` |
| `readOnlyHint: true` on all 6 tools | ✅ list-docs, search-docs, get-doc, get-doc-section, list-flows, get-flow-step |
| Audience validation | ✅ `aud` matched in `verifyOAuthAccessToken()` |

---

### Test 6 — Token Revocation (RFC 7009) ✅

```bash
POST /oauth/revoke (form-urlencoded)
  token=bogus
→ 200 (RFC 7009 mandates 200 even for unknown tokens)
```

---

### Test 7 — Backward Compatibility (Claude Desktop) ✅

Existing `mcp-remote` processes with legacy HS256 JWTs continue to work — the dual-mode `require-bearer.ts` tries RS256 first, falls back to HS256 legacy app JWT on failure. Claude Desktop connections unaffected.

---

## Issues Found & Fixed During Verification

1. **Duplicate `/.well-known/oauth-protected-resource` route** — `mcp/protected-resource.ts` was still registered alongside the new `oauth/routes/well-known.ts`. Fixed by removing the old registration from `mcp/plugin.ts`.

2. **`application/x-www-form-urlencoded` not parsed** — `@fastify/formbody` was missing. Added to `oauth/plugin.ts`.

3. **`OAUTH_PRIVATE_KEY_PATH` relative path wrong** — Path was relative to project root but server runs from `apps/api/`. Fixed in `.env`.

4. **Schema out of sync** — `subscriptions`, `webhookEvents`, `razorpayPlanIds` tables exist in DB but weren't in `schema.ts`. Added Drizzle definitions so TypeScript compiles.

5. **OAuth migration not in Drizzle journal** — Migrations 0005–0011 were applied via raw psql (not via `drizzle-kit migrate`). Applied `0011_oauth_v1.sql` directly with `psql -f`.

---

## Pending: WorkOS Dashboard Configuration

The `WORKOS_REDIRECT_URI_OAUTH` must be added as an allowed redirect URI in the WorkOS dashboard:

```
https://lone-tutorials-officially-explanation.trycloudflare.com/oauth/callback
```

Without this, the WorkOS callback step (Test 3 → WorkOS → `/oauth/callback`) will fail with a redirect URI mismatch.

---

## Pending: Full claude.ai Web Connector Flow (Test 3 end-to-end)

Once WorkOS redirect URI is registered:
1. Go to claude.ai → Settings → Connectors → Add MCP server
2. Enter: `https://lone-tutorials-officially-explanation.trycloudflare.com`
3. claude.ai should hit `/.well-known/oauth-authorization-server`, run DCR, redirect to WorkOS login
4. After login, consent screen appears → Approve → auth code → token exchange
5. MCP tools should be visible and callable
