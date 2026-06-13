import * as THREE from 'three';

export function setupBlackEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
): void {
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  scene.background = null;
  scene.fog = new THREE.FogExp2(0x000000, 0.0006);

  // Hard rule: No AmbientLight, no DirectionalLight, no HemisphereLight.
  // Nodes are emissive — they light themselves. Library adds its own lights;
  // remove them so emissive colors are not washed out by diffuse shading.
  const lights = scene.children.filter(c => c instanceof THREE.Light);
  lights.forEach(l => scene.remove(l));
}

export function createStarField(): THREE.Points {
  const count = 2500;
  const positions = new Float32Array(count * 3);

  for (let i = 0; i < count; i++) {
    const phi = Math.acos(2 * Math.random() - 1);
    const theta = 2 * Math.PI * Math.random();
    const r = 1800 + Math.random() * 800;

    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.0,
    transparent: true,
    opacity: 0.35,
    sizeAttenuation: true,
    depthWrite: false,
  });

  const stars = new THREE.Points(geometry, material);
  stars.userData.isStarField = true;
  return stars;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function addBloomAtmosphere(composer: any): Promise<void> {
  try {
    const { UnrealBloomPass } = await import('three/examples/jsm/postprocessing/UnrealBloomPass.js');
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.4,   // strength: low — sprites provide primary glow, bloom is ambiance only
      0.6,   // radius
      0.85,  // threshold: only the very brightest emissive pixels bloom
    );
    composer.addPass(bloomPass);
  } catch {
    // Non-fatal — sprites provide primary glow regardless
  }
}
