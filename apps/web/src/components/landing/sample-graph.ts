// Sample knowledge-graph data for the landing hero, in the SAME shape the real
// /app/graph renders (GraphNode/GraphEdge) so the hero mirrors the actual product
// graph — entity colours, glow nodes, curved filaments, brain-shell background.
// Illustrative content only (two demo projects).
import type { GraphEdge, GraphNode } from '../../lib/graph-types';

type RawNode = Omit<GraphNode, 'degree'>;

const RAW_NODES: RawNode[] = [
  // god nodes — the two projects
  { id: 'p_mnema', label: 'Mnema', entityType: 'project', isGodNode: true },
  { id: 'p_voice', label: 'Voice Clone', entityType: 'project', isGodNode: true },

  // docs
  { id: 'd_arch', label: 'Architecture', entityType: 'doc' },
  { id: 'd_mcp', label: 'MCP read path', entityType: 'doc' },
  { id: 'd_onboard', label: 'Onboarding', entityType: 'doc' },
  { id: 'd_pricing', label: 'Pricing', entityType: 'doc' },
  { id: 'd_latency', label: 'Latency notes', entityType: 'doc' },
  { id: 'd_recall', label: 'Recall integration', entityType: 'doc' },

  // flows
  { id: 'f_onboard', label: 'Onboarding flow', entityType: 'flow' },
  { id: 'f_release', label: 'Release flow', entityType: 'flow' },

  // concepts
  { id: 'c_context', label: 'Context engine', entityType: 'concept' },
  { id: 'c_graph', label: 'Knowledge graph', entityType: 'concept' },
  { id: 'c_stt', label: 'Streaming STT', entityType: 'concept' },

  // a decision + tasks
  { id: 'x_vad', label: 'VAD endpointing', entityType: 'decision' },
  { id: 't_build', label: 'Latest build', entityType: 'task' },
  { id: 't_review', label: 'In review', entityType: 'task' },
];

export const HERO_EDGES: GraphEdge[] = [
  e('p_mnema', 'd_arch', 'EXTRACTED'),
  e('p_mnema', 'd_mcp', 'EXTRACTED'),
  e('p_mnema', 'd_onboard', 'EXTRACTED'),
  e('p_mnema', 'd_pricing', 'EXTRACTED'),
  e('p_mnema', 'f_onboard', 'EXTRACTED'),
  e('p_mnema', 'c_context', 'INFERRED'),
  e('p_mnema', 'c_graph', 'INFERRED'),
  e('d_onboard', 'f_onboard', 'EXTRACTED'),
  e('d_arch', 'd_mcp', 'INFERRED'),
  e('d_arch', 'c_graph', 'INFERRED'),
  e('f_onboard', 't_build', 'EXTRACTED'),
  e('c_context', 'c_graph', 'AMBIGUOUS'),

  e('p_voice', 'd_latency', 'EXTRACTED'),
  e('p_voice', 'd_recall', 'EXTRACTED'),
  e('p_voice', 'c_stt', 'INFERRED'),
  e('p_voice', 'f_release', 'EXTRACTED'),
  e('p_voice', 't_review', 'EXTRACTED'),
  e('d_latency', 'c_stt', 'INFERRED'),
  e('d_latency', 'x_vad', 'EXTRACTED'),
  e('x_vad', 'c_stt', 'INFERRED'),
  e('d_recall', 'x_vad', 'AMBIGUOUS'),
  e('f_release', 't_review', 'EXTRACTED'),
];

// Compute degree from the edge list so node radius matches the real graph.
const degreeOf = new Map<string, number>();
for (const edge of HERO_EDGES) {
  degreeOf.set(edge.fromNodeId, (degreeOf.get(edge.fromNodeId) ?? 0) + 1);
  degreeOf.set(edge.toNodeId, (degreeOf.get(edge.toNodeId) ?? 0) + 1);
}

export const HERO_NODES: GraphNode[] = RAW_NODES.map((n) => ({
  ...n,
  degree: degreeOf.get(n.id) ?? 1,
}));

function e(
  fromNodeId: string,
  toNodeId: string,
  provenance: GraphEdge['provenance'],
): GraphEdge {
  return { fromNodeId, toNodeId, provenance };
}
