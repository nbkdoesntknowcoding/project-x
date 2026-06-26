/**
 * Decision Memory MD1 — record a decision as BOTH a searchable doc AND a first-class temporal
 * `decision` graph node, with supersede-by-invalidation (keep-both-and-link).
 *
 * Why both (settled in design): the doc makes the decision retrievable by search_docs
 * immediately and lets the nightly extractor umbrella-connect it to related concepts/docs/
 * tasks; the graph node carries the temporal fields (decided_at / status / supersedes /
 * superseded_by) that MD2's temporal-aware retrieval ranks on. They are linked 1:1 by a
 * deterministic key derived from (project, decision text) — so re-recording the same decision
 * is idempotent (no duplicate node, no duplicate doc).
 *
 * Anti-deprecation: this is a NEW write path. It does not touch search_docs, _inject, or the
 * meeting extractor's behaviour — it only adds the decision entity. The meeting path is
 * converged separately (STEP 4) to emit the same richer node shape.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { docs, folders, graphNodes, graphEdges } from '../db/schema.js';
import { contentHash, emptyYjsState } from './yjs.js';
import { enqueueExtractDoc } from '../queue/graph.js';

export interface RecordDecisionInput {
  decisionText: string;
  projectId?: string | null;
  supersedes?: string | null;   // graph_nodes.id of the decision this one replaces
  decidedIn?: string | null;    // meetings.id, when the decision came from a meeting
  decidedAt?: Date;             // defaults to now (server-set); the meeting path passes ended_at
  status?: 'current' | 'historical';
}

export interface RecordDecisionResult {
  nodeId: string;
  docId: string;
  entityId: string;
  status: 'current' | 'historical';
  supersededOldId?: string;
}

function normalizeText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Deterministic dedup key from (project, normalized text) → 1:1 node + doc, idempotent. */
function decisionKey(projectId: string | null | undefined, decisionText: string): string {
  return createHash('sha1').update(`${projectId ?? 'ws'}|${normalizeText(decisionText)}`).digest('hex').slice(0, 32);
}

export function deriveAclScope(projectId: string | null | undefined, workspaceId: string): string {
  return projectId ? `project:${projectId}` : `workspace:${workspaceId}`;
}

async function ensureDecisionsFolder(workspaceId: string): Promise<string> {
  const existing = await db.query.folders.findFirst({
    where: and(eq(folders.workspaceId, workspaceId), eq(folders.name, 'Decisions'), isNull(folders.parentFolderId)),
  });
  if (existing) return existing.id;
  const [created] = await db.insert(folders).values({
    workspaceId, name: 'Decisions', folderType: 'system',
  }).returning({ id: folders.id });
  return created!.id;
}

function shortTitle(decisionText: string): string {
  const t = decisionText.trim().replace(/\s+/g, ' ');
  return t.length <= 70 ? t : `${t.slice(0, 67)}…`;
}

function renderDecisionDoc(decisionText: string, decidedAt: Date, status: string, superseded: boolean): string {
  const lines = [
    `# Decision — ${shortTitle(decisionText)}`,
    `_Decided ${decidedAt.toISOString().slice(0, 10)} · status: ${status}_`,
    '',
    decisionText.trim(),
  ];
  if (superseded) lines.push('', 'This decision supersedes an earlier one.');
  return lines.join('\n');
}

/**
 * Validate a supersede target BEFORE writing anything, so an invalid supersede creates
 * nothing orphaned. Throws on: target missing, self-supersede, or a cycle.
 */
async function validateSupersede(
  workspaceId: string, oldId: string, wouldBeNewNodeId: string | null,
): Promise<{ id: string; supersedes: string | null }> {
  const old = await db.query.graphNodes.findFirst({
    where: and(eq(graphNodes.workspaceId, workspaceId), eq(graphNodes.id, oldId), eq(graphNodes.entityType, 'decision')),
  });
  if (!old) throw new Error('supersedes target is not an existing decision');
  if (wouldBeNewNodeId && oldId === wouldBeNewNodeId) throw new Error('a decision cannot supersede itself');
  // walk old's supersede chain; if it reaches the new node, this would form a cycle
  let cur: string | null = old.supersedes ?? null;
  const seen = new Set<string>([oldId]);
  while (cur) {
    if (wouldBeNewNodeId && cur === wouldBeNewNodeId) throw new Error('supersedes would form a cycle');
    if (seen.has(cur)) break;
    seen.add(cur);
    const n = await db.query.graphNodes.findFirst({ where: eq(graphNodes.id, cur) });
    cur = n?.supersedes ?? null;
  }
  return { id: old.id, supersedes: old.supersedes ?? null };
}

