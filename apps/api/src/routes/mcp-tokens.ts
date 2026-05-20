import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { SignJWT } from 'jose';
import { z } from 'zod';
import { config } from '../config/env.js';
import { mcpTokens } from '../db/schema.js';
import { withTenant } from '../db/with-tenant.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const secret = new TextEncoder().encode(config.JWT_SECRET);

const createSchema = z.object({
  name: z.string().min(1).max(100).default('Claude Desktop'),
});

export const mcpTokenRoutes: FastifyPluginAsync = async (app) => {
  // List active (non-revoked) tokens for this workspace.
  // Returns metadata only — the raw JWT is never stored and never returned here.
  app.get('/api/mcp-tokens', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });

    const rows = await withTenant(req.auth.tenant_id, async (tx) => {
      return await tx
        .select({
          id: mcpTokens.id,
          name: mcpTokens.name,
          scopes: mcpTokens.scopes,
          expiresAt: mcpTokens.expiresAt,
          lastUsedAt: mcpTokens.lastUsedAt,
          createdAt: mcpTokens.createdAt,
        })
        .from(mcpTokens)
        .where(
          and(
            eq(mcpTokens.workspaceId, req.auth.tenant_id),
            isNull(mcpTokens.revokedAt),
          ),
        )
        .orderBy(mcpTokens.createdAt);
    });

    return { tokens: rows };
  });

  // Issue a new long-lived MCP token.
  // Returns the raw JWT exactly once — caller must copy it immediately.
  app.post('/api/mcp-tokens', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });

    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request', issues: parsed.error.issues });
    }

    const auth = req.auth;

    // Insert the metadata row first so we can capture the generated jti.
    const row = await withTenant(auth.tenant_id, async (tx) => {
      const inserted = await tx
        .insert(mcpTokens)
        .values({
          workspaceId: auth.tenant_id,
          userId: auth.sub,
          name: parsed.data.name,
          // 90-day expiry: long enough to be useful, short enough to rotate.
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        })
        .returning();
      return inserted[0]!;
    });

    // Sign a JWT using the same secret / issuer / audience as the app JWT,
    // but with docs:read + flows:read scopes and a 90-day expiry.
    const jwt = await new SignJWT({
      sub: auth.sub,
      tenant_id: auth.tenant_id,
      email: auth.email,
      scopes: ['docs:read', 'flows:read'],
      jti: row.jti,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(config.JWT_ISSUER)
      // MCP audience — accepted by verifyMcpToken alongside the REST audience.
      .setAudience(config.JWT_AUDIENCE_MCP ?? `${config.JWT_AUDIENCE}/mcp`)
      .setExpirationTime('90d')
      .sign(secret);

    return reply.code(201).send({
      token: {
        id: row.id,
        name: row.name,
        scopes: row.scopes,
        expires_at: row.expiresAt,
        created_at: row.createdAt,
      },
      // Raw JWT — shown once. Store it; we cannot recover it.
      jwt,
    });
  });

  // Revoke a token by ID.
  app.delete<{ Params: { id: string } }>('/api/mcp-tokens/:id', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params;
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'bad_id' });

    await withTenant(req.auth.tenant_id, async (tx) => {
      await tx
        .update(mcpTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(mcpTokens.id, id),
            eq(mcpTokens.workspaceId, req.auth!.tenant_id),
            isNull(mcpTokens.revokedAt),
          ),
        );
    });

    return reply.code(204).send();
  });
};
