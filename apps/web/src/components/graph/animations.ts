import * as THREE from 'three';

interface PendingAnimation {
  groupId: string;
  startTime: number;
  duration: number;
  type: 'materialize' | 'pulse';
}

const pendingAnimations: PendingAnimation[] = [];

export function triggerNodeMaterialize(
  nodeId: string,
  group: THREE.Group,
  connectedGroups: THREE.Group[],
): void {
  group.scale.setScalar(0);
  if (group.userData.baseMaterial) {
    group.userData.baseMaterial.opacity = 0;
  }

  pendingAnimations.push({
    groupId: nodeId,
    startTime: performance.now(),
    duration: 1200,
    type: 'materialize',
  });

  connectedGroups.forEach(cGroup => {
    pendingAnimations.push({
      groupId: cGroup.userData.nodeId as string,
      startTime: performance.now() + 800,
      duration: 600,
      type: 'pulse',
    });
  });
}

export function processAnimations(
  now: number,
  groupMap: Map<string, THREE.Group>,
): void {
  for (let i = pendingAnimations.length - 1; i >= 0; i--) {
    const anim = pendingAnimations[i]!;
    const elapsed = now - anim.startTime;

    if (elapsed < 0) continue;

    const progress = Math.min(elapsed / anim.duration, 1);
    const eased = easeOutBack(progress);

    const group = groupMap.get(anim.groupId);
    if (!group) { pendingAnimations.splice(i, 1); continue; }

    if (anim.type === 'materialize') {
      group.scale.setScalar(eased);
      if (group.userData.baseMaterial) {
        group.userData.baseMaterial.opacity = progress;
      }
      if (group.userData.glowSprite) {
        group.userData.glowSprite.material.opacity = eased;
      }
    }

    if (anim.type === 'pulse') {
      const spike = Math.sin(progress * Math.PI);
      const { baseMaterial, baseEmissiveIntensity } = group.userData as {
        baseMaterial: THREE.MeshStandardMaterial | undefined;
        baseEmissiveIntensity: number;
      };
      if (baseMaterial) {
        baseMaterial.emissiveIntensity = baseEmissiveIntensity + spike * 2.5;
      }
    }

    if (progress >= 1) {
      pendingAnimations.splice(i, 1);
      if (anim.type === 'materialize') group.scale.setScalar(1);
      if (anim.type === 'pulse') {
        const { baseMaterial, baseEmissiveIntensity } = group.userData as {
          baseMaterial: THREE.MeshStandardMaterial | undefined;
          baseEmissiveIntensity: number;
        };
        if (baseMaterial) baseMaterial.emissiveIntensity = baseEmissiveIntensity;
      }
    }
  }
}

function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
