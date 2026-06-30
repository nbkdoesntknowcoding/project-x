/**
 * Knowledge Graph MCP tools — 5 tools, available in both workspace modes.
 *
 * H.1 traverse_graph   — BFS shortest path or 1-hop neighborhood + graph-explorer panel
 * H.2 get_god_nodes    — top god-nodes by betweenness centrality
 * H.3 get_graph_report — returns the GRAPH_REPORT doc content
 * H.4 build_knowledge_graph — enqueues a full-build job
 * H.5 get_surprising_connections — top cross-type INFERRED edges
 */

import { and, asc, desc, eq, or, sql, inArray } from 'drizzle-orm';
import Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path/unweighted.js';
import { db } from '../../db/index.js';
import * as schema from '../../db/schema.js';
import { withTenant } from '../../db/with-tenant.js';
import { enqueueFullBuild } from '../../queue/graph.js';
import type { McpAuthContext } from '../auth.js';

const { graphNodes, graphEdges, graphCommunities, graphReports, docs, embeddings } = schema;

const GRAPH_EXPLORER_URI = 'ui://mnema/graph-explorer.html';

// ── shared helper ─────────────────────────────────────────────────────────────

async function resolveNodeByLabelOrId(
  workspaceId: string,
  labelOrId: string,
) {
  const uuidRegex = /^[0-9a-f-]{36}$/i;
  if (uuidRegex.test(labelOrId)) {
    const [n] = await withTenant(workspaceId, tx =>
      tx.select().from(graphNodes)
        .where(and(eq(graphNodes.workspaceId, workspaceId), eq(graphNodes.id, labelOrId)))
        .limit(1));
    return n ?? null;
  }
  const [n] = await withTenant(workspaceId, tx =>
    tx.select().from(graphNodes)
      .where(and(eq(graphNodes.workspaceId, workspaceId), sql`lower(${graphNodes.label}) = lower(${labelOrId})`))
      .limit(1));
  return n ?? null;
}

// ── H.1 traverse_graph ────────────────────────────────────────────────────────

export const TRAVERSE_GRAPH_TOOL_SPEC = {
  name: 'traverse_graph',
  description: [
    'Traverse the knowledge graph to find connections between concepts, docs, tasks, or flows.',
    '',
    'If "to" is provided: finds the shortest path between two nodes (BFS).',
    'If "to" is omitted: returns the 1-hop neighborhood of the "from" node.',
    '',
    '"from" and "to" can be a node label (e.g. "Billing Flow") or UUID.',
    'Depth defaults to 5 hops.',
    '',
    'Opens the interactive graph-explorer panel showing the path or neighborhood.',
    'Use this to answer questions like "What connects X to Y?" or "What depends on X?"',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      from:  { type: 'string', description: 'Start node label or UUID' },
      to:    { type: 'string', description: 'End node label or UUID (optional — omit for neighborhood)' },
      depth: { type: 'number', minimum: 1, maximum: 10, description: 'Max traversal depth (default 5)' },
    },
    required: ['from'],
  },
  annotations: { readOnlyHint: true, title: 'Traverse the knowledge graph' },
};

