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
  const count = 2500;
  const positions = new Float32Array(count * 3);

  // Real brain MRI proportions (175mm AP × 145mm LR × 120mm SI), normalised to AP=1
  const LR = 0.83;   // left-right axis
  const SI = 0.69;   // superior-inferior (vertical)
  const AP = 1.0;    // anterior-posterior (depth) — longest axis

  const goldenAngle = Math.PI * (1 + Math.sqrt(5));

  for (let i = 0; i < count; i++) {
    const t = i / count;
    const inclination = Math.acos(1 - 2 * t);
    const azimuth = goldenAngle * i;

    // Base ellipsoid at MRI proportions: x=LR, y=SI, z=AP
    let x = LR * Math.sin(inclination) * Math.cos(azimuth);
    let y = SI * Math.cos(inclination);
    let z = AP * Math.sin(inclination) * Math.sin(azimuth);

    // Interhemispheric fissure — longitudinal groove at x≈0, top of brain only
    if (y > 0) {
      const fissureDepth = 0.10 * Math.exp(-Math.pow(x / 0.07, 2)) * (y / SI);
      y -= fissureDepth;
    }

    // Frontal pole (z < -0.65): narrows toward the forehead
    if (z < -0.65) {
      const f = (-z - 0.65) / 0.35;
      x *= (1 - 0.25 * f);
      y *= (1 - 0.15 * f);
    }

    // Occipital pole (z > 0.65): more pointed at the back
    if (z > 0.65) {
      const f = (z - 0.65) / 0.35;
      x *= (1 - 0.35 * f);
      y *= (1 - 0.20 * f);
    }

    // Parietal expansion — brain is widest at mid-depth
    if (z > -0.2 && z < 0.4 && Math.abs(x) > 0.5) {
      x *= 1.06;
    }

    // Temporal lobe bulge — lateral+downward at mid-height, mid-depth
    if (y < 0 && y > -0.45 && Math.abs(x) > 0.55 && z > -0.4 && z < 0.3) {
      x *= 1.12;
      y -= 0.08;
    }

    positions[i * 3]     = x * graphRadius;
    positions[i * 3 + 1] = y * graphRadius;
    positions[i * 3 + 2] = z * graphRadius;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    color: 0x7b9ec4,
    size: 1.6,
    transparent: true,
    opacity: 0.30,
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
