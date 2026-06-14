import * as THREE from 'three';

let selId = ''; let connSet = new Set<string>();

export function setHighlight(id: string, connected: string[], groups: Map<string, THREE.Group>): void {
  selId = id; connSet = new Set(connected); apply(groups);
}

export function clearHighlight(groups: Map<string, THREE.Group>): void {
  selId = ''; connSet = new Set(); apply(groups);
}

function apply(groups: Map<string, THREE.Group>): void {
  groups.forEach((g, id) => {
    const { mat, baseEmissive, glow } = g.userData;
    if (!mat) return;
    if (!selId) {
      mat.opacity = 1.0; mat.emissiveIntensity = baseEmissive;
      if (glow) glow.material.opacity = 1.0; g.scale.setScalar(1.0);
    } else if (id === selId) {
      mat.opacity = 1.0; mat.emissiveIntensity = baseEmissive * 2.5;
      if (glow) glow.material.opacity = 1.3; g.scale.setScalar(1.2);
    } else if (connSet.has(id)) {
      mat.opacity = 1.0; mat.emissiveIntensity = baseEmissive * 1.5;
      if (glow) glow.material.opacity = 1.0; g.scale.setScalar(1.0);
    } else {
      mat.opacity = 0.06; mat.emissiveIntensity = 0;
      if (glow) glow.material.opacity = 0.03; g.scale.setScalar(1.0);
    }
  });
}
