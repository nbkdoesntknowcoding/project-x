import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { requireOAuthBearer } from '../oauth/middleware/require-bearer.js';
import { checkSubscriptionGate } from '../plugins/subscription.js';
import { mcpConfig } from './config.js';
// protectedResourceRoutes removed — well-known routes now live in oauth/routes/well-known.ts
import { McpForbiddenError } from './scope.js';
import { createMcpServer } from './server.js';
import { handleStreamableHttp } from './transport.js';
import { and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenantScopeStore } from '../db/with-tenant.js';
import { mcpTokens, users, workspaceMembers, workspaces } from '../db/schema.js';

// Meeting identity (Phase 1). Header an act-as key sets per request to name the
// participant currently asking. The server resolves it to a workspace user and
// enforces that user's access. Lower-case — Fastify normalizes header names.
const ACT_AS_EMAIL_HEADER = 'x-mnema-act-as-email';

// A guest (a meeting attendee with no matching Mnema user) must get NOTHING from
// the knowledge base. Scoping the session to this impossible project makes the RLS
// predicate app_can_see_project() false for every row (it requires project_id to
// equal this id, and nothing — not even unfiled/NULL — matches). Pure deny.
const GUEST_DENY_PROJECT = '00000000-0000-0000-0000-000000000000';

/**
 * Resolve an asserted participant email to a user who is a member of `workspaceId`.
 * Returns null if the email isn't a Mnema user in this workspace (→ treated as a
 * guest). Bounded to the key's workspace so an act-as key can never reach users of
 * another tenant.
 */
async function resolveActAsUser(
  workspaceId: string,
  email: string,
): Promise<string | null> {
  const rows = await db
    .select({ userId: users.id })
    .from(users)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, users.id),
        eq(workspaceMembers.workspaceId, workspaceId),
      ),
    )
    .where(eq(users.email, email.trim())) // users.email is citext → case-insensitive
    .limit(1);
  return rows[0]?.userId ?? null;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /**
     * Marker for routes that belong to the MCP plugin. The app's auth
     * preHandler reads this and bails out — MCP auth is enforced inside
     * this plugin, not by the cookie/JWT middleware that fronts /api/*.
     */
    mcpRoute?: boolean;
  }
}

/**
 * Build a JSON-RPC-shaped 401 response with an RFC 9728 WWW-Authenticate
 * challenge pointing at our protected-resource metadata document. Per the
 * MCP spec, errors on the `/mcp` endpoint should be JSON-RPC error envelopes
 * (not Fastify's default `{error, reason}` shape) so MCP clients can parse
 * them with the same code path that handles `tools/call` errors.
 */
function send401(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .header(
      'WWW-Authenticate',
      `Bearer realm="${mcpConfig.serverName}", error="invalid_token", resource_metadata="${mcpConfig.protectedResourceMetadataUrl}"`,
    )
    .send({
      jsonrpc: '2.0',
      error: {
        code: -32001,
        message: 'Unauthorized',
        data: { protected_resource: mcpConfig.protectedResourceMetadataUrl },
      },
      id: null,
    });
}

import type { FastifyRequest } from 'fastify';

/**
 * CORS headers added to every MCP response so remote clients
 * (ChatGPT Business, OpenAI API, Codex) can reach the endpoint.
 * The wildcard origin is safe here because every request is
 * independently authenticated via Bearer token — CORS only
 * controls whether the browser forwards the preflight.
 */
function addMcpCorsHeaders(reply: FastifyReply): void {
  reply
    .header('Access-Control-Allow-Origin', '*')
    .header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    .header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
}

/**
 * Shared handler for both POST /mcp and POST /mcp/http.
 *
 * /mcp  — legacy path, kept for Claude Desktop, Cursor, Cline, mcp-remote
 * /mcp/http — standard Streamable HTTP path required by ChatGPT Business,
 *             Codex, and any client following the 2025-11-05 MCP spec
 */
