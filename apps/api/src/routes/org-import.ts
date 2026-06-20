/**
 * Phase B (B1) — AI org-chart import.
 *
 *   POST /api/org/import/extract  → GPT-4o-mini extracts {teams, roles, people}
 *                                   from a text description or an image, for HR to review.
 *   POST /api/org/import/apply    → creates teams, org_roles, team_root folders, and
 *                                   sends org-role invitations; logs to iam_audit_log.
 *
 * Owner-only. Excel is handled client-side (parsed to text/description before extract).
 */
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import OpenAI from 'openai';
import { z } from 'zod';
import { config } from '../config/env.js';
import { db } from '../db/index.js';
import { withSystemPrivilege } from '../db/with-system-privilege.js';
import {
  folders,
  iamAuditLog,
  invitations,
  orgChartImports,
  orgRoles,
  teams,
  users,
  workspaceMembers,
} from '../db/schema.js';
import { signInvitationToken } from '../lib/invitation-token.js';
import { requireRole, RoleError } from '../lib/role.js';
import { emailQueue } from '../queue/email.js';

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const folderAccess = z.array(z.object({
  folder_slug: z.string(),
  permission: z.enum(['read', 'write', 'admin', 'none']),
})).optional();

const structureSchema = z.object({
  teams: z.array(z.object({
    name: z.string(),
    slug: z.string().optional(),
    parent_slug: z.string().optional().nullable(),
    color: z.string().optional(),
  })).default([]),
  roles: z.array(z.object({
    name: z.string(),
    slug: z.string().optional(),
    team_slug: z.string().optional().nullable(),
    workspace_role: z.enum(['viewer', 'editor', 'owner']).default('editor'),
    default_folder_access: folderAccess,
  })).default([]),
  people: z.array(z.object({
    name: z.string(),
    email: z.string().email().optional().nullable(),
    department: z.string().optional().nullable(),
    job_title: z.string().optional().nullable(),
    manager_email: z.string().optional().nullable(),
    role_slug: z.string().optional().nullable(),
  })).default([]),
});

const EXTRACT_PROMPT = `You extract an organisation chart into strict JSON. Return ONLY a JSON object with this exact shape:
{
  "teams":  [{ "name": string, "slug": string, "parent_slug": string|null }],
  "roles":  [{ "name": string, "slug": string, "team_slug": string|null, "workspace_role": "viewer"|"editor"|"owner" }],
  "people": [{ "name": string, "email": string|null, "department": string|null, "job_title": string|null, "manager_email": string|null, "role_slug": string|null }]
}
Rules: slugs are lowercase kebab-case. workspace_role defaults to "editor" (use "owner" only for founders/C-level, "viewer" for contractors/interns). role_slug on a person must match one of the roles' slug. Infer teams from departments. If email is unknown use null.`;

