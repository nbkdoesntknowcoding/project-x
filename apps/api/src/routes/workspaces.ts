import { and, eq, ne } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { workspaces } from '../db/schema.js';
import { withSystemPrivilege } from '../db/with-system-privilege.js';
import { withTenant } from '../db/with-tenant.js';
import { requireRole, RoleError } from '../lib/role.js';

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(2)
    .max(40)
    .optional(),
});

/**
 * Workspace settings routes (rename / re-slug). Phase 4.1 deliberately
 * does NOT include DELETE — destructive ops need more guardrails (Phase 5).
 */
export const workspacesRoutes: FastifyPluginAsync = async (app) => {
  // ------------------------------------------------------------------------
  // GET /api/workspaces/current — fetch the active workspace's basics for
  // the Settings → Workspace page. Viewer+.
  // ------------------------------------------------------------------------
  app.get('/api/workspaces/current', async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    try {
      await requireRole(req, 'viewer');
    } catch (err) {
      if (err instanceof RoleError) {
        return reply.code(err.status).send({ error: err.reason });
      }
      throw err;
    }

    const row = await withTenant(req.auth.tenant_id, async (tx) => {
      const rows = await tx
        .select({
          id: workspaces.id,
          slug: workspaces.slug,
          name: workspaces.name,
          plan: workspaces.plan,
          createdAt: workspaces.createdAt,
        })
        .from(workspaces)
        .where(eq(workspaces.id, req.auth!.tenant_id))
        .limit(1);
      return rows[0];
    });
    if (!row) {
      return reply.code(404).send({ error: 'workspace_not_found' });
    }
    return { workspace: row };
  });

  // ------------------------------------------------------------------------
  // PATCH /api/workspaces/current — update name and/or slug. Owner-only.
  // Slug change uses withSystemPrivilege for the cross-row uniqueness check
  // (the slug unique constraint isn't tenant-scoped — it's globally unique).
  // ------------------------------------------------------------------------
  app.patch('/api/workspaces/current', async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    try {
      await requireRole(req, 'owner');
    } catch (err) {
      if (err instanceof RoleError) {
        return reply.code(err.status).send({ error: err.reason });
      }
      throw err;
    }

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    if (parsed.data.name === undefined && parsed.data.slug === undefined) {
      return reply.code(400).send({ error: 'nothing_to_update' });
    }

    // Slug uniqueness check needs a cross-tenant read — only the global
    // workspaces table sees all slugs. Use system privilege deliberately
    // and narrowly: just the existence check, not the update itself.
    if (parsed.data.slug !== undefined) {
      const taken = await withSystemPrivilege(async (tx) =>
        tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(
            and(eq(workspaces.slug, parsed.data.slug!), ne(workspaces.id, req.auth!.tenant_id)),
          )
          .limit(1),
      );
      if (taken.length > 0) {
        return reply.code(409).send({ error: 'slug_taken' });
      }
    }

    const updated = await withTenant(req.auth.tenant_id, async (tx) =>
      tx
        .update(workspaces)
        .set({
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.slug !== undefined ? { slug: parsed.data.slug } : {}),
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, req.auth!.tenant_id))
        .returning(),
    );

    return { workspace: updated[0] };
  });
};

