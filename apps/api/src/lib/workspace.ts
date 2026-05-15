import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import { users, workspaceMembers, workspaces } from '../db/schema.js';

interface BootstrapInput {
  email: string;
  displayName: string | null;
}

interface BootstrapOutput {
  user_id: string;
  tenant_id: string;
}

export async function bootstrapUserAndWorkspace(
  input: BootstrapInput,
): Promise<BootstrapOutput> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1);

  let userId: string;
  if (existing[0]) {
    userId = existing[0].id;
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  } else {
    const inserted = await db
      .insert(users)
      .values({
        email: input.email,
        displayName: input.displayName,
        lastLoginAt: new Date(),
      })
      .returning();
    const created = inserted[0];
    if (!created) {
      throw new Error('Failed to create user');
    }
    userId = created.id;
  }

  const membership = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .limit(1);

  if (membership[0]) {
    return { user_id: userId, tenant_id: membership[0].workspaceId };
  }

  const localPart = input.email.split('@')[0] ?? 'user';
  const slug = `${localPart}-${nanoid(6).toLowerCase()}`;
  const inserted = await db
    .insert(workspaces)
    .values({
      slug,
      name: input.displayName ? `${input.displayName}'s workspace` : 'My workspace',
    })
    .returning();
  const workspace = inserted[0];
  if (!workspace) {
    throw new Error('Failed to create workspace');
  }

  await db.insert(workspaceMembers).values({
    workspaceId: workspace.id,
    userId,
    role: 'owner',
  });

  return { user_id: userId, tenant_id: workspace.id };
}
