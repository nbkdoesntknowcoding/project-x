/**
 * Internal admin center API — staff-only (gated by requireAdmin on every handler).
 * Cross-tenant by design: reads/writes via the owner `db` connection, bypassing
 * workspace RLS. Every mutation is recorded in admin_audit_log.
 *
 *   GET  /api/admin/me                          confirm staff access
 *   GET  /api/admin/workspaces                  all workspaces + plan + members + owner
 *   GET  /api/admin/users                       all users + workspace count
 *   POST /api/admin/workspaces/:id/suspend      suspend (blocks the workspace's users)
 *   POST /api/admin/workspaces/:id/reactivate
 *   GET  /api/admin/health                      db + job-queue depths
 *   GET  /api/admin/usage                       totals + per-workspace session cost
 *   GET  /api/admin/audit                        recent admin actions
 *   GET/POST/PATCH /api/admin/licenses[...]     licenses (plans + issuable keys)
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { db } from '../../db/index.js';
import { adminAuditLog, licenses, users, workspaceMembers, workspaces } from '../../db/schema.js';
import { requireAdmin, logAdminAction } from '../../lib/admin.js';
import { bustSuspendedCache } from '../../lib/suspended.js';
import { signJwt } from '../../lib/jwt.js';
import { scopesForRole } from '../../lib/scopes.js';
import { RoleError, requireRole } from '../../lib/role.js';
import { graphQueue } from '../../queue/graph.js';
import { meetingEndQueue } from '../../queue/meeting-end.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function genLicenseKey(): string {
  const raw = nanoid(16).toUpperCase().replace(/[^A-Z0-9]/g, '').padEnd(16, 'X').slice(0, 16);
  return `MNEMA-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export const adminRoutes: FastifyPluginAsync = async (app) => {
  function guard(err: unknown, reply: FastifyReply): boolean {
    if (err instanceof RoleError) { reply.code(err.status).send({ error: err.reason }); return true; }
    return false;
  }
  // Every admin route starts the same way: 401/403 gate. Returns the actor or null (handled).
  function gate(req: import('fastify').FastifyRequest, reply: FastifyReply): { userId: string; email: string } | null {
    try { return requireAdmin(req); } catch (e) { if (guard(e, reply)) return null; throw e; }
  }

  // ── confirm access ─────────────────────────────────────────────────────────
  app.get('/api/admin/me', async (req, reply) => {
    const me = gate(req, reply); if (!me) return;
    return reply.send({ ok: true, email: me.email });
  });

  // ── workspaces ─────────────────────────────────────────────────────────────
  app.get('/api/admin/workspaces', async (req, reply) => {
    if (!gate(req, reply)) return;
    const rows = await db.execute(sql`
      SELECT w.id, w.name, w.slug, w.plan, w.mode, w.created_at,
             (w.settings->>'suspended')::boolean AS suspended,
             (SELECT count(*)::int FROM workspace_members wm WHERE wm.workspace_id = w.id) AS members,
             (SELECT u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id
              WHERE wm.workspace_id = w.id AND wm.role = 'owner' ORDER BY wm.joined_at LIMIT 1) AS owner_email,
             (SELECT wm.user_id FROM workspace_members wm
              WHERE wm.workspace_id = w.id AND wm.role = 'owner' ORDER BY wm.joined_at LIMIT 1) AS owner_id
      FROM workspaces w ORDER BY w.created_at DESC`);
    return reply.send({ workspaces: rows });
  });

  app.get('/api/admin/users', async (req, reply) => {
    if (!gate(req, reply)) return;
    const rows = await db.execute(sql`
      SELECT u.id, u.email, u.display_name, u.created_at, u.last_login_at,
             (SELECT count(*)::int FROM workspace_members wm WHERE wm.user_id = u.id) AS workspaces
      FROM users u ORDER BY u.created_at DESC LIMIT 500`);
    return reply.send({ users: rows });
  });

  // ── impersonation ───────────────────────────────────────────────────────────
  // Mint a SHORT-LIVED (30m) JWT for a target user in a target workspace. The web
  // layer stashes the admin's own session and swaps in this token, shows a banner,
  // and offers one-click return. Read-mostly is enforced web-side + by audit.
  app.post('/api/admin/impersonate', async (req, reply) => {
    const me = gate(req, reply); if (!me) return;
    const p = z.object({ user_id: z.string().uuid(), workspace_id: z.string().uuid() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation' });
    const [m] = await db
      .select({ role: workspaceMembers.role, email: users.email, name: users.displayName })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.userId, p.data.user_id), eq(workspaceMembers.workspaceId, p.data.workspace_id)))
      .limit(1);
    if (!m) return reply.code(400).send({ error: 'not_a_member' });
    const jwt = await signJwt(
      { sub: p.data.user_id, tenant_id: p.data.workspace_id, scopes: scopesForRole(m.role), email: m.email },
      { expiresIn: '30m' },
    );
    await logAdminAction(req, { action: 'user.impersonate', targetType: 'user', targetId: p.data.user_id, payload: { workspace_id: p.data.workspace_id, target_email: m.email } });
    return reply.send({ jwt, user_id: p.data.user_id, email: m.email, name: m.name, workspace_id: p.data.workspace_id, until: Date.now() + 30 * 60 * 1000 });
  });

  async function setSuspended(req: import('fastify').FastifyRequest, reply: FastifyReply, id: string, suspended: boolean) {
    if (!gate(req, reply)) return;
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    const [w] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, id)).limit(1);
    if (!w) return reply.code(404).send({ error: 'not_found' });
    // Merge a `suspended` flag into the jsonb settings.
    await db.execute(sql`
      UPDATE workspaces SET settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{suspended}', ${suspended}::text::jsonb), updated_at = now()
      WHERE id = ${id}::uuid`);
    bustSuspendedCache();
    await logAdminAction(req, { action: suspended ? 'workspace.suspend' : 'workspace.reactivate', targetType: 'workspace', targetId: id });
    return reply.send({ ok: true, suspended });
  }
  app.post('/api/admin/workspaces/:id/suspend', async (req, reply) => setSuspended(req, reply, (req.params as { id: string }).id, true));
  app.post('/api/admin/workspaces/:id/reactivate', async (req, reply) => setSuspended(req, reply, (req.params as { id: string }).id, false));

  // ── system health + usage ──────────────────────────────────────────────────
  app.get('/api/admin/health', async (req, reply) => {
    if (!gate(req, reply)) return;
    let dbOk = false;
    try { await db.execute(sql`SELECT 1`); dbOk = true; } catch { dbOk = false; }
    const queues: Record<string, unknown> = {};
    for (const [name, q] of [['knowledge-graph', graphQueue], ['meeting-end', meetingEndQueue]] as const) {
      try { queues[name] = await q.getJobCounts('waiting', 'active', 'delayed', 'failed'); }
      catch { queues[name] = { error: true }; }
    }
    return reply.send({ db: dbOk, queues, time: new Date().toISOString() });
  });

  app.get('/api/admin/usage', async (req, reply) => {
    if (!gate(req, reply)) return;
    const [totals] = (await db.execute(sql`
      SELECT (SELECT count(*)::int FROM workspaces) AS workspaces,
             (SELECT count(*)::int FROM users) AS users,
             (SELECT count(*)::int FROM docs WHERE deleted_at IS NULL) AS docs,
             (SELECT count(*)::int FROM meetings) AS meetings,
             (SELECT count(*)::int FROM tasks) AS tasks`)) as unknown as Array<Record<string, number>>;
    const perWorkspace = await db.execute(sql`
      SELECT w.name, w.plan,
             (coalesce(s.avg_cost_usd,0) * coalesce(s.session_count,0))::float AS cost_usd,
             coalesce(s.session_count, 0)::int AS sessions,
             s.last_session_at
      FROM workspaces w
      LEFT JOIN workspace_session_stats s ON s.workspace_id = w.id
      ORDER BY (coalesce(s.avg_cost_usd,0) * coalesce(s.session_count,0)) DESC LIMIT 50`).catch(() => []);
    return reply.send({ totals: totals ?? {}, per_workspace: perWorkspace });
  });

  // ── admin audit log ─────────────────────────────────────────────────────────
  app.get('/api/admin/audit', async (req, reply) => {
    if (!gate(req, reply)) return;
    const rows = await db.select().from(adminAuditLog).orderBy(desc(adminAuditLog.createdAt)).limit(200);
    return reply.send({ entries: rows });
  });

  // ── licenses (plans + issuable keys) ─────────────────────────────────────────
  app.get('/api/admin/licenses', async (req, reply) => {
    if (!gate(req, reply)) return;
    const rows = await db.execute(sql`
      SELECT l.*, w.name AS workspace_name
      FROM licenses l LEFT JOIN workspaces w ON w.id = l.workspace_id
      ORDER BY l.created_at DESC LIMIT 500`);
    return reply.send({ licenses: rows });
  });

  const createSchema = z.object({
    plan_tier: z.enum(['free', 'individual', 'team', 'business']),
    seats: z.number().int().min(1).default(1),
    entitlements: z.record(z.unknown()).optional(),
    expires_at: z.string().datetime().nullable().optional(),
    workspace_id: z.string().uuid().nullable().optional(),
    generate_key: z.boolean().optional(),
    notes: z.string().max(500).optional(),
  });
  app.post('/api/admin/licenses', async (req, reply) => {
    const me = gate(req, reply); if (!me) return;
    const p = createSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
    const d = p.data;
    const [lic] = await db.insert(licenses).values({
      planTier: d.plan_tier, seats: d.seats,
      entitlements: (d.entitlements ?? {}) as never,
      licenseKey: d.generate_key ? genLicenseKey() : null,
      workspaceId: d.workspace_id ?? null,
      expiresAt: d.expires_at ? new Date(d.expires_at) : null,
      status: 'active', startsAt: new Date(), issuedBy: me.userId, notes: d.notes ?? null,
    }).returning();
    // If bound to a workspace at creation, apply the plan + entitlements immediately.
    if (lic && d.workspace_id) await applyLicense(lic.id, d.workspace_id, d.plan_tier, d.entitlements ?? {});
    await logAdminAction(req, { action: 'license.create', targetType: 'license', targetId: lic?.id, payload: { plan: d.plan_tier, seats: d.seats } });
    return reply.code(201).send({ license: lic });
  });

  const patchSchema = z.object({
    status: z.enum(['active', 'trial', 'expiring', 'expired', 'suspended', 'revoked']).optional(),
    seats: z.number().int().min(1).optional(),
    expires_at: z.string().datetime().nullable().optional(),
    notes: z.string().max(500).optional(),
  });
  app.patch('/api/admin/licenses/:id', async (req, reply) => {
    if (!gate(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    const p = patchSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation' });
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (p.data.status) set.status = p.data.status;
    if (p.data.seats) set.seats = p.data.seats;
    if (p.data.expires_at !== undefined) set.expiresAt = p.data.expires_at ? new Date(p.data.expires_at) : null;
    if (p.data.notes !== undefined) set.notes = p.data.notes;
    const [lic] = await db.update(licenses).set(set).where(eq(licenses.id, id)).returning();
    if (!lic) return reply.code(404).send({ error: 'not_found' });
    await logAdminAction(req, { action: 'license.update', targetType: 'license', targetId: id, payload: p.data });
    return reply.send({ license: lic });
  });

  app.post('/api/admin/licenses/:id/assign', async (req, reply) => {
    if (!gate(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'invalid_id' });
    const p = z.object({ workspace_id: z.string().uuid() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation' });
    const [lic] = await db.select().from(licenses).where(eq(licenses.id, id)).limit(1);
    if (!lic) return reply.code(404).send({ error: 'not_found' });
    const [w] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, p.data.workspace_id)).limit(1);
    if (!w) return reply.code(400).send({ error: 'invalid_workspace' });
    await db.update(licenses).set({ workspaceId: p.data.workspace_id, updatedAt: new Date() }).where(eq(licenses.id, id));
    await applyLicense(id, p.data.workspace_id, lic.planTier, (lic.entitlements ?? {}) as Record<string, unknown>);
    await logAdminAction(req, { action: 'license.assign', targetType: 'license', targetId: id, payload: { workspace_id: p.data.workspace_id } });
    return reply.send({ ok: true });
  });

  // ── redemption (workspace OWNER, not admin) ──────────────────────────────────
  // A workspace owner redeems an issued key → binds + applies it to their workspace.
  app.post('/api/licenses/redeem', async (req, reply) => {
    try { await requireRole(req, 'owner'); }
    catch (e) { if (e instanceof RoleError) return reply.code(e.status).send({ error: e.reason }); throw e; }
    const p = z.object({ key: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation' });
    const tenant = req.auth!.tenant_id;
    const [lic] = await db.select().from(licenses).where(eq(licenses.licenseKey, p.data.key.trim())).limit(1);
    if (!lic) return reply.code(404).send({ error: 'invalid_key' });
    if (lic.status === 'revoked' || lic.status === 'expired' || lic.status === 'suspended') {
      return reply.code(400).send({ error: `key_${lic.status}` });
    }
    if (lic.redeemedAt && lic.workspaceId && lic.workspaceId !== tenant) {
      return reply.code(400).send({ error: 'already_redeemed' });
    }
    await db.update(licenses).set({
      workspaceId: tenant, redeemedBy: req.auth!.sub, redeemedAt: new Date(), status: 'active', updatedAt: new Date(),
    }).where(eq(licenses.id, lic.id));
    await applyLicense(lic.id, tenant, lic.planTier, (lic.entitlements ?? {}) as Record<string, unknown>);
    return reply.send({ ok: true, plan: lic.planTier, seats: lic.seats });
  });
};

/** Push a license's plan + entitlements onto the workspace (existing plan gating reads these). */
async function applyLicense(_licenseId: string, workspaceId: string, planTier: string, entitlements: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    UPDATE workspaces
    SET plan = ${planTier},
        settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{entitlements}', ${JSON.stringify(entitlements)}::jsonb),
        updated_at = now()
    WHERE id = ${workspaceId}::uuid`);
}
