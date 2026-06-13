import * as THREE from 'three';

interface HighlightState {
  selectedNodeId: string | null;
  connectedNodeIds: Set<string>;
}

let state: HighlightState = { selectedNodeId: null, connectedNodeIds: new Set() };

export function setHighlight(
  nodeId: string | null,
  connectedIds: string[],
  allGroups: Map<string, THREE.Group>,
) {
  state = {
    selectedNodeId: nodeId,
    connectedNodeIds: new Set(connectedIds),
  };
  applyHighlight(allGroups);
}

export function clearHighlight(allGroups: Map<string, THREE.Group>) {
  state = { selectedNodeId: null, connectedNodeIds: new Set() };
  applyHighlight(allGroups);
}

function applyHighlight(allGroups: Map<string, THREE.Group>) {
  allGroups.forEach((group, nodeId) => {
    const { baseMaterial, baseEmissiveIntensity, glowSprite } = group.userData as {
      baseMaterial: THREE.MeshStandardMaterial | undefined;
      baseEmissiveIntensity: number;
      glowSprite: THREE.Sprite | undefined;
    };
    if (!baseMaterial) return;

    if (state.selectedNodeId === null) {
      baseMaterial.opacity = 1.0;
      baseMaterial.emissiveIntensity = baseEmissiveIntensity;
      if (glowSprite) glowSprite.material.opacity = 1.0;
      return;
    }

    if (nodeId === state.selectedNodeId) {
      baseMaterial.opacity = 1.0;
      baseMaterial.emissiveIntensity = baseEmissiveIntensity * 3.0;
      if (glowSprite) glowSprite.material.opacity = 1.5;
      group.scale.setScalar(1.3);

    } else if (state.connectedNodeIds.has(nodeId)) {
      baseMaterial.opacity = 1.0;
      baseMaterial.emissiveIntensity = baseEmissiveIntensity * 1.8;
      if (glowSprite) glowSprite.material.opacity = 1.0;
      group.scale.setScalar(1.0);

    } else {
      baseMaterial.opacity = 0.08;
      baseMaterial.emissiveIntensity = 0;
      if (glowSprite) glowSprite.material.opacity = 0.04;
      group.scale.setScalar(1.0);
    }
  });
}
