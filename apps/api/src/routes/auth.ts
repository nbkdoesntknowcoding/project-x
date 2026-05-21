import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownToYjsState } from '@boppl/schema/node';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { docs, workspaceMembers, workspaces } from '../db/schema.js';
import { withSystemPrivilege } from '../db/with-system-privilege.js';
import { seedExampleFlow } from '../services/flow-seed.js';
import { withTenant } from '../db/with-tenant.js';
import { signJwt } from '../lib/jwt.js';
import { scopesForRole } from '../lib/scopes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Welcome doc copy lives as a static template so edits don't need a code
// change. Loaded once at module init.
const WELCOME_TEMPLATE = readFileSync(
  join(__dirname, '..', 'templates', 'welcome-doc.md'),
  'utf-8',
);

const JWT_COOKIE = 'boppl_jwt';
// 30-day cookie envelope; the JWT inside expires in 1h. The web layer
// re-mints via /api/_internal/set-session on each session reload.
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30;

const switchWorkspaceSchema = z.object({
  workspace_id: z.string().uuid(),
});

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(2)
    .max(40)
    .optional(),
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  // ------------------------------------------------------------------------
  // GET /api/auth/me — resolved user + active workspace + role. Unchanged
  // from earlier phases.
  // ------------------------------------------------------------------------
  app.get('/api/auth/me', async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { sub: userId, tenant_id, email, scopes } = req.auth;

    const result = await withTenant(tenant_id, async (tx) => {
      const wsRows = await tx
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, tenant_id))
        .limit(1);
      const memberRows = await tx
        .select()
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, tenant_id))
        .limit(1);
      return { workspace: wsRows[0], role: memberRows[0]?.role };
    });

    return {
      user: { id: userId, email },
      workspace: result.workspace,
      role: result.role,
      scopes,
    };
  });

  // ------------------------------------------------------------------------
  // GET /api/auth/workspaces — list every workspace the current user is a
  // member of. Powers the WorkspaceSwitcher in Chunk C's header UI.
  // Returns roles too so the switcher can render badges.
  // ------------------------------------------------------------------------
  app.get('/api/auth/workspaces', async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const memberships = await db
      .select({
        id: workspaces.id,
        slug: workspaces.slug,
        name: workspaces.name,
        role: workspaceMembers.role,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(eq(workspaceMembers.userId, req.auth.sub));

    return { workspaces: memberships };
  });

  // ------------------------------------------------------------------------
  // POST /api/auth/switch-workspace — verify membership, re-mint the JWT
  // with the new tenant_id, set the cookie. The web layer reloads after
  // this; we don't try to hot-swap an open Yjs editor across tenants.
  //
  // The membership check is the ONLY thing standing between cookie
  // tampering and tenant-id forging. Don't weaken it.
  // ------------------------------------------------------------------------
  app.post('/api/auth/switch-workspace', async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = switchWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request' });
    }

    const member = await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, req.auth.sub),
          eq(workspaceMembers.workspaceId, parsed.data.workspace_id),
        ),
      )
      .limit(1);
    if (member.length === 0) {
      return reply.code(403).send({ error: 'not_a_member' });
    }

    const wsRows = await db
      .select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, parsed.data.workspace_id))
      .limit(1);
    if (wsRows.length === 0) {
      return reply.code(404).send({ error: 'workspace_not_found' });
    }

    const jwt = await signJwt({
      sub: req.auth.sub,
      tenant_id: parsed.data.workspace_id,
      email: req.auth.email,
      scopes: scopesForRole(member[0]!.role),
    });
    reply.setCookie(JWT_COOKIE, jwt, {
      path: '/',
      httpOnly: true,
      secure: false, // local dev; Phase D flips this on
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE_SEC,
    });

    // The JWT is also returned in the body so the web tier's switch endpoint
    // can update the sealed boppl_session cookie (which carries the canonical
    // tenant_id read by Astro middleware on every server render).
    return { workspace: wsRows[0], jwt };
  });

  // ------------------------------------------------------------------------
  // POST /api/auth/create-workspace — create a workspace, add the current
  // user as owner, seed the welcome doc, re-mint the JWT scoped to it.
  //
  // withSystemPrivilege because workspace creation is cross-tenant by
  // definition (the new workspace doesn't exist yet, and a brand-new signup
  // may have no active tenant context at all).
  // ------------------------------------------------------------------------
  app.post('/api/auth/create-workspace', async (req, reply) => {
    if (!req.auth) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const parsed = createWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad_request' });
    }

    const slug = parsed.data.slug ?? slugify(parsed.data.name);

    // Stage 1: workspace + owner membership under system privilege.
    const setupResult = await withSystemPrivilege(async (tx) => {
      const existing = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.slug, slug))
        .limit(1);
      if (existing.length > 0) {
        return { error: 'slug_taken' as const };
      }

      const [ws] = await tx
        .insert(workspaces)
        .values({ slug, name: parsed.data.name })
        .returning();
      if (!ws) {
        throw new Error('workspace_insert_failed');
      }

      await tx.insert(workspaceMembers).values({
        workspaceId: ws.id,
        userId: req.auth!.sub,
        role: 'owner',
      });

      return { workspace: { id: ws.id, slug: ws.slug, name: ws.name } };
    });

    if ('error' in setupResult) {
      return reply.code(409).send({ error: setupResult.error });
    }

    // Stage 2: seed the welcome doc under the new tenant's GUC. content_hash
    // stays empty; the embeddings worker backfills on the next save.
    // Capture the returned doc id so the example-flow seed can reference it.
    const welcomeDocId = await withTenant(setupResult.workspace.id, async (tx) => {
      const yjsState = await markdownToYjsState(WELCOME_TEMPLATE);
      const [inserted] = await tx
        .insert(docs)
        .values({
          workspaceId: setupResult.workspace.id,
          path: 'welcome.md',
          title: 'Welcome to Mnema',
          markdown: WELCOME_TEMPLATE,
          yjsState: Buffer.from(yjsState),
          contentHash: '',
          createdBy: req.auth!.sub,
        })
        .returning({ id: docs.id });
      if (!inserted) throw new Error('welcome_doc_insert_failed');
      return inserted.id;
    });

    // Stage 2b (Phase 6.1): seed the example flow so every new workspace has
    // something MCP clients can `list_flows` against from day one. Failure
    // here is logged but doesn't fail the signup — workspace creation is
    // the primary contract; the seeded flow is convenience.
    try {
      await seedExampleFlow(setupResult.workspace.id, req.auth!.sub, welcomeDocId);
    } catch (err) {
      req.log.warn({ err, workspace_id: setupResult.workspace.id }, 'example_flow_seed_failed');
    }

    // Stage 3: re-mint JWT scoped to the new workspace + set cookie.
    // Creator is always owner — they just inserted the membership above.
    const jwt = await signJwt({
      sub: req.auth.sub,
      tenant_id: setupResult.workspace.id,
      email: req.auth.email,
      scopes: scopesForRole('owner'),
    });
    reply.setCookie(JWT_COOKIE, jwt, {
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE_SEC,
    });

    // See switch-workspace: the JWT is returned in the body so the web tier
    // can refresh its sealed session cookie alongside the JWT cookie.
    return { workspace: setupResult.workspace, jwt };
  });
};

/** lowercase, alphanumeric+hyphen, trimmed, capped at 40 chars. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