export async function traverseGraph(
  ctx: McpAuthContext,
  args: Record<string, unknown>,
): Promise<{ content: string; structuredContent: Record<string, unknown> }> {
  const from = String(args.from ?? '');
  const to   = args.to ? String(args.to) : undefined;
  const workspaceId = ctx.tenant_id;

  const fromNode = await resolveNodeByLabelOrId(workspaceId, from);
  if (!fromNode) {
    return {
      content: `Node not found: "${from}"`,
      structuredContent: { error: 'not_found', from },
    };
  }

  if (!to) {
    // 1-hop neighborhood
    const edges = await withTenant(workspaceId, tx =>
      tx.select().from(graphEdges).where(and(
        eq(graphEdges.workspaceId, workspaceId),
        or(eq(graphEdges.fromNodeId, fromNode.id), eq(graphEdges.toNodeId, fromNode.id)),
      )));
    const neighborIds = [...new Set(edges.map(e => e.fromNodeId === fromNode.id ? e.toNodeId : e.fromNodeId))];
    const neighbors = neighborIds.length > 0
      ? await withTenant(workspaceId, tx =>
          tx.select().from(graphNodes)
            .where(and(eq(graphNodes.workspaceId, workspaceId), inArray(graphNodes.id, neighborIds))))
      : [];

    const content = [
      `**Neighborhood of "${fromNode.label}"** (${fromNode.entityType})`,
      `${edges.length} connections to ${neighbors.length} nodes:`,
      ...edges.slice(0, 20).map(e => {
        const neighbor = neighbors.find(n => n.id === (e.fromNodeId === fromNode.id ? e.toNodeId : e.fromNodeId));
        const dir = e.fromNodeId === fromNode.id ? '→' : '←';
        return `  ${dir} ${e.edgeType} → ${neighbor?.label ?? e.toNodeId} (${neighbor?.entityType ?? '?'})`;
      }),
    ].join('\n');

    return {
      content,
      structuredContent: {
        nodes: [fromNode, ...neighbors],
        edges,
        highlightedPath: [],
        communities: [],
        godNodes: neighbors.filter(n => n.isGodNode).map(n => n.id),
        query: { from: fromNode.label, to: null, depth: 1 },
      },
    };
  }

  // BFS shortest path
  const toNode = await resolveNodeByLabelOrId(workspaceId, to);
  if (!toNode) {
    return {
      content: `Node not found: "${to}"`,
      structuredContent: { error: 'not_found', to },
    };
  }

  const [allNodes, allEdges] = await Promise.all([
    withTenant(workspaceId, tx => tx.select().from(graphNodes).where(eq(graphNodes.workspaceId, workspaceId))),
    withTenant(workspaceId, tx => tx.select().from(graphEdges).where(eq(graphEdges.workspaceId, workspaceId))),
  ]);

  const graph = new Graph({ multi: false, type: 'mixed' });
  for (const n of allNodes) graph.addNode(n.id);
  for (const e of allEdges) {
    if (graph.hasNode(e.fromNodeId) && graph.hasNode(e.toNodeId) && !graph.hasEdge(e.fromNodeId, e.toNodeId)) {
      try { graph.addEdge(e.fromNodeId, e.toNodeId); } catch { /* ignore */ }
    }
  }

  const path = bidirectional(graph, fromNode.id, toNode.id) ?? [];
  const pathSet = new Set(path);
  const pathNodes = allNodes.filter(n => pathSet.has(n.id));
  const pathEdges = allEdges.filter(e => pathSet.has(e.fromNodeId) && pathSet.has(e.toNodeId));
  const communities = await withTenant(workspaceId, tx =>
    tx.select().from(graphCommunities).where(eq(graphCommunities.workspaceId, workspaceId)));
  const godNodes = allNodes.filter(n => n.isGodNode).map(n => n.id);

  const hopCount = path.length > 0 ? path.length - 1 : 0;

  let content: string;
  if (path.length === 0) {
    content = `No path found between "${fromNode.label}" and "${toNode.label}".`;
  } else {
    const pathLabels = path.map(id => pathNodes.find(n => n.id === id)?.label ?? id);
    content = [
      `**Traversal: "${fromNode.label}" → "${toNode.label}" (${hopCount} hop${hopCount !== 1 ? 's' : ''})**`,
      `Path: ${pathLabels.join(' → ')}`,
    ].join('\n');
  }

  return {
    content,
    structuredContent: {
      nodes: pathNodes,
      edges: pathEdges,
      highlightedPath: path,
      hopCount,
      communities: communities.map(c => ({ id: c.id, label: c.label })),
      godNodes,
      query: { from: fromNode.label, to: toNode.label, depth: hopCount },
    },
  };
}

// ── H.2 get_god_nodes ─────────────────────────────────────────────────────────

export const GET_GOD_NODES_TOOL_SPEC = {
  name: 'get_god_nodes',
  description: [
    'Returns the top "god-nodes" in the knowledge graph — nodes with the highest betweenness centrality.',
    'God-nodes are the concepts, docs, or flows that everything else depends on.',
    'Includes degree, betweenness %, and blast radius (number of nodes that depend on each).',
    'Opens the graph-explorer panel.',
    '',
    'Use this when the user asks what is most central, critical, or load-bearing in the',
    'workspace, or what everything depends on. Consult get_graph_report first for the',
    'overview; use this for the ranked critical-nodes slice.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: { type: 'number', minimum: 1, maximum: 20, description: 'Max results (default 10)' },
      project_id: { type: 'string', description: 'Optional project UUID — restrict to that project.' },
    },
  },
  annotations: { readOnlyHint: true, title: 'Get the most critical nodes in the knowledge graph' },
};

