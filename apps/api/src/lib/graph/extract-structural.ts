/**
 * Structural extraction (Pass 1) — no LLM.
 * Builds EXTRACTED nodes and edges directly from the Mnema schema.
 * Runs fast: only DB queries, no AI calls.
 */

import { and, eq, isNull, isNotNull, ne } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

const {
  graphNodes, graphEdges,
  docs, flows, flowVersions, flowNodes, flowEdges,
  tasks, projects, folders,
} = schema;

// ── helpers ──────────────────────────────────────────────────────────────────

type Tx = NodePgDatabase<typeof schema>;

async function upsertNode(
  tx: Tx,
  workspaceId: string,
  entityType: string,
  entityId: string,
  label: string,
  summary?: string,
  projectId: string | null = null,
) {
  const existing = await tx
    .select({ id: graphNodes.id })
    .from(graphNodes)
    .where(
      and(
        eq(graphNodes.workspaceId, workspaceId),
        eq(graphNodes.entityType, entityType),
        eq(graphNodes.entityId, entityId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    await tx
      .update(graphNodes)
      .set({ label, summary, projectId, updatedAt: new Date() })
      .where(eq(graphNodes.id, existing[0]!.id));
    return existing[0]!.id;
  }

  const rows = await tx
    .insert(graphNodes)
    .values({ workspaceId, entityType, entityId, label, summary, projectId, extractionPass: 'structural' })
    .returning({ id: graphNodes.id });
  return rows[0]!.id;
}

async function upsertEdge(
  tx: Tx,
  workspaceId: string,
  fromNodeId: string,
  toNodeId: string,
  edgeType: string,
  weight = 1.0,
) {
  await tx
    .insert(graphEdges)
    .values({
      workspaceId,
      fromNodeId,
      toNodeId,
      edgeType,
      provenance: 'EXTRACTED',
      confidenceScore: 1.0,
      weight,
    })
    .onConflictDoNothing();
}

// ── main export ───────────────────────────────────────────────────────────────

export async function extractStructural(
  workspaceId: string,
  db: Tx,
): Promise<{ nodeCount: number; edgeCount: number }> {
  let nodeCount = 0;
  let edgeCount = 0;

  // ── 1. PROJECT nodes ──────────────────────────────────────────────────────
  const projectRows = await db
    .select({ id: projects.id, name: projects.name, description: projects.description })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), ne(projects.status, 'archived')));

  const projectNodeMap = new Map<string, string>(); // projectId → nodeId
  for (const p of projectRows) {
    const nodeId = await upsertNode(db, workspaceId, 'project', p.id, p.name, p.description ?? undefined, p.id);
    projectNodeMap.set(p.id, nodeId);
    nodeCount++;
  }

  // ── 2. DOC nodes ─────────────────────────────────────────────────────────
  const docRows = await db
    .select({
      id: docs.id,
      title: docs.title,
      folderId: docs.folderId,
      projectId: docs.projectId,
    })
    .from(docs)
    .where(and(eq(docs.workspaceId, workspaceId), isNull(docs.deletedAt)));

  const docNodeMap = new Map<string, string>(); // docId → nodeId
  for (const d of docRows) {
    const nodeId = await upsertNode(db, workspaceId, 'doc', d.id, d.title || 'Untitled', undefined, d.projectId ?? null);
    docNodeMap.set(d.id, nodeId);
    nodeCount++;
  }

  // doc → project via folder.projectId
  const folderRows = await db
    .select({ id: folders.id, projectId: folders.projectId })
    .from(folders)
    .where(and(eq(folders.workspaceId, workspaceId), isNull(folders.deletedAt)));

  const folderProjectMap = new Map<string, string | null>();
  for (const f of folderRows) {
    folderProjectMap.set(f.id, f.projectId ?? null);
  }

  for (const d of docRows) {
    if (d.folderId) {
      const projectId = folderProjectMap.get(d.folderId);
      if (projectId) {
        const docNodeId     = docNodeMap.get(d.id);
        const projectNodeId = projectNodeMap.get(projectId);
        if (docNodeId && projectNodeId) {
          await upsertEdge(db, workspaceId, docNodeId, projectNodeId, 'belongs_to');
          edgeCount++;
        }
      }
    }
  }

  // ── 3. FLOW nodes ─────────────────────────────────────────────────────────
  const flowRows = await db
    .select({ id: flows.id, name: flows.name, description: flows.description, publishedVersionId: flows.publishedVersionId })
    .from(flows)
    .where(and(eq(flows.workspaceId, workspaceId), isNull(flows.deletedAt)));

  const flowNodeMap = new Map<string, string>(); // flowId → nodeId
  for (const f of flowRows) {
    const nodeId = await upsertNode(db, workspaceId, 'flow', f.id, f.name, f.description ?? undefined);
    flowNodeMap.set(f.id, nodeId);
    nodeCount++;
  }

  // ── 4. FLOW_STEP nodes (published version only) ────────────────────────────
  // Use each flow's published version; fall back to latest version number.
  const allVersionRows = await db
    .select({ id: flowVersions.id, flowId: flowVersions.flowId, versionNumber: flowVersions.versionNumber })
    .from(flowVersions)
    .where(eq(flowVersions.workspaceId, workspaceId));

  // Build flowId → best versionId: published wins, otherwise highest version
  const flowVersionMap = new Map<string, string>();
  for (const fv of allVersionRows) {
    const flow = flowRows.find(f => f.id === fv.flowId);
    if (!flow) continue;
    if (flow.publishedVersionId === fv.id) {
      flowVersionMap.set(fv.flowId, fv.id); // published wins
    } else if (!flowVersionMap.has(fv.flowId)) {
      flowVersionMap.set(fv.flowId, fv.id);
    } else {
      // keep highest version number as fallback
      const currentId = flowVersionMap.get(fv.flowId)!;
      const currentVer = allVersionRows.find(v => v.id === currentId)?.versionNumber ?? 0;
      if ((fv.versionNumber ?? 0) > currentVer) flowVersionMap.set(fv.flowId, fv.id);
    }
  }

  const selectedVersionIds = [...new Set(flowVersionMap.values())];
  const stepNodeMap = new Map<string, string>(); // clientNodeId-versionId → nodeId

  if (selectedVersionIds.length > 0) {
    for (const versionId of selectedVersionIds) {
      const stepRows = await db
        .select({
          id: flowNodes.id,
          clientNodeId: flowNodes.clientNodeId,
          title: flowNodes.title,
          kind: flowNodes.kind,
          data: flowNodes.data,
          flowVersionId: flowNodes.flowVersionId,
        })
        .from(flowNodes)
        .where(eq(flowNodes.flowVersionId, versionId));

      // Find which flow this version belongs to
      const flowId = [...flowVersionMap.entries()].find(([, vId]) => vId === versionId)?.[0];
      const flowGraphNodeId = flowId ? flowNodeMap.get(flowId) : undefined;

      for (const step of stepRows) {
        const nodeId = await upsertNode(
          db, workspaceId, 'flow_step', step.id,
          step.title || step.kind || 'Step',
        );
        stepNodeMap.set(`${step.clientNodeId}-${versionId}`, nodeId);
        nodeCount++;

        // part_of: flow_step → flow
        if (flowGraphNodeId) {
          await upsertEdge(db, workspaceId, nodeId, flowGraphNodeId, 'part_of');
          edgeCount++;
        }

        // references: flow_step → doc (if data.docId set), weight=1.5
        const data = step.data as Record<string, unknown> | null;
        const docId = (data?.docId ?? data?.doc_id) as string | undefined;
        if (docId && docNodeMap.has(docId)) {
          await upsertEdge(db, workspaceId, nodeId, docNodeMap.get(docId)!, 'references', 1.5);
          edgeCount++;
        }
      }

      // preceded_by: flow_step → next flow_step via flow edges
      const edgeRows = await db
        .select({ fromNodeId: flowEdges.fromNodeId, toNodeId: flowEdges.toNodeId })
        .from(flowEdges)
        .where(eq(flowEdges.flowVersionId, versionId));

      for (const fe of edgeRows) {
        const fromNodeId = stepNodeMap.get(`${fe.fromNodeId}-${versionId}`);
        const toNodeId   = stepNodeMap.get(`${fe.toNodeId}-${versionId}`);
        if (fromNodeId && toNodeId) {
          await upsertEdge(db, workspaceId, fromNodeId, toNodeId, 'preceded_by');
          edgeCount++;
        }
      }
    }
  }

  // ── 5. TASK nodes ─────────────────────────────────────────────────────────
  const taskRows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      docId: tasks.docId,
      projectId: tasks.projectId,
    })
    .from(tasks)
    .where(eq(tasks.workspaceId, workspaceId));

  for (const t of taskRows) {
    const nodeId = await upsertNode(db, workspaceId, 'task', t.id, t.title, undefined, t.projectId ?? null);
    nodeCount++;

    // implements: task → doc, weight=1.5 (cross-type)
    if (t.docId && docNodeMap.has(t.docId)) {
      await upsertEdge(db, workspaceId, nodeId, docNodeMap.get(t.docId)!, 'implements', 1.5);
      edgeCount++;
    }

    // belongs_to: task → project
    if (t.projectId && projectNodeMap.has(t.projectId)) {
      await upsertEdge(db, workspaceId, nodeId, projectNodeMap.get(t.projectId)!, 'belongs_to');
      edgeCount++;
    }
  }

  return { nodeCount, edgeCount };
}
