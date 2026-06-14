import * as THREE from 'three';

const cache = new Map<number, THREE.CanvasTexture>();

function build(hex: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const r = (hex >> 16) & 255;
  const g = (hex >> 8)  & 255;
  const b =  hex        & 255;
  const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0,    `rgba(${r},${g},${b},1.0)`);
  grd.addColorStop(0.12, `rgba(${r},${g},${b},0.6)`);
  grd.addColorStop(0.35, `rgba(${r},${g},${b},0.08)`);
  grd.addColorStop(1,    `rgba(${r},${g},${b},0.0)`);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  cache.set(hex, tex);
  return tex;
}

export function getGlowTexture(hex: number): THREE.CanvasTexture {
  return cache.get(hex) ?? build(hex);
}

// CRITICAL: scale = radius × 2 regular, radius × 3 god-node. NOTHING LARGER.
export function createGlowSprite(hex: number, radius: number, isGodNode: boolean): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: getGlowTexture(hex),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(radius * (isGodNode ? 3 : 2));
  return sprite;
}
