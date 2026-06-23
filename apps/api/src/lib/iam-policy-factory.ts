/**
 * Phase A (A3) + Phase B (B2) — IAM policy auto-creation + org-profile provisioning.
 *
 * These are SYSTEM operations: they materialise org-role defaults into per-user
 * doc_acl rows and provision a user's org identity on invite-accept. They straddle
 * tenant boundaries and read folders (FORCE RLS), so they run under boppl_system
 * (BYPASSRLS) via withSystemPrivilege — NOT the request's app_user connection.
 * (Deviation from the spec's `db` param, required by our RLS model. New
 * withSystemPrivilege caller, justified: org-IAM provisioning.)
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { withSystemPrivilege } from '../db/with-system-privilege.js';
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

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Materialise an org_role's default_folder_access into per-user doc_acl rows (uses a given tx). */
async function applyPoliciesTx(
  tx: Tx,
  userId: string,
  workspaceId: string,
  orgRoleId: string,
  actorUserId: string,
): Promise<void> {
  const orgRole = await tx.query.orgRoles.findFirst({
    where: and(eq(orgRoles.id, orgRoleId), eq(orgRoles.workspaceId, workspaceId)),
  });
  if (!orgRole) throw new Error('Org role not found');

  const policies = (orgRole.defaultFolderAccess ?? []) as Array<{
    folder_slug: string;
    permission: 'read' | 'write' | 'admin' | 'none';
  }>;

  for (const policy of policies) {
    const folder = await tx.query.folders.findFirst({
      where: and(eq(folders.workspaceId, workspaceId), eq(folders.slug, policy.folder_slug)),
    });
    if (!folder) continue;

    await tx.insert(docAcl).values({
      workspaceId,
      resourceType: 'folder',
      resourceId: folder.id,
      principalType: 'user',
      principalId: userId,
      permission: policy.permission,
      createdBy: actorUserId,
    }).onConflictDoUpdate({
      target: [docAcl.resourceType, docAcl.resourceId, docAcl.principalType, docAcl.principalId],
      set: { permission: policy.permission, updatedAt: new Date() },
    });

    await tx.insert(iamAuditLog).values({
      workspaceId,
      actorUserId,
      action: 'policy.created',
      resourceType: 'folder',
      resourceId: folder.id,
      payload: { userId, permission: policy.permission, source: 'org_role_auto' },
    });
  }
}

/**
 * Public: re-apply an org role's folder policies to a user (e.g. on invite or when
 * default_folder_access is edited).
 */
export async function applyOrgRolePolicies(
  userId: string,
  workspaceId: string,
  orgRoleId: string,
  actorUserId: string,
): Promise<void> {
  await withSystemPrivilege((tx) => applyPoliciesTx(tx, userId, workspaceId, orgRoleId, actorUserId));
}

/**
 * FIX 5 — bulk-seed `principal_type='team'` doc_acl rows from an explicit policy
 * list. One team row applies to every current + future team member, because
 * app_acl_permits()/app_effective_permission() resolve `team` grants against the
 * caller's team_members at read time — no per-user fan-out needed. The single-cell
 * POST /api/org/access already writes team cells; this is the bulk/default path.
 * Idempotent (upsert), audited, runs under system privilege like the org-role path.
 */
export async function applyTeamFolderPolicies(
  teamId: string,
  workspaceId: string,
  policies: Array<{
    resourceType: 'doc' | 'folder' | 'project';
    resourceId: string;
    permission: 'read' | 'write' | 'admin' | 'none';
  }>,
  actorUserId: string,
): Promise<void> {
  await withSystemPrivilege(async (tx) => {
    for (const policy of policies) {
      await tx.insert(docAcl).values({
        workspaceId,
        resourceType: policy.resourceType,
        resourceId: policy.resourceId,
        principalType: 'team',
        principalId: teamId,
        permission: policy.permission,
        createdBy: actorUserId,
      }).onConflictDoUpdate({
        target: [docAcl.resourceType, docAcl.resourceId, docAcl.principalType, docAcl.principalId],
        set: { permission: policy.permission, updatedAt: new Date() },
      });

      await tx.insert(iamAuditLog).values({
        workspaceId,
        actorUserId,
        action: 'policy.created',
        resourceType: policy.resourceType,
        resourceId: policy.resourceId,
        payload: { teamId, permission: policy.permission, source: 'team_policy_bulk' },
      });
    }
  });
}

/**
 * Phase B (B2) — provision a user's org identity when they accept an invite that
 * carries an org_role. Creates user_org_profiles + team_members, applies the role's
 * folder policies, computes bot_display_name, and audits. Idempotent.
 */
export async function provisionOrgProfile(args: {
  userId: string;
  workspaceId: string;
  orgRoleId: string;
  actorUserId: string;
  displayTitle?: string | null;
}): Promise<void> {
  const { userId, workspaceId, orgRoleId, actorUserId } = args;
  await withSystemPrivilege(async (tx) => {
    const orgRole = await tx.query.orgRoles.findFirst({
      where: and(eq(orgRoles.id, orgRoleId), eq(orgRoles.workspaceId, workspaceId)),
    });
    if (!orgRole) throw new Error('Org role not found');

    const team = orgRole.teamId
      ? await tx.query.teams.findFirst({ where: eq(teams.id, orgRole.teamId) })
      : null;
    const user = await tx.query.users.findFirst({ where: eq(users.id, userId) });

    const title = (args.displayTitle ?? '').trim() || orgRole.name;
    const personName = user?.displayName ?? user?.email ?? 'Member';
    const botDisplayName = `${personName} · ${title}`;

    await tx.insert(userOrgProfiles).values({
      userId, workspaceId, orgRoleId,
      displayTitle: title,
      roleSlug: orgRole.slug,
      department: team?.name ?? null,
      botDisplayName,
    }).onConflictDoUpdate({
      target: [userOrgProfiles.userId, userOrgProfiles.workspaceId],
      set: { orgRoleId, displayTitle: title, roleSlug: orgRole.slug, department: team?.name ?? null, botDisplayName },
    });

    if (orgRole.teamId) {
      await tx.insert(teamMembers)
        .values({ teamId: orgRole.teamId, userId, role: 'member' })
        .onConflictDoNothing();
    }

    await applyPoliciesTx(tx, userId, workspaceId, orgRoleId, actorUserId);

    await tx.insert(iamAuditLog).values({
      workspaceId,
      actorUserId,
      action: 'user.role.changed',
      resourceType: 'user',
      resourceId: userId,
      payload: { orgRoleId, roleSlug: orgRole.slug, team: team?.slug ?? null, source: 'invite_accept' },
    });
  });
}
