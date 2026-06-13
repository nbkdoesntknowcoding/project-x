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
  switch (entityType) {
    case 'doc':        return new THREE.SphereGeometry(radius, 16, 16);
    case 'flow':       return new THREE.OctahedronGeometry(radius);
    case 'flow_step':  return new THREE.TetrahedronGeometry(radius);
    case 'task':       return new THREE.BoxGeometry(radius * 1.6, radius * 1.6, radius * 1.6);
    case 'concept':    return new THREE.IcosahedronGeometry(radius);
    case 'decision':   return new THREE.ConeGeometry(radius * 0.8, radius * 1.8, 6);
    case 'project':    return new THREE.TorusGeometry(radius * 1.2, radius * 0.3, 8, 16);
    case 'rationale':  return new THREE.DodecahedronGeometry(radius);
    case 'session':    return new THREE.CylinderGeometry(radius * 0.5, radius * 0.5, radius * 1.5, 10);
    default:           return new THREE.SphereGeometry(radius, 12, 12);
  }
}

export function getNodeRadius(degree: number, isGodNode: boolean): number {
  const base = 3;
  const degreeBonus = Math.min(degree * 0.3, 8);
  const godBonus = isGodNode ? 6 : 0;
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
