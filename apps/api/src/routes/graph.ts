import { and, desc, eq, inArray, sql, or } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import Graph from 'graphology';
import { bidirectional } from 'graphology-shortest-path/unweighted.js';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { withTenant } from '../db/with-tenant.js';
import { enqueueFullBuild } from '../queue/graph.js';

const { graphNodes, graphEdges, graphCommunities, graphReports } = schema;

export const graphRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /api/graph/nodes ────────────────────────────────────────────────────
  app.get('/api/graph/nodes', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    const { type, isGodNode, communityId, limit = '50', cursor } = req.query as Record<string, string>;

    const nodes = await withTenant(req.auth.tenant_id, (tx) => {
      const conditions = [eq(graphNodes.workspaceId, req.auth!.tenant_id)];
      if (type) conditions.push(eq(graphNodes.entityType, type));
      if (isGodNode === 'true') conditions.push(eq(graphNodes.isGodNode, true));
      if (communityId) conditions.push(eq(graphNodes.communityId, parseInt(communityId)));

      return tx
        .select()
        .from(graphNodes)
        .where(and(...conditions))
        .orderBy(desc(graphNodes.degree))
        .limit(Math.min(parseInt(limit) || 50, 200));
    });

    return reply.send({ nodes });
  });

  // ── GET /api/graph/nodes/:id/connections ────────────────────────────────────
  app.get('/api/graph/nodes/:id/connections', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    const { id } = req.params as { id: string };
    const { direction = 'both' } = req.query as { direction?: string };

    const conditions = [eq(graphEdges.workspaceId, req.auth.tenant_id)];
    if (direction === 'out' || direction === 'both') {
      conditions.push(eq(graphEdges.fromNodeId, id));
    }

    const outEdges = direction !== 'in'
      ? await withTenant(req.auth.tenant_id, tx =>
          tx.select().from(graphEdges).where(and(eq(graphEdges.workspaceId, req.auth!.tenant_id), eq(graphEdges.fromNodeId, id))))
      : [];

    const inEdges = direction !== 'out'
      ? await withTenant(req.auth.tenant_id, tx =>
          tx.select().from(graphEdges).where(and(eq(graphEdges.workspaceId, req.auth!.tenant_id), eq(graphEdges.toNodeId, id))))
      : [];

    const edges = [...outEdges, ...inEdges];
    const neighborIds = [...new Set(edges.map(e => e.fromNodeId === id ? e.toNodeId : e.fromNodeId))];

    const neighbors = neighborIds.length > 0
      ? await withTenant(req.auth.tenant_id, tx =>
          tx.select().from(graphNodes).where(and(eq(graphNodes.workspaceId, req.auth!.tenant_id), inArray(graphNodes.id, neighborIds))))
      : [];

    const [node] = await withTenant(req.auth.tenant_id, tx =>
      tx.select().from(graphNodes).where(and(eq(graphNodes.workspaceId, req.auth!.tenant_id), eq(graphNodes.id, id))).limit(1));

    return reply.send({ node, neighbors, edges });
  });

  // ── GET /api/graph/traverse ─────────────────────────────────────────────────
  app.get('/api/graph/traverse', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    const { from, to, maxDepth = '5' } = req.query as { from?: string; to?: string; maxDepth?: string };
    if (!from) return reply.status(400).send({ error: 'from is required' });

    // Resolve by label if not UUID
    const resolveNode = async (labelOrId: string) => {
      const uuidRegex = /^[0-9a-f-]{36}$/i;
      if (uuidRegex.test(labelOrId)) {
        const [n] = await withTenant(req.auth!.tenant_id, tx =>
          tx.select().from(graphNodes).where(and(eq(graphNodes.workspaceId, req.auth!.tenant_id), eq(graphNodes.id, labelOrId))).limit(1));
        return n ?? null;
      }
      const [n] = await withTenant(req.auth!.tenant_id, tx =>
        tx.select().from(graphNodes).where(and(eq(graphNodes.workspaceId, req.auth!.tenant_id), sql`lower(${graphNodes.label}) = lower(${labelOrId})`)).limit(1));
      return n ?? null;
    };

    const fromNode = await resolveNode(from);
    if (!fromNode) return reply.status(404).send({ error: 'from node not found' });

    // 1-hop neighborhood if no 'to'
    if (!to) {
      const edges = await withTenant(req.auth.tenant_id, tx =>
        tx.select().from(graphEdges).where(and(
          eq(graphEdges.workspaceId, req.auth!.tenant_id),
          or(eq(graphEdges.fromNodeId, fromNode.id), eq(graphEdges.toNodeId, fromNode.id)),
        )));
      const neighborIds = [...new Set(edges.map(e => e.fromNodeId === fromNode.id ? e.toNodeId : e.fromNodeId))];
      const neighbors = neighborIds.length > 0
        ? await withTenant(req.auth.tenant_id, tx =>
            tx.select().from(graphNodes).where(and(eq(graphNodes.workspaceId, req.auth!.tenant_id), inArray(graphNodes.id, neighborIds))))
        : [];
      return reply.send({ nodes: [fromNode, ...neighbors], edges, highlightedPath: [], hopCount: 1 });
    }

    const toNode = await resolveNode(to);
    if (!toNode) return reply.status(404).send({ error: 'to node not found' });

    // BFS shortest path
    const allNodes = await withTenant(req.auth.tenant_id, tx =>
      tx.select().from(graphNodes).where(eq(graphNodes.workspaceId, req.auth!.tenant_id)));
    const allEdges = await withTenant(req.auth.tenant_id, tx =>
      tx.select().from(graphEdges).where(eq(graphEdges.workspaceId, req.auth!.tenant_id)));

    const graph = new Graph({ multi: false, type: 'mixed' });
    for (const n of allNodes) graph.addNode(n.id);
    for (const e of allEdges) {
      if (!graph.hasEdge(e.fromNodeId, e.toNodeId) && graph.hasNode(e.fromNodeId) && graph.hasNode(e.toNodeId)) {
        try { graph.addEdge(e.fromNodeId, e.toNodeId); } catch { /* ignore */ }
      }
    }

    const path = bidirectional(graph, fromNode.id, toNode.id) ?? [];
    const pathSet = new Set(path);
    const pathEdges = allEdges.filter(e => pathSet.has(e.fromNodeId) && pathSet.has(e.toNodeId));
    const pathNodes = allNodes.filter(n => pathSet.has(n.id));

    const communities = await withTenant(req.auth.tenant_id, tx =>
      tx.select().from(graphCommunities).where(eq(graphCommunities.workspaceId, req.auth!.tenant_id)));
    const godNodes = allNodes.filter(n => n.isGodNode).map(n => n.id);

    return reply.send({
      nodes: pathNodes,
      edges: pathEdges,
      highlightedPath: path,
      hopCount: path.length > 0 ? path.length - 1 : 0,
      communities: communities.map(c => ({ id: c.id, label: c.label })),
      godNodes,
      query: { from: fromNode.label, to: toNode.label },
    });
  });

  // ── GET /api/graph/god-nodes ────────────────────────────────────────────────
  app.get('/api/graph/god-nodes', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });

    const nodes = await withTenant(req.auth.tenant_id, tx =>
      tx.select().from(graphNodes).where(and(
        eq(graphNodes.workspaceId, req.auth!.tenant_id),
        eq(graphNodes.isGodNode, true),
      )).orderBy(desc(graphNodes.betweennessCentrality)).limit(20));

    // Blast radius per god-node
    const godNodes = await Promise.all(
      nodes.map(async (n) => {
        const [blastRow] = await withTenant(req.auth!.tenant_id, tx =>
          tx.select({ count: sql<number>`count(*)::int` })
            .from(graphEdges)
            .where(and(
              eq(graphEdges.workspaceId, req.auth!.tenant_id),
              eq(graphEdges.toNodeId, n.id),
              sql`${graphEdges.edgeType} IN ('depends_on', 'implements')`,
            )));
        return { ...n, blastRadius: blastRow?.count ?? 0 };
      }),
    );

    return reply.send({ godNodes });
  });

  // ── GET /api/graph/communities ──────────────────────────────────────────────
  app.get('/api/graph/communities', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    const communities = await withTenant(req.auth.tenant_id, tx =>
      tx.select().from(graphCommunities).where(eq(graphCommunities.workspaceId, req.auth!.tenant_id)));
    return reply.send({ communities });
  });

  // ── GET /api/graph/surprising-connections ───────────────────────────────────
  app.get('/api/graph/surprising-connections', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    const { limit = '10' } = req.query as { limit?: string };

    const edges = await withTenant(req.auth.tenant_id, tx =>
      tx.select({
        id:        graphEdges.id,
        edgeType:  graphEdges.edgeType,
        provenance: graphEdges.provenance,
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
        eq(graphEdges.workspaceId, req.auth!.tenant_id),
        eq(graphEdges.provenance, 'INFERRED'),
        sql`fn.entity_type != tn.entity_type`,
      ))
      .orderBy(desc(graphEdges.weight))
      .limit(Math.min(parseInt(limit) || 10, 50)));

    return reply.send({ connections: edges });
  });

  // ── GET /api/graph/full ─────────────────────────────────────────────────────
  app.get('/api/graph/full', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });

    const [nodes, edges, communities] = await Promise.all([
      withTenant(req.auth.tenant_id, tx =>
        tx.select().from(graphNodes).where(eq(graphNodes.workspaceId, req.auth!.tenant_id))
          .orderBy(desc(graphNodes.degree)).limit(500)),
      withTenant(req.auth.tenant_id, tx =>
        tx.select().from(graphEdges).where(eq(graphEdges.workspaceId, req.auth!.tenant_id))),
      withTenant(req.auth.tenant_id, tx =>
        tx.select().from(graphCommunities).where(eq(graphCommunities.workspaceId, req.auth!.tenant_id))),
    ]);

    const nodeIds = new Set(nodes.map(n => n.id));
    const filteredEdges = edges.filter(e => nodeIds.has(e.fromNodeId) && nodeIds.has(e.toNodeId));

    const [reportRow] = await withTenant(req.auth.tenant_id, tx =>
      tx.select().from(graphReports).where(eq(graphReports.workspaceId, req.auth!.tenant_id)).limit(1));

    return reply.send({ nodes, edges: filteredEdges, communities, report: reportRow ?? null });
  });

  // ── POST /api/graph/build ───────────────────────────────────────────────────
  app.post('/api/graph/build', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    enqueueFullBuild(req.auth.tenant_id, 'normal');
    return reply.send({ queued: true, mode: 'normal' });
  });

  // ── POST /api/graph/build/deep ──────────────────────────────────────────────
  app.post('/api/graph/build/deep', async (req, reply) => {
    if (!req.auth) return reply.status(401).send({ error: 'unauthorized' });
    enqueueFullBuild(req.auth.tenant_id, 'deep');
    return reply.send({ queued: true, mode: 'deep' });
  });
};