export async function getGodNodes(
  ctx: McpAuthContext,
  args: Record<string, unknown>,
): Promise<{ content: string; structuredContent: Record<string, unknown> }> {
  const limit = Math.min(Number(args.limit ?? 10), 20);
  const workspaceId = ctx.tenant_id;
  const projectId = typeof args.project_id === 'string' ? args.project_id : undefined;

  const nodes = await withTenant(workspaceId, tx =>
    tx.select().from(graphNodes)
      .where(and(
        eq(graphNodes.workspaceId, workspaceId),
        eq(graphNodes.isGodNode, true),
        projectId ? eq(graphNodes.projectId, projectId) : undefined,
      ))
      .orderBy(desc(graphNodes.betweennessCentrality))
      .limit(limit));

  const godNodes = await Promise.all(
    nodes.map(async (n) => {
      const [blastRow] = await withTenant(workspaceId, tx =>
        tx.select({ count: sql<number>`count(*)::int` })
          .from(graphEdges)
          .where(and(
            eq(graphEdges.workspaceId, workspaceId),
            eq(graphEdges.toNodeId, n.id),
            sql`${graphEdges.edgeType} IN ('depends_on', 'implements')`,
          )));
      return { ...n, blastRadius: blastRow?.count ?? 0 };
    }),
  );

  const lines = godNodes.map((n, i) => {
    const pct = ((n.betweennessCentrality ?? 0) * 100).toFixed(1);
    return `${i + 1}. **${n.label}** (${n.entityType}) — degree: ${n.degree}, betweenness: ${pct}%, blast radius: ${n.blastRadius}`;
  });

  return {
    content: `**God-Nodes** (top ${godNodes.length} by betweenness centrality):\n\n${lines.join('\n')}`,
    structuredContent: { godNodes },
  };
}

// ── H.3 get_graph_report ──────────────────────────────────────────────────────

export const GET_GRAPH_REPORT_TOOL_SPEC = {
  name: 'get_graph_report',
  description: [
    'Returns the Knowledge Graph Report — an auto-generated overview of all graph stats,',
    'god-nodes, community clusters, surprising connections, and suggested questions.',
    'Read this before answering architecture questions about this workspace.',
    'Rebuild the graph first with build_knowledge_graph if it seems stale.',
  ].join('\n'),
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true, title: 'Get the Knowledge Graph Report' },
};

export async function getGraphReport(
  ctx: McpAuthContext,
  _args: Record<string, unknown>,
): Promise<{ content: string; structuredContent: Record<string, unknown> }> {
  const workspaceId = ctx.tenant_id;

  const [reportRow] = await withTenant(workspaceId, tx =>
    tx.select().from(graphReports).where(eq(graphReports.workspaceId, workspaceId)).limit(1));

  if (!reportRow) {
    return {
      content: 'No knowledge graph report found. Use build_knowledge_graph to generate one.',
      structuredContent: { status: 'not_found' },
    };
  }

  if (reportRow.status !== 'ready') {
    return {
      content: `Knowledge graph is currently ${reportRow.status}. Try again in a moment.`,
      structuredContent: { status: reportRow.status },
    };
  }

  let markdown = '';
  if (reportRow.docId) {
    const [docRow] = await withTenant(workspaceId, tx =>
      tx.select({ markdown: docs.markdown }).from(docs).where(eq(docs.id, reportRow.docId!)).limit(1));
    markdown = docRow?.markdown ?? '';
  }

  const communities = await withTenant(workspaceId, tx =>
    tx.select().from(graphCommunities).where(eq(graphCommunities.workspaceId, workspaceId)));
  const suggestedQuestions = communities.flatMap(c => c.suggestedQuestions ?? []).slice(0, 5);

  return {
    content: markdown || 'Graph report exists but has no content yet.',
    structuredContent: {
      reportDocId: reportRow.docId,
      totalNodes: reportRow.totalNodes,
      totalEdges: reportRow.totalEdges,
      totalCommunities: reportRow.totalCommunities,
      godNodeCount: reportRow.godNodeCount,
      lastBuiltAt: reportRow.lastBuiltAt,
      communities: communities.map(c => ({ id: c.id, label: c.label, description: c.description })),
      suggestedQuestions,
    },
  };
}

