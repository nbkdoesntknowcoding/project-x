/**
 * Phase B — Org structure + IAM admin API (owner-only mutations).
 *
 *   Teams:   GET/POST /api/org/teams, PATCH/DELETE /api/org/teams/:id
 *   Members: POST /api/org/teams/:id/members, DELETE /api/org/teams/:id/members/:userId
 *   Roles:   GET/POST /api/org/roles, PATCH/DELETE /api/org/roles/:id
 *   View:    GET /api/org/structure  (teams + members + profiles for the chart)
 *   Access:  GET /api/org/access     (the team/role × folder matrix)
 *            POST /api/org/access     (upsert a doc_acl cell + audit)
 *   Audit:   GET /api/org/audit
 *
 * Reads require editor+, mutations require owner. The org admin = HR/owner.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  docAcl,
  folders,
  iamAuditLog,
  orgRoles,
  teamMembers,
  teams,
  userOrgProfiles,
  users,
} from '../db/schema.js';
import { withTenant } from '../db/with-tenant.js';
import { applyOrgRolePolicies } from '../lib/iam-policy-factory.js';
import { requireRole, RoleError } from '../lib/role.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const folderAccessSchema = z.array(z.object({
  folder_slug: z.string(),
  permission: z.enum(['read', 'write', 'admin', 'none']),
}));

const createTeamSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().max(60).optional(),
  description: z.string().max(2000).optional().nullable(),
  parentTeamId: z.string().uuid().optional().nullable(),
  color: z.string().max(20).optional(),
});

const createRoleSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().max(60).optional(),
  teamId: z.string().uuid().optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  workspaceRole: z.enum(['viewer', 'editor', 'owner']).default('editor'),
  defaultFolderAccess: folderAccessSchema.optional(),
});

const accessCellSchema = z.object({
  principalType: z.enum(['user', 'team', 'org_role']),
  principalId: z.string().uuid(),
  resourceType: z.enum(['folder', 'project', 'doc']).default('folder'),
  resourceId: z.string().uuid(),
  permission: z.enum(['read', 'write', 'admin', 'none']),
});

export const orgRoutes: FastifyPluginAsync = async (app) => {
  function guard(err: unknown, reply: FastifyReply): boolean {
    if (err instanceof RoleError) { reply.code(err.status).send({ error: err.reason }); return true; }
    return false;
  }
  async function requireOwner(req: any, reply: FastifyReply): Promise<boolean> {
    try { await requireRole(req, 'owner'); return true; }
    catch (e) { if (guard(e, reply)) return false; throw e; }
  }
  async function requireReader(req: any, reply: FastifyReply): Promise<boolean> {
    try { await requireRole(req, 'editor'); return true; }
    catch (e) { if (guard(e, reply)) return false; throw e; }
  }
  async function audit(workspaceId: string, actorUserId: string, action: string, resourceType: string, resourceId: string, payload: unknown) {
    await db.insert(iamAuditLog).values({ workspaceId, actorUserId, action, resourceType, resourceId, payload: payload as object });
  }

  // ── Teams ──────────────────────────────────────────────────────────────────
  app.get('/api/org/teams', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await requireReader(req, reply))) return;
    const rows = await withTenant(req.auth.tenant_id, (tx) =>
      tx.select().from(teams).where(eq(teams.workspaceId, req.auth!.tenant_id)).orderBy(teams.name));
    return reply.send({ teams: rows });
  });

  app.post('/api/org/teams', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await requireOwner(req, reply))) return;
    const p = createTeamSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
    const slug = p.data.slug || slugify(p.data.name);
    const [team] = await withTenant(req.auth.tenant_id, (tx) =>
      tx.insert(teams).values({
        workspaceId: req.auth!.tenant_id,
        name: p.data.name, slug,
        description: p.data.description ?? null,
        parentTeamId: p.data.parentTeamId ?? null,
        color: p.data.color ?? '#6b7280',
      }).returning());
    await audit(req.auth.tenant_id, req.auth.sub, 'team.created', 'team', team!.id, { slug });
    return reply.code(201).send({ team });
  });

  app.patch('/api/org/teams/:id', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    if (!(await requireOwner(req, reply))) return;
    const p = createTeamSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation' });
    const [team] = await withTenant(req.auth.tenant_id, (tx) =>
      tx.update(teams).set({
        ...(p.data.name ? { name: p.data.name } : {}),
        ...(p.data.slug ? { slug: p.data.slug } : {}),
        ...(p.data.description !== undefined ? { description: p.data.description } : {}),
        ...(p.data.parentTeamId !== undefined ? { parentTeamId: p.data.parentTeamId } : {}),
        ...(p.data.color ? { color: p.data.color } : {}),
      }).where(and(eq(teams.id, id), eq(teams.workspaceId, req.auth!.tenant_id))).returning());
    if (!team) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ team });
  });

  app.delete('/api/org/teams/:id', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    if (!(await requireOwner(req, reply))) return;
    const removed = await withTenant(req.auth.tenant_id, (tx) =>
      tx.delete(teams).where(and(eq(teams.id, id), eq(teams.workspaceId, req.auth!.tenant_id))).returning());
    if (removed.length === 0) return reply.code(404).send({ error: 'not_found' });
    await audit(req.auth.tenant_id, req.auth.sub, 'team.deleted', 'team', id, {});
    return reply.send({ ok: true });
  });

  // ── Team members ───────────────────────────────────────────────────────────
  app.post('/api/org/teams/:id/members', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    if (!(await requireOwner(req, reply))) return;
    const p = z.object({ userId: z.string().uuid(), role: z.enum(['member', 'lead', 'admin']).default('member') }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation' });
    await db.insert(teamMembers).values({ teamId: id, userId: p.data.userId, role: p.data.role })
      .onConflictDoUpdate({ target: [teamMembers.teamId, teamMembers.userId], set: { role: p.data.role } });
    await audit(req.auth.tenant_id, req.auth.sub, 'team.member.added', 'team', id, { userId: p.data.userId, role: p.data.role });
    return reply.code(201).send({ ok: true });
  });

  app.delete('/api/org/teams/:id/members/:userId', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id, userId } = req.params as { id: string; userId: string };
    if (!UUID_RE.test(id) || !UUID_RE.test(userId)) return reply.code(400).send({ error: 'invalid_id' });
    if (!(await requireOwner(req, reply))) return;
    await db.delete(teamMembers).where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, userId)));
    await audit(req.auth.tenant_id, req.auth.sub, 'team.member.removed', 'team', id, { userId });
    return reply.send({ ok: true });
  });

  // ── Org roles ──────────────────────────────────────────────────────────────
  app.get('/api/org/roles', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await requireReader(req, reply))) return;
    const rows = await withTenant(req.auth.tenant_id, (tx) =>
      tx.select().from(orgRoles).where(eq(orgRoles.workspaceId, req.auth!.tenant_id)).orderBy(orgRoles.name));
    return reply.send({ roles: rows });
  });

  app.post('/api/org/roles', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await requireOwner(req, reply))) return;
    const p = createRoleSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
    const slug = p.data.slug || slugify(p.data.name);
    const [role] = await withTenant(req.auth.tenant_id, (tx) =>
      tx.insert(orgRoles).values({
        workspaceId: req.auth!.tenant_id,
        name: p.data.name, slug,
        teamId: p.data.teamId ?? null,
        description: p.data.description ?? null,
        workspaceRole: p.data.workspaceRole,
        defaultFolderAccess: p.data.defaultFolderAccess ?? [],
      }).returning());
    await audit(req.auth.tenant_id, req.auth.sub, 'org_role.created', 'org_role', role!.id, { slug });
    return reply.code(201).send({ role });
  });

  // PATCH a role — if default_folder_access changed, re-apply to all members.
  app.patch('/api/org/roles/:id', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    if (!(await requireOwner(req, reply))) return;
    const p = createRoleSchema.partial().safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation' });
    const [role] = await withTenant(req.auth.tenant_id, (tx) =>
      tx.update(orgRoles).set({
        ...(p.data.name ? { name: p.data.name } : {}),
        ...(p.data.teamId !== undefined ? { teamId: p.data.teamId } : {}),
        ...(p.data.description !== undefined ? { description: p.data.description } : {}),
        ...(p.data.workspaceRole ? { workspaceRole: p.data.workspaceRole } : {}),
        ...(p.data.defaultFolderAccess !== undefined ? { defaultFolderAccess: p.data.defaultFolderAccess } : {}),
      }).where(and(eq(orgRoles.id, id), eq(orgRoles.workspaceId, req.auth!.tenant_id))).returning());
    if (!role) return reply.code(404).send({ error: 'not_found' });

    if (p.data.defaultFolderAccess !== undefined) {
      const members = await db.select({ userId: userOrgProfiles.userId })
        .from(userOrgProfiles)
        .where(and(eq(userOrgProfiles.workspaceId, req.auth.tenant_id), eq(userOrgProfiles.orgRoleId, id)));
      for (const m of members) {
        await applyOrgRolePolicies(m.userId, req.auth.tenant_id, id, req.auth.sub);
      }
    }
    await audit(req.auth.tenant_id, req.auth.sub, 'org_role.updated', 'org_role', id, {});
    return reply.send({ role });
  });

  app.delete('/api/org/roles/:id', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    if (!(await requireOwner(req, reply))) return;
    const removed = await withTenant(req.auth.tenant_id, (tx) =>
      tx.delete(orgRoles).where(and(eq(orgRoles.id, id), eq(orgRoles.workspaceId, req.auth!.tenant_id))).returning());
    if (removed.length === 0) return reply.code(404).send({ error: 'not_found' });
    await audit(req.auth.tenant_id, req.auth.sub, 'org_role.deleted', 'org_role', id, {});
    return reply.send({ ok: true });
  });

  // ── Structure (the org chart) ───────────────────────────────────────────────
  app.get('/api/org/structure', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await requireReader(req, reply))) return;
    const ws = req.auth.tenant_id;
    const [teamRows, roleRows, profileRows] = await Promise.all([
      withTenant(ws, (tx) => tx.select().from(teams).where(eq(teams.workspaceId, ws))),
      withTenant(ws, (tx) => tx.select().from(orgRoles).where(eq(orgRoles.workspaceId, ws))),
      db.select({
        userId: userOrgProfiles.userId,
        displayTitle: userOrgProfiles.displayTitle,
        roleSlug: userOrgProfiles.roleSlug,
        department: userOrgProfiles.department,
        botDisplayName: userOrgProfiles.botDisplayName,
        email: users.email,
        displayName: users.displayName,
      }).from(userOrgProfiles).innerJoin(users, eq(users.id, userOrgProfiles.userId))
        .where(eq(userOrgProfiles.workspaceId, ws)),
    ]);
    return reply.send({ teams: teamRows, roles: roleRows, people: profileRows });
  });

  // ── Access matrix ───────────────────────────────────────────────────────────
  app.get('/api/org/access', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await requireReader(req, reply))) return;
    const rows = await db.select().from(docAcl).where(eq(docAcl.workspaceId, req.auth.tenant_id));
    return reply.send({ grants: rows });
  });

  app.post('/api/org/access', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await requireOwner(req, reply))) return;
    const p = accessCellSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
    const { principalType, principalId, resourceType, resourceId, permission } = p.data;
    await db.insert(docAcl).values({
      workspaceId: req.auth.tenant_id,
      resourceType, resourceId, principalType, principalId, permission,
      createdBy: req.auth.sub,
    }).onConflictDoUpdate({
      target: [docAcl.resourceType, docAcl.resourceId, docAcl.principalType, docAcl.principalId],
      set: { permission, updatedAt: new Date() },
    });
    await audit(req.auth.tenant_id, req.auth.sub, 'policy.updated', resourceType, resourceId,
      { principalType, principalId, permission });
    return reply.send({ ok: true });
  });

  // ── Audit log (owner-only; HR-readable) ─────────────────────────────────────
  app.get('/api/org/audit', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await requireOwner(req, reply))) return;
    const rows = await db.select().from(iamAuditLog)
      .where(eq(iamAuditLog.workspaceId, req.auth.tenant_id))
      .orderBy(desc(iamAuditLog.createdAt)).limit(200);
    return reply.send({ entries: rows });
  });

  // expose folders for the access matrix columns
  app.get('/api/org/folders', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await requireReader(req, reply))) return;
    const rows = await withTenant(req.auth.tenant_id, (tx) =>
      tx.select({ id: folders.id, name: folders.name, slug: folders.slug, folderType: folders.folderType })
        .from(folders).where(eq(folders.workspaceId, req.auth!.tenant_id)));
    return reply.send({ folders: rows });
  });
};
