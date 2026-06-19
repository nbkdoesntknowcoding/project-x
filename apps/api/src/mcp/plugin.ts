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
import { db } from '../db/index.js';
import { tenantScopeStore } from '../db/with-tenant.js';
import { mcpTokens, workspaces } from '../db/schema.js';

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

  const authCtx = {
    user_id: oauthCtx.userId,
    tenant_id: oauthCtx.workspaceId,
    email: '',  // not available on OAuth tokens; tools don't use it
    scopes: oauthCtx.scope,
    jwt_id: oauthCtx.jti,
    workspaceMode,
    project_id: oauthCtx.projectId,
  };

  // 6. Build per-request server with the verified context captured in
  //    its handler closures. This is the only safe place to bind ctx.
  const server = createMcpServer(authCtx);

  // Stage B activation: set the request-scoped tenant scope ONCE here so every
  // withTenant() inside any tool handler inherits the project-aware RLS predicate
  // without touching the 29 call sites.
  //
  // We set projectScope (= app.project_scope) but deliberately leave userId UNSET
  // for now. projectScope is null for every normal token and is populated ONLY for
  // a project-scoped API key (the meeting bot) — so the only behavior change today
  // is that the bot is hard-bounded to its one project (the "don't blabber"
  // guarantee), while every human OAuth/legacy/personal-key session keeps today's
  // workspace-wide behavior (app.user_id unset → app_can_see_project() returns true).
  //
  // Per-user membership RLS (passing userId) activates in B5, together with the
  // project_members data + Members UI that populates it; flipping it on before that
  // would lock real members out of any doc filed into a project. See [[Stage B plan]].
  try {
    await tenantScopeStore.run(
      { projectScope: oauthCtx.projectId },
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