// ── H.4 build_knowledge_graph ─────────────────────────────────────────────────

export const BUILD_KNOWLEDGE_GRAPH_TOOL_SPEC = {
  name: 'build_knowledge_graph',
  description: [
    'Enqueues a full knowledge graph rebuild for this workspace.',
    'Use "normal" mode (default) for Claude Haiku extraction.',
    'Use "deep" mode for Claude Sonnet — slower but higher quality.',
    'The graph is rebuilt in the background; check get_graph_report for results.',
    '',
    'Use this when get_graph_report looks stale or after a large ingest of new docs,',
    'to rebuild before answering architecture questions about this workspace.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      mode: { type: 'string', enum: ['normal', 'deep'], description: '"normal" (Haiku, default) or "deep" (Sonnet)' },
    },
  },
  annotations: { readOnlyHint: false, title: 'Rebuild the knowledge graph' },
};

export async function buildKnowledgeGraph(
  ctx: McpAuthContext,
  args: Record<string, unknown>,
): Promise<{ content: string; structuredContent: Record<string, unknown> }> {
  const mode = (args.mode === 'deep' ? 'deep' : 'normal') as 'normal' | 'deep';
  enqueueFullBuild(ctx.tenant_id, mode);
  return {
    content: `Knowledge graph build queued (mode: ${mode}). Check get_graph_report in a few minutes for results.`,
    structuredContent: { queued: true, mode },
  };
}

// ── H.5 get_surprising_connections ───────────────────────────────────────────

export const GET_SURPRISING_CONNECTIONS_TOOL_SPEC = {
  name: 'get_surprising_connections',
  description: [
    'Returns the most surprising cross-type INFERRED connections in the knowledge graph.',
    'These are unexpected relationships between different entity types',
    '(e.g. a doc connected to a flow step, or a task linked to a concept).',
    'Sorted by edge weight descending — higher weight = more confident / more surprising.',
    '',
    'Use this when the user asks for non-obvious links, unexpected relationships, or what',
    'connects across areas they would not expect. Use get_graph_report for the general',
    'overview; this for the surprising cross-type slice.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: { type: 'number', minimum: 1, maximum: 50, description: 'Max results (default 10)' },
    },
  },
  annotations: { readOnlyHint: true, title: 'Get surprising cross-type connections' },
};

export async function getSurprisingConnections(
  ctx: McpAuthContext,
  args: Record<string, unknown>,
): Promise<{ content: string; structuredContent: Record<string, unknown> }> {
  const limit = Math.min(Number(args.limit ?? 10), 50);
  const workspaceId = ctx.tenant_id;

  const connections = await withTenant(workspaceId, tx =>
    tx.select({
      edgeType:  graphEdges.edgeType,
      weight:    graphEdges.weight,
      rationale: graphEdges.rationale,
      fromLabel: sql<string>`fn.label`,
      fromType:  sql<string>`fn.entity_type`,
      toLabel:   sql<string>`tn.label`,
      toType:    sql<string>`tn.entity_type`,
    })
    .from(graphEdges)
    .innerJoin(sql`graph_nodes fn`, sql`fn.id = ${graphEdges.fromNodeId}`)
    .innerJoin(sql`graph_nodes tn`, sql`tn.id = ${graphEdges.toNodeId}`)
    .where(and(
      eq(graphEdges.workspaceId, workspaceId),
      eq(graphEdges.provenance, 'INFERRED'),
      sql`fn.entity_type != tn.entity_type`,
    ))
    .orderBy(desc(graphEdges.weight))
    .limit(limit));

  const lines = connections.map((c, i) =>
    `${i + 1}. **${c.fromLabel}** (${c.fromType}) → ${c.edgeType} → **${c.toLabel}** (${c.toType})\n   _${c.rationale ?? 'inferred connection'}_`,
  );

  return {
    content: `**Surprising Connections** (${connections.length} cross-type INFERRED edges):\n\n${lines.join('\n\n')}`,
    structuredContent: { connections },
  };
}

// ── H.6 get_concept_context (A2.3 concept hydration) ──────────────────────────