/**
 * Record a decision. Idempotent on (project, text). When `supersedes` is given, keeps both
 * decisions, links them, and flips the old one to `historical` (never deletes/mutates its
 * content). Returns the node + doc ids.
 */
export async function recordDecision(workspaceId: string, input: RecordDecisionInput): Promise<RecordDecisionResult> {
  const decisionText = (input.decisionText ?? '').trim();
  if (!decisionText) throw new Error('decision_text is required');
  const projectId = input.projectId ?? null;
  const decidedAt = input.decidedAt ?? new Date();
  const status: 'current' | 'historical' = input.status ?? 'current';
  const aclScope = deriveAclScope(projectId, workspaceId);
  const key = decisionKey(projectId, decisionText);
  const entityId = `decision:${key}`;
  const docPath = `decision-${key}.md`;

  // Existing node for this key (idempotency) — its id is the "would-be new node id".
  const existingNode = await db.query.graphNodes.findFirst({
    where: and(eq(graphNodes.workspaceId, workspaceId), eq(graphNodes.entityType, 'decision'), eq(graphNodes.entityId, entityId)),
  });

  // Validate supersede FIRST (before any write) so nothing is created on a bad target.
  if (input.supersedes) {
    await validateSupersede(workspaceId, input.supersedes, existingNode?.id ?? null);
  }

  // ── Doc (searchable + umbrella source) ──
  const folderId = await ensureDecisionsFolder(workspaceId);
  const title = `Decision — ${shortTitle(decisionText)}`;
  const md = renderDecisionDoc(decisionText, decidedAt, status, !!input.supersedes);
  const existingDoc = await db.query.docs.findFirst({
    where: and(eq(docs.workspaceId, workspaceId), eq(docs.path, docPath)),
  });
  let docId: string;
  if (existingDoc) {
    await db.update(docs).set({ markdown: md, title, contentHash: contentHash(md), projectId, updatedAt: new Date() }).where(eq(docs.id, existingDoc.id));
    docId = existingDoc.id;
  } else {
    const [d] = await db.insert(docs).values({
      workspaceId, folderId, projectId, path: docPath, title, type: 'doc',
      markdown: md, yjsState: emptyYjsState(), contentHash: contentHash(md),
    }).returning({ id: docs.id });
    docId = d!.id;
  }

  // ── Temporal decision node (idempotent upsert) ──
  const [node] = await db.insert(graphNodes).values({
    workspaceId, entityType: 'decision', entityId,
    label: shortTitle(decisionText), summary: decisionText.slice(0, 500),
    projectId, extractionPass: 'structural',
    decidedAt, status, decisionText, decidedIn: input.decidedIn ?? null, aclScope,
  }).onConflictDoUpdate({
    target: [graphNodes.workspaceId, graphNodes.entityType, graphNodes.entityId],
    // re-record = refresh content only; PRESERVE temporal state (decidedAt/status/supersede links)
    set: { label: shortTitle(decisionText), summary: decisionText.slice(0, 500), decisionText, aclScope, updatedAt: new Date() },
  }).returning({ id: graphNodes.id });
  const nodeId = node!.id;

  // ── Supersede-by-invalidation (keep-both-and-link) ──
  let supersededOldId: string | undefined;
  if (input.supersedes) {
    const oldId = input.supersedes;
    await db.update(graphNodes).set({ supersedes: oldId, status: 'current', updatedAt: new Date() }).where(eq(graphNodes.id, nodeId));
    await db.update(graphNodes).set({ supersededBy: nodeId, status: 'historical', updatedAt: new Date() }).where(eq(graphNodes.id, oldId));
    await db.insert(graphEdges).values({
      workspaceId, fromNodeId: nodeId, toNodeId: oldId, edgeType: 'supersedes',
      provenance: 'EXTRACTED', confidenceScore: 1.0, weight: 1.5,
    }).onConflictDoNothing();
    supersededOldId = oldId;
  }

  // umbrella-connect sooner than the nightly cron (best-effort; lag is acceptable either way).
  try { enqueueExtractDoc(workspaceId, docId); } catch { /* queue optional */ }

  return { nodeId, docId, entityId, status, supersededOldId };
}
