/**
 * Generates the "📊 Knowledge Graph Report" Mnema doc after each cluster run.
 * Creates or updates in place.
 */

import { and, eq, desc, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';
import { contentHash, emptyYjsState } from '../yjs.js';

const { graphNodes, graphEdges, graphCommunities, graphReports, docs } = schema;

type Tx = NodePgDatabase<typeof schema>;

const REPORT_PATH_PREFIX = '__graph_report__';

export async function generateGraphReport(workspaceId: string, db: Tx): Promise<void> {
  // Stats
  const [nodeCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(graphNodes)
    .where(eq(graphNodes.workspaceId, workspaceId));

  const [edgeCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(graphEdges)
    .where(eq(graphEdges.workspaceId, workspaceId));

  const [extractedRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(graphEdges)
    .where(and(eq(graphEdges.workspaceId, workspaceId), eq(graphEdges.provenance, 'EXTRACTED')));

  const [inferredRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(graphEdges)
    .where(and(eq(graphEdges.workspaceId, workspaceId), eq(graphEdges.provenance, 'INFERRED')));

  const [godNodeCountRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(graphNodes)
    .where(and(eq(graphNodes.workspaceId, workspaceId), eq(graphNodes.isGodNode, true)));

  const communityRows = await db
    .select()
    .from(graphCommunities)
    .where(eq(graphCommunities.workspaceId, workspaceId));

  // Top 10 god-nodes by betweenness
  const godNodes = await db
    .select({
      id: graphNodes.id,
      label: graphNodes.label,
      entityType: graphNodes.entityType,
      degree: graphNodes.degree,
      betweennessCentrality: graphNodes.betweennessCentrality,
    })
    .from(graphNodes)
    .where(and(eq(graphNodes.workspaceId, workspaceId), eq(graphNodes.isGodNode, true)))
    .orderBy(desc(graphNodes.betweennessCentrality))
    .limit(10);

  // Blast radius per god-node
  const godNodeMarkdown = await Promise.all(
    godNodes.map(async (n) => {
      const [blastRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(graphEdges)
        .where(
          and(
            eq(graphEdges.workspaceId, workspaceId),
            eq(graphEdges.toNodeId, n.id),
            sql`${graphEdges.edgeType} IN ('depends_on', 'implements')`,
          ),
        );
      const blast = blastRow?.count ?? 0;
      const pct = ((n.betweennessCentrality ?? 0) * 100).toFixed(1);
      return `- **${n.label}** (${n.entityType}) — degree: ${n.degree}, betweenness: ${pct}%\n  Blast radius: ${blast} nodes depend on this.`;
    }),
  );

  // Surprising connections: top 5 cross-type INFERRED edges
  const surprisingEdges = await db
    .select({
      fromLabel: sql<string>`fn.label`,
      fromType:  sql<string>`fn.entity_type`,
      toLabel:   sql<string>`tn.label`,
      toType:    sql<string>`tn.entity_type`,
      rationale: graphEdges.rationale,
      weight:    graphEdges.weight,
    })
    .from(graphEdges)
    .innerJoin(
      sql`graph_nodes fn`,
      sql`fn.id = ${graphEdges.fromNodeId}`,
    )
    .innerJoin(
      sql`graph_nodes tn`,
      sql`tn.id = ${graphEdges.toNodeId}`,
    )
    .where(
      and(
        eq(graphEdges.workspaceId, workspaceId),
        eq(graphEdges.provenance, 'INFERRED'),
        sql`fn.entity_type != tn.entity_type`,
      ),
    )
    .orderBy(desc(graphEdges.weight))
    .limit(5);

  // Collect suggested questions across all communities
  const allQuestions = communityRows
    .flatMap(c => c.suggestedQuestions ?? [])
    .slice(0, 5);

  const now = new Date().toISOString().slice(0, 10);
  const totalNodes = nodeCountRow?.count ?? 0;
  const totalEdges = edgeCountRow?.count ?? 0;
  const extracted = extractedRow?.count ?? 0;
  const inferred = inferredRow?.count ?? 0;
  const godNodeCount = godNodeCountRow?.count ?? 0;
  const communityCount = communityRows.length;

  const markdown = `# Knowledge Graph Report
*Auto-generated — ${now}*

## Overview
- ${totalNodes} nodes, ${totalEdges} edges (${extracted} extracted, ${inferred} inferred), ${godNodeCount} god-nodes, ${communityCount} communities

## God-Nodes
*The nodes that hold everything together.*

${godNodeMarkdown.join('\n')}

## Communities
${communityRows
  .map(c => {
    const qs = (c.suggestedQuestions ?? []).map((q, i) => `${i + 1}. ${q}`).join('\n');
    return `### ${c.label}\n${c.description ?? ''}\n\nSuggested questions:\n${qs}`;
  })
  .join('\n\n')}

## Surprising Connections
*Cross-type connections ranked by unexpectedness:*

${surprisingEdges
  .map(e => `- **${e.fromLabel}** (${e.fromType}) → **${e.toLabel}** (${e.toType}): ${e.rationale ?? 'inferred connection'}`)
  .join('\n')}

## Questions This Graph Can Answer
${allQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

---
*Read before answering architecture questions about this workspace.*
*Rebuild: use the \`build_knowledge_graph\` MCP tool*
`;

  // Check if report doc already exists
  const existingDocs = await db
    .select({ id: docs.id })
    .from(docs)
    .where(
      and(
        eq(docs.workspaceId, workspaceId),
        sql`${docs.path} like ${REPORT_PATH_PREFIX + '%'}`,
      ),
    )
    .limit(1);

  const yjsState = emptyYjsState();
  const hash = contentHash(markdown);

  if (existingDocs.length > 0) {
    const docId = existingDocs[0]!.id;
    await db
      .update(docs)
      .set({ markdown, contentHash: hash, yjsState, updatedAt: new Date() })
      .where(eq(docs.id, docId));

    // Update graph_reports with docId
    await db
      .update(graphReports)
      .set({
        docId,
        totalNodes,
        totalEdges,
        totalCommunities: communityCount,
        godNodeCount,
        lastBuiltAt: new Date(),
        status: 'ready',
        updatedAt: new Date(),
      })
      .where(eq(graphReports.workspaceId, workspaceId));
  } else {
    const path = `${REPORT_PATH_PREFIX}${workspaceId}.md`;
    const [newDoc] = await db
      .insert(docs)
      .values({
        workspaceId,
        path,
        title: '📊 Knowledge Graph Report',
        markdown,
        yjsState,
        contentHash: hash,
      })
      .returning({ id: docs.id });

    await db
      .insert(graphReports)
      .values({
        workspaceId,
        docId: newDoc?.id,
        totalNodes,
        totalEdges,
        totalCommunities: communityCount,
        godNodeCount,
        lastBuiltAt: new Date(),
        status: 'ready',
      })
      .onConflictDoUpdate({
        target: graphReports.workspaceId,
        set: {
          docId: newDoc?.id,
          totalNodes,
          totalEdges,
          totalCommunities: communityCount,
          godNodeCount,
          lastBuiltAt: new Date(),
          status: 'ready',
          updatedAt: new Date(),
        },
      });
  }
}
