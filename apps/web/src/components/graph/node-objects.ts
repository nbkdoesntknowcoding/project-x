import * as THREE from 'three';
import { createNodeGeometry, getNodeRadius, ENTITY_COLORS_HEX } from './constants';
import { createGlowSprite, createGodNodeOuterHalo } from './glow-sprites';
import type { GraphNode } from '../../lib/graph-types';

const nodeGroupCache = new Map<string, THREE.Group>();

export function createNodeObject(node: GraphNode): THREE.Group {
  if (nodeGroupCache.has(node.id)) return nodeGroupCache.get(node.id)!;

  const group = new THREE.Group();
  const isGodNode = node.isGodNode ?? false;
  const radius = getNodeRadius(node.degree ?? 0, isGodNode);
  const colorHex = ENTITY_COLORS_HEX[node.entityType] ?? 0x888888;

  const geometry = createNodeGeometry(node.entityType, radius);
  const material = new THREE.MeshStandardMaterial({
    color: colorHex,
    emissive: colorHex,
    emissiveIntensity: isGodNode ? 2.5 : 1.0,
    roughness: 0.3,
    metalness: 0.2,
    transparent: true,
    opacity: 1.0,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.isMesh = true;
  group.add(mesh);

  const glowSprite = createGlowSprite(colorHex, radius, isGodNode);
  group.add(glowSprite);

  if (isGodNode) {
    const outerHalo = createGodNodeOuterHalo(colorHex, radius);
    group.add(outerHalo);
    mesh.userData.rotates = true;
  }

  group.userData = {
    nodeId: node.id,
    entityType: node.entityType,
    isGodNode,
    baseMaterial: material,
    baseEmissiveIntensity: isGodNode ? 2.5 : 1.0,
    baseOpacity: 1.0,
    mesh,
    glowSprite,
  };

  nodeGroupCache.set(node.id, group);
  return group;
}

export function clearNodeCache(): void {
  nodeGroupCache.clear();
}

export function animateNodeObject(group: THREE.Group, deltaTime: number, time: number) {
  const { isGodNode, mesh, glowSprite } = group.userData as {
    isGodNode: boolean;
    mesh: THREE.Mesh | undefined;
    glowSprite: THREE.Sprite | undefined;
  };
  if (!mesh) return;

  if (isGodNode && mesh.userData.rotates) {
    mesh.rotation.y += deltaTime * 0.3;
    mesh.rotation.x += deltaTime * 0.15;
  }

  if (isGodNode && glowSprite) {
    const pulse = 1 + Math.sin(time * 0.8) * 0.15;
    const baseScale = (group.userData.baseGlowScale as number | undefined) ?? glowSprite.scale.x;
    group.userData.baseGlowScale = baseScale;
    glowSprite.scale.setScalar(baseScale * pulse);
  }
}
