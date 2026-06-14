import * as THREE from 'three';

export function setupBlackEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
): void {
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  scene.background = null;
  scene.fog = null;

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

export function createBrainBoundaryShell(graphRadius: number): THREE.Points {
  const r = graphRadius;
  const count = 2000;
  const positions = new Float32Array(count * 3);

  const goldenAngle = Math.PI * (1 + Math.sqrt(5));

  for (let i = 0; i < count; i++) {
    const t = i / count;
    const inclination = Math.acos(1 - 2 * t);
    const azimuth = goldenAngle * i;

    // Brain proportions: wider (x) than tall (y), slightly deeper (z)
    positions[i * 3]     = r * 1.25 * Math.sin(inclination) * Math.cos(azimuth);
    positions[i * 3 + 1] = r * 0.75 * Math.cos(inclination);
    positions[i * 3 + 2] = r * 1.05 * Math.sin(inclination) * Math.sin(azimuth);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0x6b7fa3,
    size: 1.8,
    transparent: true,
    opacity: 0.35,
    sizeAttenuation: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const shell = new THREE.Points(geometry, material);
  shell.userData.isBrainShell = true;
  return shell;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function addBloomAtmosphere(composer: any): Promise<void> {
  try {
    const { UnrealBloomPass } = await import('three/examples/jsm/postprocessing/UnrealBloomPass.js');
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.15,  // strength — very subtle atmosphere only
      0.5,   // radius
      0.92,  // threshold — only the very brightest core pixels bloom
    );
    composer.addPass(bloomPass);
  } catch {
    // Non-fatal — sprites provide primary glow regardless
  }
}
