import * as THREE from 'three';

export function setupBlackEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
  renderer.setClearColor(0x000000, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // react-force-graph's renderer defaults to ACESFilmic tone mapping, which
  // desaturates/shifts colours so nodes render differently from the flat hex
  // swatches in the legend. Disable it so node colours match the legend exactly.
  renderer.toneMapping = THREE.NoToneMapping;
  scene.background = null;
  scene.fog        = null;
}

export function createStarField(): THREE.Points {
  const n = 2000;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const phi   = Math.acos(2 * Math.random() - 1);
    const theta = 2 * Math.PI * Math.random();
    const r     = 1500 + Math.random() * 1000;
    pos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
    pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
    pos[i*3+2] = r * Math.cos(phi);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const obj = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xffffff, size: 1.0, transparent: true,
    opacity: 0.3, sizeAttenuation: true, depthWrite: false,
  }));
  obj.userData.isStarField = true;
  // Never interactive — exclude from pointer raycasting so it can't absorb node clicks.
  obj.raycast = () => {};
  return obj;
}

// Human brain boundary. Called ONLY in onEngineStop with actual graph radius.
// Shell at graphRadius × 1.5. Brain proportions from MRI: AP(z)=1.0, LR(x)=0.83, SI(y)=0.69.
export function createBrainBoundaryShell(graphRadius: number): THREE.Points {
  const r = graphRadius;
  const n = 2000;
  const pos = new Float32Array(n * 3);
  const golden = Math.PI * (1 + Math.sqrt(5));

  for (let i = 0; i < n; i++) {
    const t    = i / n;
    const incl = Math.acos(1 - 2 * t);
    const azim = golden * i;
    let x = 0.83 * Math.sin(incl) * Math.cos(azim);
    let y = 0.69 * Math.cos(incl);
    let z = 1.00 * Math.sin(incl) * Math.sin(azim);

    // Interhemispheric fissure
    if (y > 0) y -= 0.10 * Math.exp(-Math.pow(x / 0.07, 2)) * (y / 0.69);
    // Frontal pole
    if (z < -0.65) { const f = (-z-0.65)/0.35; x *= (1-0.25*f); y *= (1-0.15*f); }
    // Occipital pole
    if (z > 0.65)  { const f = (z-0.65)/0.35;  x *= (1-0.35*f); y *= (1-0.20*f); }
    // Temporal lobe
    if (y < 0 && y > -0.45 && Math.abs(x) > 0.55 && z > -0.4 && z < 0.3) { x *= 1.12; y -= 0.08; }

    pos[i*3] = x*r; pos[i*3+1] = y*r; pos[i*3+2] = z*r;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const obj = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0x7b9ec4, size: 1.8, transparent: true,
    opacity: 0.30, sizeAttenuation: true,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  obj.userData.isBrainShell = true;
  // Never interactive — exclude from pointer raycasting so it can't absorb node clicks.
  obj.raycast = () => {};
  return obj;
}