export const GET_CONCEPT_CONTEXT_TOOL_SPEC = {
  name: 'get_concept_context',
  description: [
    'Hydrate a concept (or any node) into CONCRETE source text: resolves the node, follows',
    'it to the documents it connects to in the graph, and returns the actual matched chunk',
    'text from each — not just "this topic exists". Use when someone asks what a concept,',
    'decision, or topic actually says/means and you want grounded detail to answer from.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      concept: { type: 'string', description: 'Concept/node label or UUID to hydrate' },
      limit:   { type: 'number', description: 'Max source docs to pull text from (default 3, max 6)' },
    },
    required: ['concept'],
  },
  annotations: { readOnlyHint: true, title: 'Hydrate a concept into source document text' },
};

export async function getConceptContext(
  ctx: McpAuthContext,
  args: Record<string, unknown>,
): Promise<{ content: string; structuredContent: Record<string, unknown> }> {
  const conceptArg = String(args.concept ?? args.from ?? '');
  const maxDocs = Math.min(Math.max(Number(args.limit ?? 3), 1), 6);
  const workspaceId = ctx.tenant_id;

  const node = await resolveNodeByLabelOrId(workspaceId, conceptArg);
  if (!node) {
    return { content: `Concept not found: "${conceptArg}"`, structuredContent: { error: 'not_found', concept: conceptArg } };
  }

  // 1-hop neighbours → keep doc nodes (the concept→doc hop). A doc node's entityId is the doc UUID.
  const edges = await withTenant(workspaceId, tx =>
    tx.select().from(graphEdges).where(and(
      eq(graphEdges.workspaceId, workspaceId),
      or(eq(graphEdges.fromNodeId, node.id), eq(graphEdges.toNodeId, node.id)),
    )));
  const neighborIds = [...new Set(edges.map(e => e.fromNodeId === node.id ? e.toNodeId : e.fromNodeId))];
  const docNodes = neighborIds.length > 0
    ? await withTenant(workspaceId, tx =>
        tx.select().from(graphNodes).where(and(
          eq(graphNodes.workspaceId, workspaceId),
          inArray(graphNodes.id, neighborIds),
          eq(graphNodes.entityType, 'doc'),
        )))
    : [];
  // If the node itself is a doc, hydrate it directly too.
  if (node.entityType === 'doc') docNodes.unshift(node);

  const docIds = [...new Set(docNodes.map(d => d.entityId))].slice(0, maxDocs);

  // doc → embeddings.chunkText: prefer the chunk that mentions the concept, else the first chunk.
  const blocks: string[] = [];
  const hydrated: Array<Record<string, unknown>> = [];
  for (const docId of docIds) {
    const docNode = docNodes.find(d => d.entityId === docId);
    const chunks = await withTenant(workspaceId, tx =>
      tx.select({ chunkText: embeddings.chunkText, chunkIndex: embeddings.chunkIndex, headingPath: embeddings.headingPath })
        .from(embeddings)
        .where(and(eq(embeddings.workspaceId, workspaceId), eq(embeddings.docId, docId)))
        .orderBy(sql`(${embeddings.chunkText} ILIKE ${'%' + node.label + '%'}) DESC`, asc(embeddings.chunkIndex))
        .limit(1));
    const chunk = chunks[0];
    if (!chunk) continue;
    const head = `${docNode?.label ?? docId}${chunk.headingPath ? ` › ${chunk.headingPath}` : ''}`;
    blocks.push(`[doc: ${head}]\n${chunk.chunkText.slice(0, 800)}`);
    hydrated.push({ docId, title: docNode?.label ?? null, chunkIndex: chunk.chunkIndex, headingPath: chunk.headingPath ?? null });
  }

  const summary = node.summary ? `${node.summary}\n\n` : '';
  const content = blocks.length > 0
    ? `**Concept context — "${node.label}" (${node.entityType})**\n\n${summary}${blocks.join('\n\n---\n\n')}`
    : `**"${node.label}"** (${node.entityType})${node.summary ? ` — ${node.summary}` : ''}\n\n(No source document text is linked to this concept yet.)`;

  return {
    content,
    structuredContent: {
      concept: { id: node.id, label: node.label, type: node.entityType, summary: node.summary },
      docs: hydrated,
    },
  };
}
