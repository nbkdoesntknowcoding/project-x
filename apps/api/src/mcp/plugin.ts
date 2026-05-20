import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { requireOAuthBearer } from '../oauth/middleware/require-bearer.js';
import { mcpConfig } from './config.js';
import { protectedResourceRoutes } from './protected-resource.js';
import { McpForbiddenError } from './scope.js';
import { createMcpServer } from './server.js';
import { handleStreamableHttp } from './transport.js';
import { db } from '../db/index.js';
import { mcpTokens } from '../db/schema.js';

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

export const mcpPlugin: FastifyPluginAsync = fp(async (app) => {
  await app.register(protectedResourceRoutes);

  app.post(
    '/mcp',
    { config: { mcpRoute: true } },
    async (req, reply) => {
      // 1. Origin allowlist (browser CSRF defense). Non-browser clients
      //    (curl, claude.ai's connector backend) typically omit Origin —
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

      // 3. Record last-used for legacy mcp_tokens (fire-and-forget).
      if (oauthCtx.tokenType === 'legacy' && oauthCtx.jti) {
        db.update(mcpTokens)
          .set({ lastUsedAt: new Date() })
          .where(eq(mcpTokens.jti, oauthCtx.jti))
          .execute()
          .catch(() => { /* non-critical */ });
      }

      // 4. Build per-request auth context for tool handlers.
      const authCtx = {
        user_id: oauthCtx.userId,
        tenant_id: oauthCtx.workspaceId,
        email: '',  // not available on OAuth tokens; tools don't use it
        scopes: oauthCtx.scope,
        jwt_id: oauthCtx.jti,
      };

      // 5. Build per-request server with the verified context captured in
      //    its handler closures. This is the only safe place to bind ctx.
      const server = createMcpServer(authCtx);

      try {
        await handleStreamableHttp(req, reply, server);
      } catch (err) {
        if (err instanceof McpForbiddenError) {
          // Tool-scope check rejected the call. Wired here so 2.3+ doesn't
          // have to revisit this file.
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
    },
  );
});
