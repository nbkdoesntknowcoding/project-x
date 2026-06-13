import * as THREE from 'three';

export const ENTITY_LABELS: Record<string, string> = {
  doc:       '📄 Document',
  flow:      '⑂ Workflow',
  flow_step: '→ Workflow Step',
  task:      '✓ Task',
  concept:   '◇ Concept',
  decision:  '⚖ Decision',
  project:   '◎ Project',
  rationale: '💡 Why Note',
  session:   '⚡ Agent Session',
};

export const ENTITY_COLORS_HEX: Record<string, number> = {
  doc:       0x60a5fa,
  flow:      0xfbbf24,
  flow_step: 0xd97706,
  task:      0x4ade80,
  concept:   0xa78bfa,
  decision:  0xf0997b,
  project:   0xe879f9,
  rationale: 0xfb7185,
  session:   0x94a3b8,
};

export const ENTITY_COLORS_CSS: Record<string, string> = {
  doc:       '#60a5fa',
  flow:      '#fbbf24',
  flow_step: '#d97706',
  task:      '#4ade80',
  concept:   '#a78bfa',
  decision:  '#f0997b',
  project:   '#e879f9',
  rationale: '#fb7185',
  session:   '#94a3b8',
};

export const SHAPE_ICONS: Record<string, string> = {
  doc:       '●',
  flow:      '◆',
  flow_step: '▲',
  task:      '■',
  concept:   '✦',
  decision:  '▼',
  project:   '○',
  rationale: '⬟',
  session:   '⬤',
};

export function createNodeGeometry(entityType: string, radius: number): THREE.BufferGeometry {
  // Every node is a sphere. Neurons are spheres.
  // Differentiation comes from color, size, and glow — not geometry.
  const segments = radius > 14 ? 20 : 14;
  return new THREE.SphereGeometry(radius, segments, segments);
}

export function getNodeRadius(degree: number, isGodNode: boolean, entityType: string): number {
  // Base size varies by entity type — this IS the shape differentiation
  const baseByType: Record<string, number> = {
    doc:       7,
    concept:   5,
    decision:  9,
    flow:      8,
    flow_step: 4,
    task:      6,
    project:   11,
    rationale: 4,
    session:   3,
  };
  const base = baseByType[entityType] ?? 6;
  const degreeBonus = Math.min(degree * 0.35, 8);
  const godBonus = isGodNode ? 10 : 0;
  return base + degreeBonus + godBonus;
}

export const EDGE_LABELS: Record<string, string> = {
  references:              'references',
  implements:              'implements',
  depends_on:              'depends on',
  informs:                 'informed',
  contradicts:             'contradicts',
  supersedes:              'replaces',
  semantically_similar_to: 'similar to',
  part_of:                 'part of',
  preceded_by:             'leads to',
  belongs_to:              'belongs to',
  claims:                  'worked on',
  completes:               'completed',
  rationale_for:           'explains why',
};