export const orgImportRoutes: FastifyPluginAsync = async (app) => {
  async function requireOwner(req: any, reply: FastifyReply): Promise<boolean> {
    try { await requireRole(req, 'owner'); return true; }
    catch (e) { if (e instanceof RoleError) { reply.code(e.status).send({ error: e.reason }); return false; } throw e; }
  }

  // ── Extract ──────────────────────────────────────────────────────────────
  app.post('/api/org/import/extract', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await requireOwner(req, reply))) return;
    if (!process.env.OPENAI_API_KEY) return reply.code(503).send({ error: 'ai_unavailable' });

    const p = z.object({
      type: z.enum(['description', 'manual', 'image', 'excel']),
      text: z.string().max(20000).optional(),
      file_url: z.string().url().optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation' });

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const userContent: OpenAI.Chat.ChatCompletionContentPart[] =
      p.data.type === 'image' && p.data.file_url
        ? [{ type: 'text', text: 'Extract the org chart from this image.' },
           { type: 'image_url', image_url: { url: p.data.file_url } }]
        : [{ type: 'text', text: p.data.text ?? '' }];

    let extracted: unknown;
    try {
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: EXTRACT_PROMPT },
          { role: 'user', content: userContent },
        ],
      });
      extracted = JSON.parse(res.choices[0]?.message?.content ?? '{}');
    } catch (err) {
      req.log.warn({ err }, 'org import extract failed');
      return reply.code(502).send({ error: 'extraction_failed' });
    }

    const parsed = structureSchema.safeParse(extracted);
    const structure = parsed.success ? parsed.data : { teams: [], roles: [], people: [] };

    const [imp] = await db.insert(orgChartImports).values({
      workspaceId: req.auth.tenant_id,
      importType: p.data.type,
      sourceFileUrl: p.data.file_url ?? null,
      extractedStructure: structure,
      status: 'pending',
      createdBy: req.auth.sub,
    }).returning({ id: orgChartImports.id });

    return reply.send({ import_id: imp!.id, extracted_structure: structure, valid: parsed.success });
  });

  // ── Apply ────────────────────────────────────────────────────────────────
  app.post('/api/org/import/apply', async (req, reply) => {
    if (!req.auth) return reply.code(401).send({ error: 'unauthorized' });
    if (!(await requireOwner(req, reply))) return;

    const p = z.object({
      import_id: z.string().uuid().optional(),
      confirmed_structure: structureSchema,
    }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });

    const ws = req.auth.tenant_id;
    const actor = req.auth.sub;
    const { teams: teamSpecs, roles: roleSpecs, people } = p.data.confirmed_structure;
    const created = { teams: 0, roles: 0, folders: 0, invites: 0 };

    await withSystemPrivilege(async (tx) => {
      const teamIdBySlug = new Map<string, string>();
      const roleIdBySlug = new Map<string, string>();

      // Teams + team_root folders
      for (const t of teamSpecs) {
        const slug = t.slug || slugify(t.name);
        const [team] = await tx.insert(teams).values({
          workspaceId: ws, name: t.name, slug, color: t.color ?? '#6b7280',
        }).onConflictDoUpdate({ target: [teams.workspaceId, teams.slug], set: { name: t.name } }).returning();
        teamIdBySlug.set(slug, team!.id);
        created.teams++;

        const existingFolder = await tx.query.folders.findFirst({
          where: and(eq(folders.workspaceId, ws), eq(folders.slug, slug), eq(folders.folderType, 'team_root')),
        });
        if (!existingFolder) {
          await tx.insert(folders).values({
            workspaceId: ws, name: t.name, slug, folderType: 'team_root',
            teamId: team!.id, isDeletable: false, createdBy: actor,
          });
          created.folders++;
        }
        await tx.insert(iamAuditLog).values({
          workspaceId: ws, actorUserId: actor, action: 'team.created', resourceType: 'team', resourceId: team!.id,
          payload: { slug, source: 'org_import' },
        });
      }

      // Org roles
      for (const r of roleSpecs) {
        const slug = r.slug || slugify(r.name);
        const teamId = r.team_slug ? teamIdBySlug.get(r.team_slug) ?? null : null;
        const [role] = await tx.insert(orgRoles).values({
          workspaceId: ws, name: r.name, slug, teamId,
          workspaceRole: r.workspace_role,
          defaultFolderAccess: r.default_folder_access ?? [],
        }).onConflictDoUpdate({
          target: [orgRoles.workspaceId, orgRoles.slug],
          set: { name: r.name, teamId, workspaceRole: r.workspace_role, defaultFolderAccess: r.default_folder_access ?? [] },
        }).returning();
        roleIdBySlug.set(slug, role!.id);
        created.roles++;
        await tx.insert(iamAuditLog).values({
          workspaceId: ws, actorUserId: actor, action: 'org_role.created', resourceType: 'org_role', resourceId: role!.id,
          payload: { slug, source: 'org_import' },
        });
      }

      // Invitations (people with an email + a known role)
      for (const person of people) {
        if (!person.email) continue;
        const email = person.email.trim().toLowerCase();
        const orgRoleId = person.role_slug ? roleIdBySlug.get(person.role_slug) ?? null : null;
        const wsRole = (orgRoleId && roleSpecs.find((r) => (r.slug || slugify(r.name)) === person.role_slug)?.workspace_role) || 'editor';
        const teamId = orgRoleId
          ? roleSpecs.find((r) => (r.slug || slugify(r.name)) === person.role_slug)?.team_slug
          : null;

        // Skip if already a member
        const member = await tx.select({ u: workspaceMembers.userId }).from(workspaceMembers)
          .innerJoin(users, eq(users.id, workspaceMembers.userId))
          .where(and(eq(workspaceMembers.workspaceId, ws), eq(users.email, email))).limit(1);
        if (member[0]) continue;

        const { token, jti } = await signInvitationToken({
          workspace_id: ws, email, role: wsRole as 'owner' | 'editor' | 'viewer', invited_by: actor,
        });
        await tx.insert(invitations).values({
          workspaceId: ws, email, role: wsRole as 'owner' | 'editor' | 'viewer', invitedBy: actor,
          tokenJti: jti, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          orgRoleId, teamId: teamId ? teamIdBySlug.get(teamId) ?? null : null,
          displayTitle: person.job_title ?? null,
        });
        created.invites++;

        await emailQueue.add('invitation', {
          type: 'invitation', to: email,
          params: { inviterName: 'Your team', workspaceName: 'Mnema', acceptUrl: `${config.WEB_BASE_URL}/invite/${token}` },
        }).catch(() => { /* email best-effort */ });
      }

      if (p.data.import_id) {
        await tx.update(orgChartImports)
          .set({ status: 'applied', appliedAt: new Date(), confirmedStructure: p.data.confirmed_structure })
          .where(and(eq(orgChartImports.id, p.data.import_id), eq(orgChartImports.workspaceId, ws)));
      }
    });

    return reply.send({ ok: true, created });
  });
};
