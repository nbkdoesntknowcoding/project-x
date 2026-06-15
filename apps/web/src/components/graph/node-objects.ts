import * as THREE from 'three';
import { ENTITY_COLORS_HEX } from './constants';
import type { GraphNode } from '../../lib/graph-types';

const cache = new Map<string, THREE.Group>();

export function createNodeObject(node: GraphNode): THREE.Group {
  const hit = cache.get(node.id);
  if (hit) return hit;

  const group  = new THREE.Group();
  const isGod  = node.isGodNode ?? false;
  const degree = node.degree ?? 0;
  const hex    = ENTITY_COLORS_HEX[node.entityType] ?? 0x888888;

  // Smaller nodes — edges are the visual hero now
  const radius = 2 + Math.min(degree * 0.15, 4) + (isGod ? 4 : 0);
  // Regular leaf: radius 2. High-degree hub: radius ~6. God-node: radius ~10.

  const geo = new THREE.SphereGeometry(radius, 12, 12);
  const mat = new THREE.MeshStandardMaterial({
    color: hex,
    emissive: hex,
    emissiveIntensity: isGod ? 2.0 : 1.0,
    roughness: 0.2,
    metalness: 0.1,
    transparent: true,
    opacity: 1.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  group.add(mesh);

  // Invisible, larger click hitbox. The visible sphere is only 2–10px so it's
  // nearly impossible to click at fit-to-view zoom; this transparent sphere
  // (opacity 0 but visible:true → still raycastable) gives a generous target.
  // A raycast hit climbs to this Group's __graphObjType, so it resolves to the node.
  const hitR = Math.max(radius * 2.5, 9);
  const hitbox = new THREE.Mesh(
    new THREE.SphereGeometry(hitR, 8, 8),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  hitbox.userData.isHitbox = true;
  group.add(hitbox);

  // NO glow sprite — removed. Edges carry the colour now.

  group.userData = {
    nodeId: node.id,
    isGod,
    mat,
    baseEmissive: isGod ? 2.0 : 1.0,
    mesh,
    glow: null, // null so highlight.ts doesn't crash
  };

  cache.set(node.id, group);
  return group;
}

// All automated motion removed per product direction — the scene is static
// unless the user moves the mouse (pan / zoom / orbit). Kept as a no-op so the
// render-loop call signature and any callers remain intact.
export function animateNode(_group: THREE.Group, _dt: number, _t: number): void {
  // intentionally empty — no ambient/automated motion
}

export function clearNodeCache(): void { cache.clear(); }
