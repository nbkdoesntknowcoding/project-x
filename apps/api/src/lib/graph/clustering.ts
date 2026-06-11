/**
 * Louvain clustering + betweenness centrality + god-nodes + community labelling.
 */

import OpenAI from 'openai';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import betweennessCentrality from 'graphology-metrics/centrality/betweenness.js';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../db/schema.js';

const { graphNodes, graphEdges, graphCommunities } = schema;

type Tx = NodePgDatabase<typeof schema>;

// ── community labelling ───────────────────────────────────────────────────────

async function labelCommunity(
  nodeLabels: string[],
): Promise<{ label: string; description: string; suggested_questions: string[] }> {
  if (!process.env.OPENAI_API_KEY) {
    return { label: 'Unnamed cluster', description: '', suggested_questions: [] };
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Given these knowledge graph nodes in a cluster, provide a concise label and description.

Nodes: ${nodeLabels.slice(0, 15).join(', ')}

Return ONLY valid JSON:
{
  "label": "2-4 word theme",
  "description": "2 sentences describing what this cluster represents",
  "suggested_questions": ["Q1", "Q2", "Q3", "Q4"]
}`,
      },
    ],
  });

  const text = response.choices[0]?.message?.content ?? '';

  try {
    const m = text.match(/\{[\s\S]*\}/);
    return JSON.parse(m?.[0] ?? text) as { label: string; description: string; suggested_questions: string[] };
  } catch {
    return { label: 'Cluster', description: text.slice(0, 200), suggested_questions: [] };
  }
}

// ── main export ───────────────────────────────────────────────────────────────

export async function runClustering(
  workspaceId: string,
  resolution = 1.0,
  db: Tx,
): Promise<{
  communityCount: number;
  godNodeIds: string[];
  communities: Record<string, number>;
  betweenness: Record<string, number>;
}> {
  const [nodes, edges] = await Promise.all([
    db.select().from(graphNodes).where(eq(graphNodes.workspaceId, workspaceId)),
    db.select().from(graphEdges).where(eq(graphEdges.workspaceId, workspaceId)),
  ]);

  if (nodes.length === 0) {
    return { communityCount: 0, godNodeIds: [], communities: {}, betweenness: {} };
  }

  const graph = new Graph({ multi: false, type: 'mixed' });

  for (const n of nodes) {
    graph.addNode(n.id, { label: n.label, entityType: n.entityType });
  }

  for (const e of edges) {
    if (e.provenance === 'AMBIGUOUS') continue; // skip noisy edges
    if (
      graph.hasNode(e.fromNodeId) &&
      graph.hasNode(e.toNodeId) &&
      !graph.hasEdge(e.fromNodeId, e.toNodeId)
    ) {
      try {
        graph.addEdge(e.fromNodeId, e.toNodeId, { weight: e.weight ?? 1.0 });
      } catch {
        // ignore duplicate edge errors (multi=false)
      }
    }
  }

  // Louvain clustering
  const communities = louvain(graph, { getEdgeWeight: 'weight', randomWalk: false }) as Record<string, number>;

  // Betweenness centrality
  const betweenness = betweennessCentrality(graph, { normalized: true }) as Record<string, number>;

  // God-nodes: top 5% by betweenness (max 20)
  const scores = Object.values(betweenness).sort((a, b) => a - b);
  const godThreshold = scores[Math.floor(scores.length * 0.95)] ?? 0;
  const godNodeIds = Object.entries(betweenness)
    .filter(([, v]) => v >= godThreshold)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([id]) => id);

  // Apply to DB in batches of 100
  const entries = Object.entries(communities);
  for (let i = 0; i < entries.length; i += 100) {
    const batch = entries.slice(i, i + 100);
    for (const [nodeId, communityId] of batch) {
      await db
        .update(graphNodes)
        .set({
          communityId,
          betweennessCentrality: betweenness[nodeId] ?? 0,
          degree: graph.degree(nodeId) ?? 0,
          isGodNode: godNodeIds.includes(nodeId),
          updatedAt: new Date(),
        })
        .where(eq(graphNodes.id, nodeId));
    }
  }

  // Build community groups for labelling
  const communityGroups = new Map<number, string[]>(); // communityId → node labels
  for (const [nodeId, communityId] of entries) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) continue;
    if (!communityGroups.has(communityId)) communityGroups.set(communityId, []);
    communityGroups.get(communityId)!.push(node.label);
  }

  // Label communities (parallel Haiku calls, max 5 at a time)
  const communityIds = [...communityGroups.keys()];
  const communityCount = communityIds.length;

  for (let i = 0; i < communityIds.length; i += 5) {
    const batch = communityIds.slice(i, i + 5);
    await Promise.all(
      batch.map(async (communityId) => {
        const nodeLabels = communityGroups.get(communityId) ?? [];
        const info = await labelCommunity(nodeLabels);
        const nodeCount = nodeLabels.length;

        // Upsert community record
        await db
          .insert(graphCommunities)
          .values({
            id: communityId,
            workspaceId,
            label: info.label,
            description: info.description,
            nodeCount,
            suggestedQuestions: info.suggested_questions,
          })
          .onConflictDoUpdate({
            target: [graphCommunities.id, graphCommunities.workspaceId],
            set: {
              label: info.label,
              description: info.description,
              nodeCount,
              suggestedQuestions: info.suggested_questions,
            },
          });

        // Update communityLabel on each node in this community
        for (const [nodeId, cId] of entries) {
          if (cId === communityId) {
            await db
              .update(graphNodes)
              .set({ communityLabel: info.label })
              .where(eq(graphNodes.id, nodeId));
          }
        }
      }),
    );
  }

  return { communityCount, godNodeIds, communities, betweenness };
}
