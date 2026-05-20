import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/index.js';
import {
  docs,
  flowEdges,
  flowNodes,
  flows,
  flowVersions,
  users,
  workspaceMembers,
  workspaces,
} from '../db/schema.js';
import { emptyYjsState } from './yjs.js';

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

  // ── Seed welcome doc + example-onboarding flow ────────────────────────────
  await seedExampleFlow(workspace.id, userId);

  return { user_id: userId, tenant_id: workspace.id };
}

/**
 * Create the welcome doc and example-onboarding flow for a freshly created
 * workspace. Idempotent — called from bootstrapUserAndWorkspace but can be
 * retried without side effects.
 */
async function seedExampleFlow(workspaceId: string, userId: string): Promise<void> {
  // 1. Create the welcome doc
  const welcomeMarkdown = [
    '# Welcome to Mnema',
    '',
    'Mnema is a live context engine that keeps your AI assistant up to date as your team writes.',
    '',
    '## How it works',
    '',
    '- **Docs** — write your knowledge in Markdown. Edits are live; Claude always reads the current version.',
    '- **Flows** — sequence docs and instructions into guided walks. Claude follows the steps in order.',
    '- **MCP** — connect Claude (claude.ai, Claude Desktop, or any MCP-compatible client) with a single URL.',
    '',
    'Edit this doc to describe your workspace. Delete it when you\'re ready.',
  ].join('\n');

  const docInsert = await db
    .insert(docs)
    .values({
      workspaceId,
      path: 'welcome.md',
      title: 'Welcome to Mnema',
      markdown: welcomeMarkdown,
      yjsState: emptyYjsState(),
      createdBy: userId,
      updatedBy: userId,
    })
    .returning({ id: docs.id });
  const docId = docInsert[0]?.id;
  if (!docId) return; // shouldn't happen

  // 2. Create the example flow
  const flowInsert = await db
    .insert(flows)
    .values({
      workspaceId,
      slug: 'example-onboarding',
      name: 'Example: workspace onboarding',
      description:
        'A simple example flow showing how Claude walks a sequence of docs. Edit or delete this flow to make it yours.',
      createdBy: userId,
    })
    .returning({ id: flows.id });
  const flowId = flowInsert[0]?.id;
  if (!flowId) return;

  // 3. Create the published version
  const versionInsert = await db
    .insert(flowVersions)
    .values({
      flowId,
      workspaceId,
      versionNumber: 1,
      isPublished: true,
      createdBy: userId,
    })
    .returning({ id: flowVersions.id });
  const versionId = versionInsert[0]?.id;
  if (!versionId) return;

  // 4. Seed nodes
  await db.insert(flowNodes).values([
    {
      flowVersionId: versionId,
      clientNodeId: 'intro',
      kind: 'instruction',
      title: 'Welcome',
      positionX: 100,
      positionY: 100,
      data: {
        text: 'This is an example flow. Each step has an instruction and optional content. The next step reads the workspace welcome doc.',
      },
    },
    {
      flowVersionId: versionId,
      clientNodeId: 'read-welcome',
      kind: 'doc',
      title: 'Read the welcome doc',
      positionX: 300,
      positionY: 100,
      data: {
        doc_id: docId,
        instruction:
          'Read this doc to understand what Mnema is and how this workspace is structured.',
      },
    },
  ]);

  // 5. Seed edge
  await db.insert(flowEdges).values({
    flowVersionId: versionId,
    fromNodeId: 'intro',
    toNodeId: 'read-welcome',
    fromSocket: 'default',
  });

  // 6. Point the flow at the published version
  await db
    .update(flows)
    .set({ publishedVersionId: versionId })
    .where(eq(flows.id, flowId));
}
