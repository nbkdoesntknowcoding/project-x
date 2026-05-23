import { count, eq, ilike } from 'drizzle-orm';
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

// Common free / personal email providers — skip domain-join prompt for these
// so e.g. two Gmail users don't see each other's workspace.
const GENERIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'pm.me', 'proton.me',
  'aol.com', 'mail.com',
]);

export interface DomainWorkspace {
  id: string;
  name: string;
  slug: string;
  member_count: number;
}

interface BootstrapInput {
  email: string;
  displayName: string | null;
  /** When true, skip domain-match check and always create a fresh workspace. */
  skipDomainCheck?: boolean;
}

export type BootstrapOutput =
  | { type: 'ready'; user_id: string; tenant_id: string }
  | { type: 'needs_workspace_choice'; user_id: string; domain_workspaces: DomainWorkspace[] };

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
    return { type: 'ready', user_id: userId, tenant_id: membership[0].workspaceId };
  }

  // Brand-new user — check whether another workspace already uses this domain.
  // Skip the check for free/generic providers and when caller forces a new workspace.
  if (!input.skipDomainCheck) {
    const emailDomain = input.email.split('@')[1]?.toLowerCase() ?? '';
    if (emailDomain && !GENERIC_EMAIL_DOMAINS.has(emailDomain)) {
      const domainWorkspaces = await findWorkspacesForDomain(emailDomain, userId);
      if (domainWorkspaces.length > 0) {
        return { type: 'needs_workspace_choice', user_id: userId, domain_workspaces: domainWorkspaces };
      }
    }
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

  return { type: 'ready', user_id: userId, tenant_id: workspace.id };
}

/**
 * Return workspaces that already have at least one member sharing `emailDomain`.
 * Excludes any workspace the user themselves already owns (rare edge-case safety).
 */
async function findWorkspacesForDomain(emailDomain: string, excludeUserId: string): Promise<DomainWorkspace[]> {
  // Find all user IDs whose email matches the domain (case-insensitive via citext)
  const domainUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(ilike(users.email, `%@${emailDomain}`));

  if (domainUsers.length === 0) return [];

  const domainUserIds = domainUsers.map((u) => u.id).filter((id) => id !== excludeUserId);
  if (domainUserIds.length === 0) return [];

  // Collect all workspace IDs belonging to same-domain users (deduplicated)
  // One query per user — domain teams are small in practice; cap at 20 users.
  const seenWsIds = new Set<string>();
  const allWsIds: string[] = [];
  for (const uid of domainUserIds.slice(0, 20)) {
    const rows = await db
      .selectDistinct({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, uid));
    for (const r of rows) {
      if (!seenWsIds.has(r.workspaceId)) {
        seenWsIds.add(r.workspaceId);
        allWsIds.push(r.workspaceId);
      }
    }
  }

  if (allWsIds.length === 0) return [];

  // Fetch workspace details + member counts
  const result: DomainWorkspace[] = [];
  for (const wsId of allWsIds.slice(0, 10)) {
    const wsRows = await db
      .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug })
      .from(workspaces)
      .where(eq(workspaces.id, wsId))
      .limit(1);
    if (!wsRows[0]) continue;

    const countRows = await db
      .select({ n: count() })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, wsId));

    result.push({
      id: wsRows[0].id,
      name: wsRows[0].name,
      slug: wsRows[0].slug,
      member_count: Number(countRows[0]?.n ?? 1),
    });
  }

  return result;
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
