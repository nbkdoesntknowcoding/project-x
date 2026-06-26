/**
 * Aspect 6 / M1 — episodic meeting-record store: create / read / delete, with the record's
 * graph representation (the meeting node + discrete `decision` nodes) and right-to-be-
 * forgotten deletion of those semantic nodes.
 *
 * Distinct from meetings.summary: meeting_records is the durable EPISODIC store the M2
 * consolidation worker writes and the M3 brief assembler reads. acl_scope is set on write
 * (project else workspace least-privilege). Idempotent on meeting_id so re-running M2 for the
 * same meeting updates rather than duplicates. Participant/task graph edges are already wired
 * onto the shared `meeting` node by syncMeetingNode (lib/graph/meeting-graph.ts); M1 adds the
 * genuinely-missing piece — discrete `decision` nodes (meeting ──decided──▶ decision) — so
 * decisions are queryable/traversable, not just jsonb strings.
 */
import { and, eq, inArray, like } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from '../db/schema.js';

const { meetingRecords, graphNodes, graphEdges } = schema;

// Accepts the top-level db or a transaction (both are PostgresJsDatabase-compatible).
type Tx = PostgresJsDatabase<typeof schema>;

export interface MeetingRecordInput {
  meetingId: string;
  projectId?: string | null;
  title?: string | null;
  participants?: Array<{ name?: string | null; email?: string | null; userId?: string | null }>;
  startedAt?: Date | null;
  endedAt?: Date | null;
  summary?: string | null;
  decisions?: string[];
  actionItems?: Array<{ text: string; owner?: string | null }>;
  commitments?: schema.MeetingCommitment[];
  sourceRefs?: Record<string, unknown>;
}

/** Least-privilege scope the record's spoken content may surface in. Pure. */
export function deriveAclScope(projectId: string | null | undefined, workspaceId: string): string {
  return projectId ? `project:${projectId}` : `workspace:${workspaceId}`;
}

/**
 * M2 consolidation mapping (pure): the meeting-end worker's already-extracted summary
 * (keyPoints / decisions / actionItems) → a MeetingRecordInput. commitments are the action
 * items that named an owner. No LLM here — the extraction already happened in the worker.
 */
export function recordInputFromSummary(
  meeting: {
    id: string; projectId: string | null; title: string | null;
    startedAt: Date | null; endedAt: Date | null; postMeetingDocId?: string | null;
  },
  summary: { keyPoints: string[]; decisions: string[]; actionItems: Array<{ text: string; owner?: string | null }> } | null,
  participants: Array<{ name?: string | null; email?: string | null; userId?: string | null }>,
): MeetingRecordInput {
  const actionItems = summary?.actionItems ?? [];
  return {
    meetingId: meeting.id,
    projectId: meeting.projectId,
    title: meeting.title,
    participants,
    startedAt: meeting.startedAt,
    endedAt: meeting.endedAt,
    summary: summary && summary.keyPoints.length ? summary.keyPoints.join(' ') : null,
    decisions: summary?.decisions ?? [],
    actionItems,
    commitments: actionItems
      .filter((a) => a.owner && a.owner.trim())
      .map((a) => ({ who: a.owner!.trim(), what: a.text })),
    sourceRefs: { postMeetingDocId: meeting.postMeetingDocId ?? null, transcript: 'meeting_transcripts' },
  };
}

// ── minimal idempotent graph helpers (mirrors meeting-graph.ts) ──────────────────
async function upsertNode(
  tx: Tx, workspaceId: string, entityType: string, entityId: string, label: string,
  projectId: string | null = null, summary?: string,
): Promise<string> {
  const [existing] = await tx.select({ id: graphNodes.id }).from(graphNodes)
    .where(and(eq(graphNodes.workspaceId, workspaceId), eq(graphNodes.entityType, entityType), eq(graphNodes.entityId, entityId)))
    .limit(1);
  if (existing) {
    await tx.update(graphNodes).set({ label, projectId, ...(summary ? { summary } : {}), updatedAt: new Date() }).where(eq(graphNodes.id, existing.id));
    return existing.id;
  }
  const [row] = await tx.insert(graphNodes)
    .values({ workspaceId, entityType, entityId, label, summary, projectId, extractionPass: 'structural' })
    .returning({ id: graphNodes.id });
  return row!.id;
}

async function upsertEdge(tx: Tx, workspaceId: string, fromNodeId: string, toNodeId: string, edgeType: string, weight = 1.0): Promise<void> {
  await tx.insert(graphEdges)
    .values({ workspaceId, fromNodeId, toNodeId, edgeType, provenance: 'EXTRACTED', confidenceScore: 1.0, weight })
    .onConflictDoNothing();
}

const decisionEntityId = (meetingId: string, i: number) => `${meetingId}:decision:${i}`;

/**
 * Create (or idempotently update) the episodic record for a meeting, set acl_scope, and wire
 * its graph: the meeting node + a discrete `decision` node per decision (meeting→decided→
 * decision). Returns the record id. Stale decision nodes (from a previous, longer decision
 * list for the same meeting) are pruned so re-consolidation stays clean.
 */
