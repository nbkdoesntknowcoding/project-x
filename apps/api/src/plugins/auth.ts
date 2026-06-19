import cookie from '@fastify/cookie';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { JwtClaims } from '@boppl/shared';
import { verifyJwt } from '../lib/jwt.js';
import { tenantScopeStore } from '../db/with-tenant.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: JwtClaims;
  }
}

export const JWT_COOKIE_NAME = 'boppl_jwt';

const PUBLIC_ROUTES = new Set<string>([
  '/health',
  '/api/_internal/set-session',
  '/api/_internal/join-workspace',
  // Pre-launch waitlist capture — called server-side by the web proxy with the
  // internal_secret (WORKOS_COOKIE_PASSWORD); no user JWT involved.
  '/api/_internal/waitlist',
  // Phase 4.1 — invitation preview must work BEFORE the invitee signs in,
  // so the accept page can show "X invited you to Y" without forcing
  // auth-first. The endpoint only reveals workspace name + inviter, never
  // tenant-confidential data, so it's safe to expose unauthenticated.
  '/api/invitations/lookup',
]);

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match?.[1] ?? null;
}

export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  await app.register(cookie);
  app.decorateRequest('auth', undefined);

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split('?')[0] ?? '/';
    if (PUBLIC_ROUTES.has(url)) return;
    if (!url.startsWith('/api/')) return;
    // MCP routes enforce their own auth (Bearer + JWT in Phase 2.2). The
    // app-login cookie/JWT path here would 401 before the MCP plugin sees
    // the request — bail out for any route flagged mcpRoute.
    if (req.routeOptions?.config?.mcpRoute) return;
    // Hook routes have their own Bearer token auth (hook_token, not JWT).
    if (url.startsWith('/api/hooks/') || url === '/install/claude-hooks.sh') return;
    // Public doc reader — no auth required.
    if (url.startsWith('/api/docs/public/')) return;
    // OnlyOffice — server-to-server calls from OnlyOffice container, no cookie.
    // /callback auth: OnlyOffice JWT signature. /file auth: tenantId query param.
    if (url === '/api/onlyoffice/callback') return;
    if (url.startsWith('/api/onlyoffice/') && url.endsWith('/file')) return;

    const token = req.cookies[JWT_COOKIE_NAME] ?? extractBearer(req.headers.authorization);
    if (!token) {
      return reply.code(401).send({ error: 'unauthorized', reason: 'missing_token' });
    }

    try {
      const claims = await verifyJwt(token);
      req.auth = claims;
      // Stage B: set the request-scoped user id so withTenant() inside REST
      // handlers inherits app.user_id → per-user project-membership RLS, the same
      // boundary the MCP path enforces. enterWith (not run) because a preHandler
      // returns before the route handler; it persists for the rest of this
      // request's async context. REST callers are never project-scoped keys, so
      // projectScope stays null. No-op for unfiled docs / workspace admins.
      tenantScopeStore.enterWith({ userId: claims.sub });
    } catch {
      return reply.code(401).send({ error: 'unauthorized', reason: 'invalid_token' });
    }
  });
});
