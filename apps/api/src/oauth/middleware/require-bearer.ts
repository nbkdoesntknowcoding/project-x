/**
 * OAuth Bearer token validation for MCP endpoints.
 *
 * Validates RS256-signed OAuth 2.1 access tokens (Phase A).
 * Also accepts the existing HS256 app JWTs so Claude Desktop via
 * mcp-remote continues to work during the transition period.
 *
 * The resolved auth context is attached to req.oauth for downstream handlers.
 * The workspace_id from the OAuth JWT becomes the RLS tenant for all DB queries.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../../config/env.js';
import { verifyOAuthAccessToken, type OAuthJwtPayload } from '../jwt.js';
import { verifyMcpToken } from '../../mcp/auth.js';

export interface OAuthContext {
  userId: string;
  workspaceId: string;
  scope: string[];
  clientId: string;
  jti: string | null;
  tokenType: 'oauth' | 'legacy';
}

declare module 'fastify' {
  interface FastifyRequest {
    oauth?: OAuthContext;
  }
}

export async function requireOAuthBearer(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.headers.authorization;

  if (!auth?.startsWith('Bearer ')) {
    reply.header(
      'WWW-Authenticate',
      `Bearer realm="mnema-mcp", ` +
      `resource_metadata="${config.OAUTH_ISSUER}/.well-known/oauth-protected-resource"`,
    );
    reply.status(401).send({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized', data: { protected_resource: `${config.OAUTH_ISSUER}/.well-known/oauth-protected-resource` } },
      id: null,
    });
    return;
  }

  const token = auth.slice(7);

  // 1. Try OAuth RS256 token first
  const oauthResult = await verifyOAuthAccessToken(token, `${config.OAUTH_ISSUER}/mcp`);
  if (oauthResult.valid) {
    const p = oauthResult.payload as OAuthJwtPayload;
    req.oauth = {
      userId: p.sub,
      workspaceId: p.workspace_id,
      scope: p.scope.split(' '),
      clientId: p.client_id,
      jti: p.jti ?? null,
      tokenType: 'oauth',
    };
    return;
  }

  // 2. Fall back to legacy HS256 app JWT (Claude Desktop via mcp-remote)
  try {
    const legacyCtx = await verifyMcpToken(token);
    req.oauth = {
      userId: legacyCtx.user_id,
      workspaceId: legacyCtx.tenant_id,
      scope: legacyCtx.scopes,
      clientId: 'claude-desktop-legacy',
      jti: legacyCtx.jwt_id,
      tokenType: 'legacy',
    };
    return;
  } catch {
    // Both verifications failed
  }

  reply.header(
    'WWW-Authenticate',
    `Bearer realm="mnema-mcp", error="invalid_token", ` +
    `resource_metadata="${config.OAUTH_ISSUER}/.well-known/oauth-protected-resource"`,
  );
  reply.status(401).send({
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Unauthorized' },
    id: null,
  });
}
