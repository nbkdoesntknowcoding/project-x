import * as THREE from 'three';
import { getNodeRadius, ENTITY_COLORS_HEX } from './constants';
import { createGlowSprite } from './glow-sprites';
import type { GraphNode } from '../../lib/graph-types';

const cache = new Map<string, THREE.Group>();

export function createNodeObject(node: GraphNode): THREE.Group {
  const hit = cache.get(node.id);
  if (hit) return hit;
  const group  = new THREE.Group();
  const isGod  = node.isGodNode ?? false;
  const radius = getNodeRadius(node.degree ?? 0, isGod, node.entityType);
  const hex    = ENTITY_COLORS_HEX[node.entityType] ?? 0x888888;
  const geo    = new THREE.SphereGeometry(radius, 14, 14);
  const mat    = new THREE.MeshStandardMaterial({
    color: hex, emissive: hex,
    emissiveIntensity: isGod ? 1.0 : 0.45,
    roughness: 0.4, metalness: 0.1, transparent: true, opacity: 1.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  group.add(mesh);
  const glow = createGlowSprite(hex, radius, isGod);
  group.add(glow);
  group.userData = { nodeId: node.id, isGod, mat, baseEmissive: isGod ? 1.0 : 0.45, glow, mesh };
  cache.set(node.id, group);
  return group;
}

export function animateNode(group: THREE.Group, dt: number, t: number): void {
  const { isGod, mesh, glow } = group.userData;
  if (!mesh) return;
  if (isGod) {
    mesh.rotation.y += dt * 0.25;
    mesh.rotation.x += dt * 0.12;
    if (glow) {
      const base = group.userData.glowBase ?? glow.scale.x;
      group.userData.glowBase = base;
      glow.scale.setScalar(base * (1 + Math.sin(t * 0.7) * 0.10));
    }
  }
}

export function clearNodeCache(): void { cache.clear(); }