async function handleMcpRequest(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  // CORS — applied to all MCP responses so remote clients can reach us.
  addMcpCorsHeaders(reply);

  // 1. Origin allowlist (browser CSRF defense). Non-browser clients
  //    (curl, claude.ai's connector backend, ChatGPT) typically omit Origin —
  //    we only enforce the check when the header is present.
  const origin = req.headers.origin;
  if (origin && !mcpConfig.originAllowlist.includes(origin)) {
    req.log.warn({ origin }, 'mcp: rejecting disallowed Origin');
    return reply.code(403).send({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Origin not allowed' },
      id: null,
    });
  }

  // 2. Bearer validation — supports both OAuth RS256 (Phase A) and
  //    legacy HS256 app JWTs (Claude Desktop via mcp-remote).
  await requireOAuthBearer(req, reply);
  if (reply.sent) return; // 401 already sent by requireOAuthBearer

  const oauthCtx = req.oauth!;

  // 3. Subscription gate — blocks halted/cancelled/paused workspaces.
  //    Free-plan workspaces (no subscription row) are allowed through.
  const gate = await checkSubscriptionGate(oauthCtx.workspaceId);
  if (!gate.allowed) {
    return reply.code(402).send({
      jsonrpc: '2.0',
      error: {
        code: -32004,
        message: gate.message,
        data: {
          subscription_status: gate.status,
          billing_url: `${process.env.WEB_BASE_URL ?? 'https://mnema.theboringpeople.in'}/app/settings/billing`,
        },
      },
      id: null,
    });
  }

  // 4. Record last-used for legacy mcp_tokens (fire-and-forget).
  if (oauthCtx.tokenType === 'legacy' && oauthCtx.jti) {
    db.update(mcpTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(mcpTokens.jti, oauthCtx.jti))
      .execute()
      .catch(() => { /* non-critical */ });
  }

  // 5. Build per-request auth context for tool handlers.
  // Phase 1 AgentLens: fetch workspace mode so dev tools can be conditionally
  // registered. Fire-and-forget approach: fetch with a short-circuit default.
  let workspaceMode: string | undefined;
  try {
    const wsRows = await db
      .select({ mode: workspaces.mode })
      .from(workspaces)
      .where(eq(workspaces.id, oauthCtx.workspaceId))
      .limit(1);
    workspaceMode = wsRows[0]?.mode;
  } catch {
    // Non-critical — dev tools will just not be registered
    workspaceMode = undefined;
  }

  // Meeting identity (Phase 1): resolve the effective principal for THIS request.
  // For an act-as key, the asking participant is named in the X-Mnema-Act-As-Email
  // header; we resolve it to a workspace user and answer as THEM. No header or an
  // unrecognized email → guest → denied all knowledge (scoped to an impossible
  // project). For every other token, the principal is just the token's own user.
  let effectiveUserId: string | null = oauthCtx.userId;
  let effectiveProjectScope: string | null = oauthCtx.projectId;

  if (oauthCtx.actAsUser) {
    const rawEmail = req.headers[ACT_AS_EMAIL_HEADER];
    const assertedEmail = Array.isArray(rawEmail) ? rawEmail[0] : rawEmail;
    const resolved = assertedEmail
      ? await resolveActAsUser(oauthCtx.workspaceId, assertedEmail)
      : null;
    if (resolved) {
      // Answer as the identified participant — their per-user RLS access applies.
      effectiveUserId = resolved;
      effectiveProjectScope = null;
    } else {
      // Guest / unidentified speaker → no knowledge at all.
      effectiveUserId = null;
      effectiveProjectScope = GUEST_DENY_PROJECT;
      req.log.info(
        { assertedEmail: assertedEmail ?? null },
        'mcp: act-as principal unresolved → guest deny',
      );
    }
  }

  const authCtx = {
    user_id: effectiveUserId ?? oauthCtx.userId,
    tenant_id: oauthCtx.workspaceId,
    email: '',  // not available on OAuth tokens; tools don't use it
    scopes: oauthCtx.scope,
    jwt_id: oauthCtx.jti,
    workspaceMode,
    project_id: effectiveProjectScope,
  };

  // 6. Build per-request server with the verified context captured in
  //    its handler closures. This is the only safe place to bind ctx.
  const server = createMcpServer(authCtx);

  // Set the request-scoped tenant scope ONCE here so every withTenant() inside any
  // tool handler inherits the project-aware RLS predicate without touching the 29
  // call sites.
  //   • userId       (= app.user_id)       → per-user project-membership RLS.
  //   • projectScope (= app.project_scope) → set for a project-scoped key (bot bound
  //                  to one project) OR the guest-deny sentinel; short-circuits the
  //                  predicate, ignoring userId.
  //
  // Safe by construction: unfiled docs (project_id NULL) stay visible to every
  // workspace member, and workspace owners/editors are admins (app_is_workspace_admin)
  // who see all projects. Only docs explicitly FILED into a project are restricted
  // to that project's members.
  try {
    await tenantScopeStore.run(
      { userId: effectiveUserId, projectScope: effectiveProjectScope },
      () => handleStreamableHttp(req, reply, server),
    );
  } catch (err) {
    if (err instanceof McpForbiddenError) {
      if (!reply.sent && !reply.raw.headersSent) {
        reply.code(403).send({
          jsonrpc: '2.0',
          error: {
            code: -32002,
            message: 'Forbidden',
            data: { required_scope: err.requiredScope },
          },
          id: null,
        });
      }
      return;
    }
    req.log.error({ err }, 'mcp: transport error');
    if (!reply.sent && !reply.raw.headersSent) {
      reply.code(500).send({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
}

export const mcpPlugin: FastifyPluginAsync = fp(async (app) => {
  const routeOpts = { config: { mcpRoute: true } };

  // OPTIONS preflight for both endpoints — needed by ChatGPT browser-side calls.
  app.options('/mcp', routeOpts, async (_req, reply) => {
    addMcpCorsHeaders(reply);
    reply.code(204).send();
  });
  app.options('/mcp/http', routeOpts, async (_req, reply) => {
    addMcpCorsHeaders(reply);
    reply.code(204).send();
  });

  // POST /mcp — original endpoint, kept for Claude Desktop, Cursor, mcp-remote.
  app.post('/mcp', routeOpts, handleMcpRequest);

  // POST /mcp/http — Streamable HTTP alias required by ChatGPT Business/Enterprise,
  // OpenAI Codex, and any client following the MCP 2025-11-05 spec that expects
  // a dedicated /mcp/http path distinct from the SSE path.
  app.post('/mcp/http', routeOpts, handleMcpRequest);
});
