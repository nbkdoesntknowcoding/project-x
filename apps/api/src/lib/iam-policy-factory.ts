/**
 * Phase A (A3) — IAM policy auto-creation on org_role assignment.
 *
 * Called when a user is invited with an org_role: reads org_role.default_folder_access
 * and creates doc_acl rows automatically. Also called when an org_role's
 * default_folder_access is edited — re-applies policies to all members of that role.
 */
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { docAcl, folders, iamAuditLog, orgRoles } from '../db/schema.js';

type DB = Database;

export async function applyOrgRolePolicies(
  db: DB,
  userId: string,
  workspaceId: string,
  orgRoleId: string,
  actorUserId: string,
): Promise<void> {
  const orgRole = await db.query.orgRoles.findFirst({
    where: and(eq(orgRoles.id, orgRoleId), eq(orgRoles.workspaceId, workspaceId)),
  });
  if (!orgRole) throw new Error('Org role not found');

  const policies = (orgRole.defaultFolderAccess ?? []) as Array<{
    folder_slug: string;
    permission: 'read' | 'write' | 'admin' | 'none';
  }>;

  for (const policy of policies) {
    // Resolve folder_slug to folder_id
    const folder = await db.query.folders.findFirst({
      where: and(
        eq(folders.workspaceId, workspaceId),
        eq(folders.slug, policy.folder_slug),
      ),
    });
    if (!folder) continue;

    // Upsert doc_acl row
    await db.insert(docAcl).values({
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

    // Log to audit trail
    await db.insert(iamAuditLog).values({
      workspaceId,
      actorUserId,
      action: 'policy.created',
      resourceType: 'folder',
      resourceId: folder.id,
      payload: { userId, permission: policy.permission, source: 'org_role_auto' },
    });
  }
}
