/**
 * Meeting graph wiring (Phase 3). Connects a meeting into the knowledge graph:
 *   meeting ──belongs_to──▶ project
 *   meeting ──documented_by──▶ post/pre-meeting doc
 *   meeting ──attended_by──▶ person (each resolved participant)
 *   meeting ──produced──▶ task (each auto-created action item)
 *   task    ──assigned_to──▶ person
 *   meeting ──related──▶ meeting (auto-linked)
 *
 * Used both by the structural extraction pass (every full graph build) and by
 * the post-meeting worker (so a meeting connects immediately, without waiting
 * for a manual rebuild). All upserts are idempotent.
 */
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

const { graphNodes, graphEdges, meetings, meetingParticipants, tasks, docs, users } = schema;

type Tx = NodePgDatabase<typeof schema>;

async function upsertNode(
  tx: Tx, workspaceId: string, entityType: string, entityId: string, label: string,
  projectId: string | null = null, summary?: string,
): Promise<string> {
  const existing = await tx
    .select({ id: graphNodes.id })
    .from(graphNodes)
    .where(and(eq(graphNodes.workspaceId, workspaceId), eq(graphNodes.entityType, entityType), eq(graphNodes.entityId, entityId)))
    .limit(1);
  if (existing[0]) {
    await tx.update(graphNodes).set({ label, projectId, ...(summary ? { summary } : {}), updatedAt: new Date() }).where(eq(graphNodes.id, existing[0].id));
    return existing[0].id;
  }
  const rows = await tx
    .insert(graphNodes)
    .values({ workspaceId, entityType, entityId, label, summary, projectId, extractionPass: 'structural' })
    .returning({ id: graphNodes.id });
  return rows[0]!.id;
}

async function upsertEdge(tx: Tx, workspaceId: string, fromNodeId: string, toNodeId: string, edgeType: string, weight = 1.0): Promise<void> {
  await tx
    .insert(graphEdges)
    .values({ workspaceId, fromNodeId, toNodeId, edgeType, provenance: 'EXTRACTED', confidenceScore: 1.0, weight })
    .onConflictDoNothing();
}

/** Wire a single meeting (and its people/tasks/docs/links) into the graph. */
export async function syncMeetingNode(tx: Tx, workspaceId: string, meetingId: string): Promise<void> {
  const meeting = await tx.query.meetings.findFirst({ where: and(eq(meetings.id, meetingId), eq(meetings.workspaceId, workspaceId)) });
  if (!meeting) return;

  const meetingNodeId = await upsertNode(
    tx, workspaceId, 'meeting', meeting.id,
    meeting.title || 'Meeting', meeting.projectId ?? null,
    meeting.summary ? meeting.summary.keyPoints.slice(0, 3).join('; ') : undefined,
  );

  // meeting → project
  if (meeting.projectId) {
    const projNode = await upsertNode(tx, workspaceId, 'project', meeting.projectId, 'Project', meeting.projectId);
    await upsertEdge(tx, workspaceId, meetingNodeId, projNode, 'belongs_to');
  }

  // meeting → docs (post / pre-meeting notes)
  for (const docId of [meeting.postMeetingDocId, meeting.preMeetingDocId]) {
    if (!docId) continue;
    const doc = await tx.query.docs.findFirst({ where: eq(docs.id, docId) });
    if (!doc) continue;
    const docNode = await upsertNode(tx, workspaceId, 'doc', doc.id, doc.title || 'Untitled', doc.projectId ?? null);
    await upsertEdge(tx, workspaceId, meetingNodeId, docNode, 'documented_by', 1.5);
  }

  // meeting → person (each resolved participant)
  const parts = await tx
    .select({ userId: meetingParticipants.resolvedUserId, name: users.displayName, email: users.email })
    .from(meetingParticipants)
    .leftJoin(users, eq(users.id, meetingParticipants.resolvedUserId))
    .where(and(eq(meetingParticipants.meetingId, meeting.id), isNotNull(meetingParticipants.resolvedUserId)));
  const seenPeople = new Set<string>();
  for (const p of parts) {
    if (!p.userId || seenPeople.has(p.userId)) continue;
    seenPeople.add(p.userId);
    const personNode = await upsertNode(tx, workspaceId, 'person', p.userId, p.name || p.email || 'Member');
    await upsertEdge(tx, workspaceId, meetingNodeId, personNode, 'attended_by', 1.5);
  }

  // meeting → task (auto-created) + task → person (assignee)
  const meetingTasks = await tx
    .select({ id: tasks.id, title: tasks.title, projectId: tasks.projectId, assignee: tasks.assignedMemberId })
    .from(tasks)
    .where(eq(tasks.meetingId, meeting.id));
  for (const t of meetingTasks) {
    const taskNode = await upsertNode(tx, workspaceId, 'task', t.id, t.title, t.projectId ?? null);
    await upsertEdge(tx, workspaceId, meetingNodeId, taskNode, 'produced', 1.5);
    if (t.assignee) {
      const u = await tx.query.users.findFirst({ where: eq(users.id, t.assignee) });
      const personNode = await upsertNode(tx, workspaceId, 'person', t.assignee, u?.displayName || u?.email || 'Member');
      await upsertEdge(tx, workspaceId, taskNode, personNode, 'assigned_to', 1.5);
    }
  }

  // meeting → meeting (auto-linked, same-project / shared-participant)
  const linked = (meeting.linkedMeetingIds ?? []).filter((x): x is string => !!x);
  if (linked.length > 0) {
    const others = await tx
      .select({ id: meetings.id, title: meetings.title, projectId: meetings.projectId })
      .from(meetings)
      .where(and(eq(meetings.workspaceId, workspaceId), inArray(meetings.id, linked)));
    for (const o of others) {
      const otherNode = await upsertNode(tx, workspaceId, 'meeting', o.id, o.title || 'Meeting', o.projectId ?? null);
      await upsertEdge(tx, workspaceId, meetingNodeId, otherNode, 'related');
    }
  }
}

/** Wire every meeting in a workspace into the graph (called from structural pass). */
export async function syncAllMeetings(tx: Tx, workspaceId: string): Promise<number> {
  const rows = await tx.select({ id: meetings.id }).from(meetings).where(eq(meetings.workspaceId, workspaceId));
  for (const m of rows) await syncMeetingNode(tx, workspaceId, m.id);
  return rows.length;
}