export async function createMeetingRecord(tx: Tx, workspaceId: string, input: MeetingRecordInput): Promise<string> {
  const aclScope = deriveAclScope(input.projectId ?? null, workspaceId);
  const decisions = (input.decisions ?? []).map((d) => String(d).trim()).filter(Boolean);
  const values = {
    workspaceId,
    meetingId: input.meetingId,
    projectId: input.projectId ?? null,
    title: input.title ?? null,
    participants: input.participants ?? [],
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
    summary: input.summary ?? null,
    decisions,
    actionItems: input.actionItems ?? [],
    commitments: input.commitments ?? [],
    aclScope,
    sourceRefs: input.sourceRefs ?? {},
  };
  const [rec] = await tx.insert(meetingRecords).values(values)
    .onConflictDoUpdate({
      target: meetingRecords.meetingId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning({ id: meetingRecords.id });

  // Graph: meeting node + project edge + discrete decision nodes.
  const meetingNode = await upsertNode(tx, workspaceId, 'meeting', input.meetingId, input.title || 'Meeting', input.projectId ?? null);
  if (input.projectId) {
    const projNode = await upsertNode(tx, workspaceId, 'project', input.projectId, 'Project', input.projectId);
    await upsertEdge(tx, workspaceId, meetingNode, projNode, 'belongs_to');
  }
  // MD1 STEP 4: emit decision nodes with the SAME richer temporal shape as record_decision —
  // decided_at (the meeting's ended_at, else started_at), status current, decided_in = meeting,
  // decision_text, acl_scope. (Only the node shape changes; decisions still come from the
  // transcript-extracted summary exactly as before.)
  const decidedAt = input.endedAt ?? input.startedAt ?? new Date();
  for (let i = 0; i < decisions.length; i++) {
    const [dn] = await tx.insert(graphNodes).values({
      workspaceId, entityType: 'decision', entityId: decisionEntityId(input.meetingId, i),
      label: decisions[i]!.slice(0, 200), summary: decisions[i]!.slice(0, 500),
      projectId: input.projectId ?? null, extractionPass: 'structural',
      decidedAt, status: 'current', decisionText: decisions[i]!, decidedIn: input.meetingId, aclScope,
    }).onConflictDoUpdate({
      target: [graphNodes.workspaceId, graphNodes.entityType, graphNodes.entityId],
      set: {
        label: decisions[i]!.slice(0, 200), summary: decisions[i]!.slice(0, 500),
        decisionText: decisions[i]!, decidedAt, status: 'current', decidedIn: input.meetingId,
        aclScope, projectId: input.projectId ?? null, updatedAt: new Date(),
      },
    }).returning({ id: graphNodes.id });
    await upsertEdge(tx, workspaceId, meetingNode, dn!.id, 'decided', 1.5);
  }
  // Prune decision nodes beyond the current count (idempotent re-consolidation).
  await deleteDecisionNodes(tx, workspaceId, input.meetingId, decisions.length);

  return rec!.id;
}

/** Read the episodic record by record id or meeting id (workspace-scoped). */
export async function getMeetingRecord(
  tx: Tx, workspaceId: string, by: { id?: string; meetingId?: string },
) {
  if (!by.id && !by.meetingId) return null;
  const [rec] = await tx.select().from(meetingRecords).where(and(
    eq(meetingRecords.workspaceId, workspaceId),
    by.id ? eq(meetingRecords.id, by.id) : eq(meetingRecords.meetingId, by.meetingId!),
  )).limit(1);
  return rec ?? null;
}

/** Remove a meeting's `decision` graph nodes (entityId index >= fromIndex) and their edges. */
async function deleteDecisionNodes(tx: Tx, workspaceId: string, meetingId: string, fromIndex = 0): Promise<void> {
  const nodes = await tx.select({ id: graphNodes.id, entityId: graphNodes.entityId }).from(graphNodes)
    .where(and(
      eq(graphNodes.workspaceId, workspaceId),
      eq(graphNodes.entityType, 'decision'),
      like(graphNodes.entityId, `${meetingId}:decision:%`),
    ));
  const ids = nodes
    .filter((n) => {
      const idx = Number(n.entityId.split(':').pop());
      return Number.isFinite(idx) && idx >= fromIndex;
    })
    .map((n) => n.id);
  if (ids.length === 0) return;
  await tx.delete(graphEdges).where(inArray(graphEdges.fromNodeId, ids));
  await tx.delete(graphEdges).where(inArray(graphEdges.toNodeId, ids));
  await tx.delete(graphNodes).where(inArray(graphNodes.id, ids));
}

/**
 * Right-to-be-forgotten: delete the episodic record AND its linked semantic nodes (the
 * discrete decision nodes + their edges). The shared `meeting` node is left to syncMeetingNode
 * (it represents the meeting, not just this record). Returns true if a record was deleted.
 */
export async function deleteMeetingRecord(tx: Tx, workspaceId: string, recordId: string): Promise<boolean> {
  const rec = await getMeetingRecord(tx, workspaceId, { id: recordId });
  if (!rec) return false;
  await deleteDecisionNodes(tx, workspaceId, rec.meetingId, 0);
  await tx.delete(meetingRecords).where(and(eq(meetingRecords.workspaceId, workspaceId), eq(meetingRecords.id, recordId)));
  return true;
}
